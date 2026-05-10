/**
 * Webhooks de respuestas inbound (Workflow B) — Fase 2.
 *
 * - GET  /webhooks/whatsapp        → handshake de verify (Meta)
 * - POST /webhooks/whatsapp        → mensaje inbound de cliente, dispara respuestaWorkflow
 * - POST /webhooks/hubspot-email   → email inbound vía suscripción HubSpot, dispara respuestaWorkflow
 *
 * Verificación de firmas: src/lib/webhook-verify.ts.
 * Lookup phone/email → dealId/contactId: src/lib/inbound-lookup.ts.
 *
 * Meta espera 200 rápido para no reintentar — disparamos el workflow async y respondemos al toque.
 *
 * Refs: MP.md §3, §7.
 */
import { registerApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';
import {
  findActiveDealByEmail,
  findActiveDealByPhone,
  setLastInboundAt,
} from '../../lib/inbound-lookup.js';
import {
  verifyHubspotSignature,
  verifyMetaSignature,
} from '../../lib/webhook-verify.js';
import {
  extractInboundMessages,
  extractTextFromMessage,
  type MetaWebhookPayload,
} from '../../lib/webhook-parsing.js';

const META_APP_SECRET = process.env.META_APP_SECRET ?? '';
const META_VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN ?? '';
const HUBSPOT_APP_SECRET = process.env.HUBSPOT_APP_SECRET ?? '';
const RESPUESTA_WORKFLOW_ID = 'respuesta-clasificacion';

type Logger = { info: (m: string, a?: unknown) => void; warn: (m: string, a?: unknown) => void; error: (m: string, a?: unknown) => void };
type MastraInstance = {
  getLogger: () => Logger;
  getWorkflow: (id: string) => {
    createRun: () => Promise<{ start: (a: { inputData: unknown }) => Promise<unknown> }>;
  };
};

function getMastra(c: Context): MastraInstance {
  return c.get('mastra') as MastraInstance;
}

/** Lanza el workflow B en background. No bloquea la respuesta del webhook. */
function triggerRespuestaWorkflow(
  mastra: MastraInstance,
  inputData: {
    dealId: string;
    contactId: string;
    channel: 'whatsapp' | 'email';
    body: string;
    receivedAt: string;
  },
): void {
  const wf = mastra.getWorkflow(RESPUESTA_WORKFLOW_ID);
  void (async () => {
    try {
      const run = await wf.createRun();
      await run.start({ inputData });
      mastra.getLogger().info('respuestaWorkflow run completed', {
        dealId: inputData.dealId,
        channel: inputData.channel,
      });
    } catch (err) {
      mastra.getLogger().error('respuestaWorkflow run failed', {
        dealId: inputData.dealId,
        error: (err as Error).message,
      });
    }
  })();
}

// ---------------------------------------------------------------------------
// HubSpot inbound email payload parsing
// ---------------------------------------------------------------------------
//
// Suscripción esperada: `engagement.creation` filtrada por type=EMAIL e direction=INCOMING.
// Payload de HubSpot es un array de eventos. Cada evento trae objectId (engagementId) — para
// extraer el body necesitamos consultar la engagement. Para Fase 2 simplificamos: el evento
// puede traer `propertyValue` o necesitamos llamar al engagement endpoint. Acá hacemos lo
// segundo con el SDK.

type HubSpotEvent = {
  eventId?: number;
  subscriptionType?: string;
  objectId?: number;
  propertyName?: string;
  propertyValue?: string;
  occurredAt?: number;
};

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const webhooksRoutes = [
  // Meta verify handshake
  registerApiRoute('/webhooks/whatsapp', {
    method: 'GET',
    requiresAuth: false,
    handler: async (c) => {
      const mode = c.req.query('hub.mode');
      const token = c.req.query('hub.verify_token');
      const challenge = c.req.query('hub.challenge') ?? '';
      if (mode === 'subscribe' && META_VERIFY_TOKEN && token === META_VERIFY_TOKEN) {
        return c.text(challenge, 200);
      }
      return c.text('verify token mismatch', 403);
    },
  }),

  // Meta WhatsApp inbound
  registerApiRoute('/webhooks/whatsapp', {
    method: 'POST',
    requiresAuth: false,
    handler: async (c) => {
      const mastra = getMastra(c);
      const log = mastra.getLogger();
      const rawBody = await c.req.text();
      const sigHeader = c.req.header('x-hub-signature-256');

      if (META_APP_SECRET) {
        const verify = verifyMetaSignature(rawBody, sigHeader, META_APP_SECRET);
        if (!verify.ok) {
          log.warn('webhook WhatsApp signature inválida', { reason: verify.reason });
          return c.text('signature verification failed', 401);
        }
      } else {
        log.warn('META_APP_SECRET vacío — webhook WhatsApp sin verificación de firma');
      }

      let payload: MetaWebhookPayload;
      try {
        payload = JSON.parse(rawBody) as MetaWebhookPayload;
      } catch {
        return c.text('bad json', 400);
      }

      const messages = extractInboundMessages(payload);
      log.info('webhook WhatsApp recibido', { messages: messages.length });

      // Procesar cada mensaje en background.
      void (async () => {
        for (const msg of messages) {
          const text = extractTextFromMessage(msg);
          if (!text) {
            log.info('mensaje WA ignorado (no-text)', { id: msg.id, type: msg.type });
            continue;
          }
          const phone = msg.from;
          const receivedAt = new Date(Number(msg.timestamp) * 1000).toISOString();
          try {
            const match = await findActiveDealByPhone(phone);
            if (!match) {
              log.info('webhook WA: phone sin deal activo', { phone });
              continue;
            }
            await setLastInboundAt(match.contactId, receivedAt);
            triggerRespuestaWorkflow(mastra, {
              dealId: match.dealId,
              contactId: match.contactId,
              channel: 'whatsapp',
              body: text,
              receivedAt,
            });
          } catch (err) {
            log.error('webhook WA processing error', {
              phone,
              error: (err as Error).message,
            });
          }
        }
      })();

      return c.json({ received: true });
    },
  }),

  // HubSpot inbound email
  registerApiRoute('/webhooks/hubspot-email', {
    method: 'POST',
    requiresAuth: false,
    handler: async (c) => {
      const mastra = getMastra(c);
      const log = mastra.getLogger();
      const rawBody = await c.req.text();
      const sigHeader = c.req.header('x-hubspot-signature-v3');
      const tsHeader = c.req.header('x-hubspot-request-timestamp');
      const fullUri = `${c.req.url}`;

      if (HUBSPOT_APP_SECRET) {
        const verify = verifyHubspotSignature(
          rawBody,
          c.req.method,
          fullUri,
          sigHeader,
          tsHeader,
          HUBSPOT_APP_SECRET,
        );
        if (!verify.ok) {
          log.warn('webhook HubSpot signature inválida', { reason: verify.reason });
          return c.text('signature verification failed', 401);
        }
      } else {
        log.warn('HUBSPOT_APP_SECRET vacío — webhook HubSpot sin verificación de firma');
      }

      let events: HubSpotEvent[];
      try {
        events = JSON.parse(rawBody) as HubSpotEvent[];
      } catch {
        return c.text('bad json', 400);
      }

      log.info('webhook HubSpot recibido', { count: events.length });

      void (async () => {
        for (const ev of events) {
          // Esperamos eventos engagement.creation o subscriptionType variantes.
          // El payload del email no viene en el evento; hay que cargarlo del engagement.
          const engagementId = ev.objectId;
          if (!engagementId) {
            log.info('evento HubSpot sin objectId', { ev });
            continue;
          }
          try {
            const { fromEmail, body } = await loadEngagementEmail(engagementId);
            if (!fromEmail || !body) {
              log.info('engagement sin email/body inbound', { engagementId });
              continue;
            }
            const match = await findActiveDealByEmail(fromEmail);
            if (!match) {
              log.info('webhook email: from sin deal activo', { fromEmail });
              continue;
            }
            const receivedAt = new Date(ev.occurredAt ?? Date.now()).toISOString();
            triggerRespuestaWorkflow(mastra, {
              dealId: match.dealId,
              contactId: match.contactId,
              channel: 'email',
              body,
              receivedAt,
            });
          } catch (err) {
            log.error('webhook HubSpot processing error', {
              engagementId,
              error: (err as Error).message,
            });
          }
        }
      })();

      return c.json({ received: true });
    },
  }),
];

// ---------------------------------------------------------------------------
// HubSpot engagement loader (helper)
// ---------------------------------------------------------------------------

import { getHubSpotClient, withRetry } from '../../lib/hubspot-client.js';
import { STUB_MODE } from '../../config/constants.js';

async function loadEngagementEmail(
  engagementId: number,
): Promise<{ fromEmail: string | null; body: string | null }> {
  if (STUB_MODE) return { fromEmail: null, body: null };
  const client = getHubSpotClient();
  // emails endpoint del CRM v3
  const e = await withRetry(() =>
    client.crm.objects.emails.basicApi.getById(String(engagementId), [
      'hs_email_direction',
      'hs_email_from_email',
      'hs_email_text',
      'hs_email_html',
      'hs_email_subject',
    ]),
  );
  const props = e.properties ?? {};
  if (props.hs_email_direction !== 'INCOMING_EMAIL') {
    return { fromEmail: null, body: null };
  }
  return {
    fromEmail: (props.hs_email_from_email as string | undefined) ?? null,
    body:
      ((props.hs_email_text as string | undefined) ||
        (props.hs_email_html as string | undefined)) ?? null,
  };
}
