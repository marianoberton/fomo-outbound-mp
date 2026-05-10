/**
 * Lookup de mensajes inbound → deal+contact en cadencia activa.
 *
 * Usado por los webhooks (Workflow B) para mapear `phone` o `email` a un dealId.
 *
 * Estados considerados "en cadencia activa":
 *   sent_attempt_1, sent_attempt_2, sent_attempt_3, awaiting_response, active_conversation
 *
 * En STUB_MODE devuelve `null` salvo que se pase un override mediante el parámetro
 * `stubResult` (útil para tests del workflow B sin HubSpot real).
 */
import { getHubSpotClient, withRetry } from './hubspot-client.js';
import { STUB_MODE } from '../config/constants.js';

const PIPELINE_ID = process.env.HUBSPOT_PIPELINE_MAYORISTA_ID ?? '';
const STAGE_SEGUIMIENTO_ID = process.env.HUBSPOT_STAGE_SEGUIMIENTO_ID ?? '';

const ACTIVE_STATES = [
  'sent_attempt_1',
  'sent_attempt_2',
  'sent_attempt_3',
  'awaiting_response',
  'active_conversation',
];

export type InboundMatch = {
  dealId: string;
  contactId: string;
  estado: string | null;
  amount: number | null;
};

/**
 * Normaliza un phone E.164: devuelve hasta 3 variantes para matchear distintos formatos
 * que HubSpot pueda tener en `phone`.
 */
function phoneVariants(input: string): string[] {
  const digits = input.replace(/\D+/g, '');
  if (!digits) return [input];
  return Array.from(new Set([`+${digits}`, digits, input]));
}

async function searchContactByPhone(phone: string): Promise<string | null> {
  const client = getHubSpotClient();
  for (const variant of phoneVariants(phone)) {
    const res = await withRetry(() =>
      client.crm.contacts.searchApi.doSearch({
        filterGroups: [{ filters: [{ propertyName: 'phone', operator: 'EQ', value: variant }] }],
        properties: ['phone', 'email'],
        limit: 1,
      } as never),
    );
    if (res.results.length > 0) return res.results[0].id;
  }
  return null;
}

async function searchContactByEmail(email: string): Promise<string | null> {
  const client = getHubSpotClient();
  const res = await withRetry(() =>
    client.crm.contacts.searchApi.doSearch({
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
      properties: ['email', 'phone'],
      limit: 1,
    } as never),
  );
  return res.results[0]?.id ?? null;
}

async function findActiveDealForContact(contactId: string): Promise<InboundMatch | null> {
  if (!PIPELINE_ID || !STAGE_SEGUIMIENTO_ID) {
    throw new Error('Faltan HUBSPOT_PIPELINE_MAYORISTA_ID o HUBSPOT_STAGE_SEGUIMIENTO_ID.');
  }
  const client = getHubSpotClient();
  const res = await withRetry(() =>
    client.crm.deals.searchApi.doSearch({
      filterGroups: [
        {
          filters: [
            { propertyName: 'associations.contact', operator: 'EQ', value: contactId },
            { propertyName: 'pipeline', operator: 'EQ', value: PIPELINE_ID },
            { propertyName: 'dealstage', operator: 'EQ', value: STAGE_SEGUIMIENTO_ID },
            { propertyName: 'reactivacion_estado', operator: 'IN', values: ACTIVE_STATES },
          ],
        },
      ],
      sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
      properties: ['amount', 'reactivacion_estado'],
      limit: 1,
    } as never),
  );
  const hit = res.results[0];
  if (!hit) return null;
  return {
    dealId: hit.id,
    contactId,
    estado: (hit.properties?.reactivacion_estado as string | undefined) ?? null,
    amount: hit.properties?.amount ? Number(hit.properties.amount) : null,
  };
}

export async function findActiveDealByPhone(
  phone: string,
  opts: { stubResult?: InboundMatch | null } = {},
): Promise<InboundMatch | null> {
  if (STUB_MODE) return opts.stubResult ?? null;
  const contactId = await searchContactByPhone(phone);
  if (!contactId) return null;
  return findActiveDealForContact(contactId);
}

export async function findActiveDealByEmail(
  email: string,
  opts: { stubResult?: InboundMatch | null } = {},
): Promise<InboundMatch | null> {
  if (STUB_MODE) return opts.stubResult ?? null;
  const contactId = await searchContactByEmail(email);
  if (!contactId) return null;
  return findActiveDealForContact(contactId);
}

/**
 * Persiste el timestamp del último inbound en el contact (HubSpot prop `wa_last_inbound_at`).
 * Lo consume `sendWhatsAppFreeForm` para chequear la ventana de 24h.
 */
export async function setLastInboundAt(contactId: string, iso: string): Promise<void> {
  if (STUB_MODE) return;
  const client = getHubSpotClient();
  await withRetry(() =>
    client.crm.contacts.basicApi.update(contactId, {
      properties: { wa_last_inbound_at: iso },
    }),
  );
}

export async function getLastInboundAt(contactId: string): Promise<string | null> {
  if (STUB_MODE) return null;
  const client = getHubSpotClient();
  const c = await withRetry(() =>
    client.crm.contacts.basicApi.getById(contactId, ['wa_last_inbound_at']),
  );
  const v = c.properties?.wa_last_inbound_at;
  return typeof v === 'string' && v !== '' ? v : null;
}
