/**
 * Tool de email outbound vía HubSpot.
 * Refs: MP.md §9.
 *
 * Estrategia (real mode): HubSpot Single Send Transactional API.
 *   POST /marketing/v3/transactional/single-email/send
 *
 * Requiere que el cliente cree en HubSpot un template transaccional con merge tags
 * `subject_override` y `body_override`, y exporte su ID en HUBSPOT_TRANSACTIONAL_EMAIL_ID.
 * Esto deja el subject/body bajo control del agente (no fijos en el template).
 *
 * En STUB_MODE devuelve un messageId mock con log.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { STUB_SEND } from '../../config/constants.js';
import { getHubSpotClient, withRetry } from '../../lib/hubspot-client.js';
import { withRetry as retryHttp } from '../../lib/retry.js';

const TRANSACTIONAL_EMAIL_ID = process.env.HUBSPOT_TRANSACTIONAL_EMAIL_ID ?? '';

async function fetchContactEmail(contactId: string): Promise<string> {
  const client = getHubSpotClient();
  const contact = await withRetry(() =>
    client.crm.contacts.basicApi.getById(contactId, ['email']),
  );
  const email = contact.properties?.email;
  if (!email) throw new Error(`Contact ${contactId} no tiene email cargado.`);
  return email;
}

export const sendEmailViaHubspotTool = createTool({
  id: 'sendEmailViaHubspot',
  description:
    'Envía un email transaccional al contact via HubSpot Single Send API. El template (HUBSPOT_TRANSACTIONAL_EMAIL_ID) usa merge tags subject_override y body_override.',
  inputSchema: z.object({
    contactId: z.string(),
    subject: z.string(),
    htmlBody: z.string(),
  }),
  outputSchema: z.object({ messageId: z.string() }),
  execute: async (input, ctx) => {
    const log = ctx?.mastra?.getLogger();

    if (STUB_SEND) {
      log?.info('[stub] sendEmailViaHubspot', {
        contactId: input.contactId,
        subject: input.subject,
        bodyPreview: input.htmlBody.slice(0, 80),
      });
      return { messageId: `stub-email-${Date.now()}` };
    }

    if (!TRANSACTIONAL_EMAIL_ID) {
      throw new Error(
        'HUBSPOT_TRANSACTIONAL_EMAIL_ID no está seteado. Crear template transaccional en HubSpot y exportar ID.',
      );
    }

    const toEmail = await fetchContactEmail(input.contactId);
    const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN!;

    // El SDK no expone esta API en typings estables — usamos REST directo.
    const json = await retryHttp(async () => {
      const res = await fetch('https://api.hubapi.com/marketing/v3/transactional/single-email/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          emailId: Number(TRANSACTIONAL_EMAIL_ID),
          message: { to: toEmail },
          customProperties: [
            { name: 'subject_override', value: input.subject },
            { name: 'body_override', value: input.htmlBody },
          ],
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`HubSpot single-email/send ${res.status}: ${text}`) as Error & {
          status: number;
        };
        err.status = res.status;
        throw err;
      }
      return (await res.json()) as { sendResult: string; eventId?: { id: string } };
    });
    if (json.sendResult !== 'SENT') {
      throw new Error(`HubSpot send result: ${json.sendResult}`);
    }
    const messageId = json.eventId?.id ?? `hs-email-${Date.now()}`;

    log?.info('sendEmailViaHubspot OK', {
      contactId: input.contactId,
      to: toEmail,
      messageId,
    });
    return { messageId };
  },
});

export const emailTools = {
  sendEmailViaHubspotTool,
};
