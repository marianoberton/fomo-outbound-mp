/**
 * Tools de HubSpot que el workflow A invoca.
 * En STUB_MODE devuelven mocks con log claro — útil para correr local sin credenciales.
 *
 * Refs: MP.md §9 (lista de tools requeridas) y §4 (propiedades custom).
 *
 * Nota sobre `as never`:
 *   El SDK `@hubspot/api-client` tipa los operadores de search como `FilterOperatorEnum`
 *   y los association types con interfaces estrictas, pero la REST API acepta los strings
 *   ('EQ', 'LTE', 'IN', 'HUBSPOT_DEFINED') tal cual. Mantenemos el formato literal y
 *   casteamos el body — es más legible que importar y mapear cada enum.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getHubSpotClient, withRetry } from '../../lib/hubspot-client.js';
import { STUB_MODE } from '../../config/constants.js';
import {
  ContactSchema,
  DealContextSchema,
  DealSchema,
  type Contact,
  type Deal,
  type DealContext,
} from '../../lib/types.js';

const PIPELINE_ID = process.env.HUBSPOT_PIPELINE_MAYORISTA_ID ?? '';
const STAGE_SEGUIMIENTO_ID = process.env.HUBSPOT_STAGE_SEGUIMIENTO_ID ?? '';
const DEAL_OWNER_ID = process.env.HUBSPOT_DEAL_OWNER_ID ?? '';

const DEAL_PROPERTIES = [
  'amount',
  'dealstage',
  'pipeline',
  'createdate',
  'reactivacion_estado',
  'intento_n',
  'ultimo_intento_fecha',
  'ultimo_intento_canal',
  'proximo_intento_fecha',
  'canal_original',
  'semaforo_cotizacion',
  'monto_cotizado_ars',
  'pdf_presupuesto_url',
  'intentos_fallidos',
] as const;

const CONTACT_PROPERTIES = [
  'firstname',
  'lastname',
  'company',
  'email',
  'phone',
  'cuit',
  'no_contactar',
  'no_contactar_motivo',
] as const;

// ---------- helpers ----------

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseInt0(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function parseNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseBool(v: unknown): boolean {
  return v === true || v === 'true';
}

function nullIfEmpty(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  return String(v);
}

function daysBetween(fromIso: string | null, toIso: string): number | null {
  if (!fromIso) return null;
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.floor((to - from) / (1000 * 60 * 60 * 24));
}

function dealFromHubSpot(
  raw: { id: string; properties: Record<string, unknown> },
  contactId: string | null,
): Deal {
  const props = raw.properties;
  const stageEnteredKey = `hs_v2_date_entered_${STAGE_SEGUIMIENTO_ID}`;
  const stageEnteredAt =
    nullIfEmpty(props[stageEnteredKey]) ?? nullIfEmpty(props.createdate);
  return DealSchema.parse({
    id: raw.id,
    contactId,
    amount: parseNumberOrNull(props.amount),
    reactivacion_estado: nullIfEmpty(props.reactivacion_estado),
    intento_n: parseInt0(props.intento_n),
    ultimo_intento_fecha: nullIfEmpty(props.ultimo_intento_fecha),
    ultimo_intento_canal: nullIfEmpty(props.ultimo_intento_canal),
    proximo_intento_fecha: nullIfEmpty(props.proximo_intento_fecha),
    canal_original: nullIfEmpty(props.canal_original),
    semaforo_cotizacion: nullIfEmpty(props.semaforo_cotizacion),
    monto_cotizado_ars: parseNumberOrNull(props.monto_cotizado_ars),
    pdf_presupuesto_url: nullIfEmpty(props.pdf_presupuesto_url),
    days_in_seguimiento: daysBetween(stageEnteredAt, todayIsoDate()),
    intentos_fallidos: parseInt0(props.intentos_fallidos),
  });
}

function contactFromHubSpot(raw: {
  id: string;
  properties: Record<string, unknown>;
}): Contact {
  const props = raw.properties;
  return ContactSchema.parse({
    id: raw.id,
    firstname: nullIfEmpty(props.firstname),
    lastname: nullIfEmpty(props.lastname),
    company: nullIfEmpty(props.company),
    email: nullIfEmpty(props.email),
    phone: nullIfEmpty(props.phone),
    cuit: nullIfEmpty(props.cuit),
    no_contactar: parseBool(props.no_contactar),
    no_contactar_motivo: nullIfEmpty(props.no_contactar_motivo),
  });
}

// ---------- stubs ----------

function stubDeal(id: string): Deal {
  return DealSchema.parse({
    id,
    contactId: `stub-contact-${id}`,
    amount: 1_500_000,
    reactivacion_estado: 'eligible',
    intento_n: 0,
    ultimo_intento_fecha: null,
    ultimo_intento_canal: null,
    proximo_intento_fecha: todayIsoDate(),
    canal_original: 'email',
    semaforo_cotizacion: 'verde',
    monto_cotizado_ars: 1_500_000,
    pdf_presupuesto_url: 'https://example.com/presupuesto.pdf',
    days_in_seguimiento: 7,
    intentos_fallidos: 0,
  });
}

function stubContact(id: string): Contact {
  return ContactSchema.parse({
    id,
    firstname: 'Cliente',
    lastname: 'Stub',
    company: 'Lab Stub SA',
    email: 'cliente.stub@example.com',
    phone: '+5491100000000',
    cuit: '20-12345678-9',
    no_contactar: false,
    no_contactar_motivo: null,
  });
}

// ---------- tools ----------

export const listEligibleDealsTool = createTool({
  id: 'listEligibleDeals',
  description:
    'Lista deals de pipeline mayorista en stage Seguimiento con proximo_intento_fecha <= hoy, ordenados ascendente, limitados.',
  inputSchema: z.object({
    date: z.string().describe('Fecha tope ISO YYYY-MM-DD. Default: hoy.').optional(),
    limit: z.number().int().positive().max(200).default(30),
  }),
  outputSchema: z.object({ deals: z.array(DealSchema) }),
  execute: async (input, ctx) => {
    const log = ctx?.mastra?.getLogger();
    const tope = input.date ?? todayIsoDate();
    const limit = input.limit ?? 30;

    if (STUB_MODE) {
      log?.info('[stub] listEligibleDeals', { tope, limit });
      return { deals: [stubDeal('stub-1'), stubDeal('stub-2')] };
    }

    if (!PIPELINE_ID || !STAGE_SEGUIMIENTO_ID) {
      throw new Error('Faltan HUBSPOT_PIPELINE_MAYORISTA_ID o HUBSPOT_STAGE_SEGUIMIENTO_ID.');
    }

    const client = getHubSpotClient();
    const search = await withRetry(() =>
      client.crm.deals.searchApi.doSearch({
        filterGroups: [
          {
            filters: [
              { propertyName: 'pipeline', operator: 'EQ', value: PIPELINE_ID },
              { propertyName: 'dealstage', operator: 'EQ', value: STAGE_SEGUIMIENTO_ID },
              { propertyName: 'proximo_intento_fecha', operator: 'LTE', value: tope },
            ],
          },
        ],
        sorts: ['proximo_intento_fecha'],
        properties: [...DEAL_PROPERTIES, `hs_v2_date_entered_${STAGE_SEGUIMIENTO_ID}`],
        limit,
      } as never),
    );

    // Cargar contact id por deal — search no devuelve associations, así que un getById por hit.
    const deals: Deal[] = [];
    for (const result of search.results) {
      const full = await withRetry(() =>
        client.crm.deals.basicApi.getById(
          result.id,
          [...DEAL_PROPERTIES, `hs_v2_date_entered_${STAGE_SEGUIMIENTO_ID}`],
          undefined,
          ['contacts'],
        ),
      );
      const contactId = full.associations?.contacts?.results?.[0]?.id ?? null;
      deals.push(dealFromHubSpot(full, contactId));
    }

    log?.info('listEligibleDeals OK', { count: deals.length, tope });
    return { deals };
  },
});

export const getDealContextTool = createTool({
  id: 'getDealContext',
  description: 'Devuelve deal completo + contact asociado (con flag no_contactar).',
  inputSchema: z.object({ dealId: z.string() }),
  outputSchema: DealContextSchema,
  execute: async (input, ctx): Promise<DealContext> => {
    const log = ctx?.mastra?.getLogger();

    if (STUB_MODE) {
      log?.info('[stub] getDealContext', { dealId: input.dealId });
      return {
        deal: stubDeal(input.dealId),
        contact: stubContact(`stub-contact-${input.dealId}`),
      };
    }

    const client = getHubSpotClient();
    const dealRaw = await withRetry(() =>
      client.crm.deals.basicApi.getById(
        input.dealId,
        [...DEAL_PROPERTIES, `hs_v2_date_entered_${STAGE_SEGUIMIENTO_ID}`],
        undefined,
        ['contacts'],
      ),
    );

    const contactId = dealRaw.associations?.contacts?.results?.[0]?.id ?? null;
    if (!contactId) {
      throw new Error(`Deal ${input.dealId} no tiene contact asociado.`);
    }

    const contactRaw = await withRetry(() =>
      client.crm.contacts.basicApi.getById(contactId, [...CONTACT_PROPERTIES]),
    );

    const deal = dealFromHubSpot(dealRaw, contactId);
    const contact = contactFromHubSpot(contactRaw);
    return { deal, contact };
  },
});

export const updateDealPropertiesTool = createTool({
  id: 'updateDealProperties',
  description: 'Update parcial de propiedades de un deal.',
  inputSchema: z.object({
    dealId: z.string(),
    properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async (input, ctx) => {
    const log = ctx?.mastra?.getLogger();

    if (STUB_MODE) {
      log?.info('[stub] updateDealProperties', { dealId: input.dealId, properties: input.properties });
      return { ok: true };
    }

    const stringProps: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.properties)) {
      stringProps[k] = v === null ? '' : String(v);
    }

    const client = getHubSpotClient();
    await withRetry(() =>
      client.crm.deals.basicApi.update(input.dealId, { properties: stringProps }),
    );
    log?.info('updateDealProperties OK', { dealId: input.dealId, keys: Object.keys(stringProps) });
    return { ok: true };
  },
});

export const addNoteToDealTool = createTool({
  id: 'addNoteToDeal',
  description: 'Crea una nota engagement asociada al deal (visible en timeline). Usar para auditoría humana.',
  inputSchema: z.object({
    dealId: z.string(),
    title: z.string().optional(),
    body: z.string(),
  }),
  outputSchema: z.object({ noteId: z.string() }),
  execute: async (input, ctx) => {
    const log = ctx?.mastra?.getLogger();

    if (STUB_MODE) {
      log?.info('[stub] addNoteToDeal', { dealId: input.dealId, title: input.title });
      return { noteId: `stub-note-${Date.now()}` };
    }

    const client = getHubSpotClient();
    const fullBody = input.title ? `<b>${input.title}</b><br/>${input.body}` : input.body;
    const created = await withRetry(() =>
      client.crm.objects.notes.basicApi.create({
        properties: {
          hs_note_body: fullBody,
          hs_timestamp: String(Date.now()),
        },
        associations: [
          {
            to: { id: input.dealId },
            // 214 = note → deal default association type id
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 }],
          },
        ],
      } as never),
    );
    log?.info('addNoteToDeal OK', { dealId: input.dealId, noteId: created.id });
    return { noteId: created.id };
  },
});

export const createTaskForOwnerTool = createTool({
  id: 'createTaskForOwner',
  description: 'Crea una task asignada al dueño del deal (HUBSPOT_DEAL_OWNER_ID).',
  inputSchema: z.object({
    dealId: z.string(),
    title: z.string(),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH']),
    body: z.string().optional(),
  }),
  outputSchema: z.object({ taskId: z.string() }),
  execute: async (input, ctx) => {
    const log = ctx?.mastra?.getLogger();

    if (STUB_MODE) {
      log?.info('[stub] createTaskForOwner', {
        dealId: input.dealId,
        title: input.title,
        priority: input.priority,
      });
      return { taskId: `stub-task-${Date.now()}` };
    }

    if (!DEAL_OWNER_ID) {
      throw new Error('HUBSPOT_DEAL_OWNER_ID no está seteado.');
    }

    const client = getHubSpotClient();
    const created = await withRetry(() =>
      client.crm.objects.tasks.basicApi.create({
        properties: {
          hs_task_subject: input.title,
          hs_task_body: input.body ?? '',
          hs_task_priority: input.priority,
          hs_task_status: 'NOT_STARTED',
          hs_timestamp: String(Date.now()),
          hubspot_owner_id: DEAL_OWNER_ID,
        },
        associations: [
          {
            to: { id: input.dealId },
            // 216 = task → deal default association type id
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 216 }],
          },
        ],
      } as never),
    );
    log?.info('createTaskForOwner OK', { dealId: input.dealId, taskId: created.id });
    return { taskId: created.id };
  },
});

export const setContactDoNotContactTool = createTool({
  id: 'setContactDoNotContact',
  description: 'Marca un contact como no_contactar (true/false) y opcionalmente registra el motivo.',
  inputSchema: z.object({
    contactId: z.string(),
    value: z.boolean(),
    reason: z.string().optional(),
  }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async (input, ctx) => {
    const log = ctx?.mastra?.getLogger();

    if (STUB_MODE) {
      log?.info('[stub] setContactDoNotContact', input);
      return { ok: true };
    }

    const client = getHubSpotClient();
    const properties: Record<string, string> = {
      no_contactar: input.value ? 'true' : 'false',
    };
    if (input.reason !== undefined) {
      properties.no_contactar_motivo = input.reason;
    }
    await withRetry(() =>
      client.crm.contacts.basicApi.update(input.contactId, { properties }),
    );
    log?.info('setContactDoNotContact OK', { contactId: input.contactId, value: input.value });
    return { ok: true };
  },
});

export const hubspotTools = {
  listEligibleDealsTool,
  getDealContextTool,
  updateDealPropertiesTool,
  addNoteToDealTool,
  createTaskForOwnerTool,
  setContactDoNotContactTool,
};
