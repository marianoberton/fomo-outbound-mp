/**
 * Smoke test E2E contra HubSpot real (sandbox).
 *
 * Crea/recicla un contact + deal smoke con estado controlado, dispara cadenciaWorkflow
 * programáticamente, y verifica que las propiedades + nota se hayan persistido bien.
 *
 * Por default: STUB_SEND=true (no manda WhatsApp/email reales), pero HubSpot es real.
 * Para enviar de verdad: `SMOKE_REAL_SEND=true npm run smoke`.
 *
 * Uso:
 *   SMOKE_CONTACT_EMAIL=tu-email@ejemplo.com SMOKE_CONTACT_PHONE=+5491100000099 npm run smoke
 */

// IMPORTANTE: setear env vars ANTES de importar el módulo de Mastra
// porque CONFIG/STUB_MODE leen process.env al importarse.
process.env.STUB_MODE = 'false';
process.env.APPROVAL_MODE = 'off';
if (process.env.SMOKE_REAL_SEND !== 'true') {
  process.env.STUB_SEND = 'true';
}

import { Client } from '@hubspot/api-client';

const SMOKE_DEALNAME = '[SMOKE] Cajas — E2E test';

type Status = 'OK' | 'FAIL' | 'WARN';
const results: Array<{ name: string; status: Status; detail: string }> = [];
const push = (name: string, status: Status, detail = '') => results.push({ name, status, detail });

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function findOrCreateContact(
  client: Client,
  email: string,
  phone: string,
): Promise<string> {
  try {
    const res = await client.crm.contacts.searchApi.doSearch({
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
      properties: ['email'],
      limit: 1,
    } as never);
    if (res.results.length > 0) return res.results[0].id;
  } catch {
    // continuar
  }
  const created = await client.crm.contacts.basicApi.create({
    properties: { firstname: 'Smoke', lastname: 'Test', company: 'Smoke E2E SA', email, phone },
  } as never);
  return created.id;
}

async function findExistingSmokeDeal(client: Client, contactId: string): Promise<string | null> {
  try {
    const res = await client.crm.deals.searchApi.doSearch({
      filterGroups: [
        {
          filters: [
            { propertyName: 'dealname', operator: 'EQ', value: SMOKE_DEALNAME },
            { propertyName: 'associations.contact', operator: 'EQ', value: contactId },
          ],
        },
      ],
      properties: ['dealname'],
      limit: 1,
    } as never);
    return res.results[0]?.id ?? null;
  } catch {
    return null;
  }
}

async function ensureSmokeDeal(
  client: Client,
  contactId: string,
  pipelineId: string,
  stageId: string,
): Promise<string> {
  const existing = await findExistingSmokeDeal(client, contactId);
  // Forzamos al deal a un estado "fresh ready": intento 0, semáforo verde, canal email,
  // proximo_intento_fecha=hoy. Idempotente: si ya existe, actualizamos las props.
  const properties: Record<string, string> = {
    dealname: SMOKE_DEALNAME,
    amount: '1500000',
    pipeline: pipelineId,
    dealstage: stageId,
    reactivacion_estado: 'eligible',
    intento_n: '0',
    canal_original: 'email',
    semaforo_cotizacion: 'verde',
    monto_cotizado_ars: '1500000',
    pdf_presupuesto_url: 'https://example.com/smoke.pdf',
    proximo_intento_fecha: todayIso(),
    ultimo_intento_fecha: '',
    ultimo_intento_canal: '',
  };
  if (existing) {
    await client.crm.deals.basicApi.update(existing, { properties });
    return existing;
  }
  const created = await client.crm.deals.basicApi.create({
    properties,
    associations: [
      {
        to: { id: contactId },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }],
      },
    ],
  } as never);
  return created.id;
}

async function reloadDeal(
  client: Client,
  dealId: string,
): Promise<Record<string, string | null | undefined>> {
  const d = await client.crm.deals.basicApi.getById(dealId, [
    'reactivacion_estado',
    'intento_n',
    'ultimo_intento_fecha',
    'ultimo_intento_canal',
    'proximo_intento_fecha',
  ]);
  return d.properties as Record<string, string | null | undefined>;
}

async function findRecentNoteOnDeal(client: Client, dealId: string): Promise<string | null> {
  try {
    const assoc = await fetch(
      `https://api.hubapi.com/crm/v4/objects/deals/${dealId}/associations/notes?limit=5`,
      { headers: { Authorization: `Bearer ${process.env.HUBSPOT_PRIVATE_APP_TOKEN}` } },
    );
    if (!assoc.ok) return null;
    const j = (await assoc.json()) as { results?: Array<{ toObjectId?: number }> };
    const noteId = j.results?.[0]?.toObjectId;
    if (!noteId) return null;
    const note = await client.crm.objects.notes.basicApi.getById(String(noteId), [
      'hs_note_body',
    ]);
    return (note.properties?.hs_note_body as string | undefined) ?? null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const email = process.env.SMOKE_CONTACT_EMAIL;
  const phone = process.env.SMOKE_CONTACT_PHONE;
  const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  const pipelineId = process.env.HUBSPOT_PIPELINE_MAYORISTA_ID;
  const stageId = process.env.HUBSPOT_STAGE_SEGUIMIENTO_ID;

  if (!email || !phone) {
    console.error(
      'Faltan SMOKE_CONTACT_EMAIL y/o SMOKE_CONTACT_PHONE. Usá direcciones que controles.',
    );
    process.exit(1);
  }
  if (!token || !pipelineId || !stageId) {
    console.error('Faltan env vars de HubSpot (token, pipeline, stage). Correr preflight primero.');
    process.exit(1);
  }
  if (process.env.SMOKE_REAL_SEND === 'true') {
    console.warn('⚠ SMOKE_REAL_SEND=true — el smoke MANDARÁ un mensaje real al contacto smoke.');
  } else {
    console.log('· STUB_SEND=true por default — no se envía mensaje real (HubSpot sí es real).');
  }

  const client = new Client({ accessToken: token });

  console.log('\n[1/4] Setup contact + deal smoke');
  const contactId = await findOrCreateContact(client, email, phone);
  console.log(`  contact id: ${contactId}`);
  const dealId = await ensureSmokeDeal(client, contactId, pipelineId, stageId);
  console.log(`  deal id: ${dealId}`);

  console.log('\n[2/4] Trigger cadenciaWorkflow (esto puede tardar — el composer llama LLM real)');
  // Import dinámico DESPUÉS de setear env vars.
  const { mastra } = await import('../mastra/index.js');
  const wf = mastra.getWorkflow('cadenciaWorkflow');
  if (!wf) {
    console.error('cadenciaWorkflow no registrado.');
    process.exit(2);
  }
  const run = await wf.createRun();
  const t0 = Date.now();
  const result = await run.start({ inputData: {} });
  console.log(`  workflow status: ${result.status} (${Date.now() - t0}ms)`);

  console.log('\n[3/4] Verificar HubSpot state');
  const props = await reloadDeal(client, dealId);

  const expected = {
    reactivacion_estado: 'sent_attempt_1',
    intento_n: '1',
    ultimo_intento_fecha: todayIso(),
    ultimo_intento_canal: 'email',
    proximo_intento_fecha: addDaysIso(4),
  };

  for (const [key, want] of Object.entries(expected)) {
    const got = props[key] ?? '';
    if (String(got).startsWith(want)) {
      push(`deal.${key}`, 'OK', `${got}`);
    } else {
      push(`deal.${key}`, 'FAIL', `got "${got}", esperaba "${want}"`);
    }
  }

  const noteBody = await findRecentNoteOnDeal(client, dealId);
  if (noteBody && noteBody.includes('[AGENTE]') && noteBody.includes('Intento 1')) {
    push('deal.auditNote', 'OK', `${noteBody.slice(0, 80)}…`);
  } else {
    push('deal.auditNote', 'FAIL', 'no se encontró nota de auditoría con título esperado');
  }

  console.log('\n[4/4] Resultado');
  const symbols: Record<Status, string> = { OK: '✓', FAIL: '✗', WARN: '!' };
  let hasFail = false;
  for (const r of results) {
    console.log(`  ${symbols[r.status]} ${r.status.padEnd(4)} ${r.name.padEnd(34)} ${r.detail}`);
    if (r.status === 'FAIL') hasFail = true;
  }
  console.log('');
  if (hasFail) {
    console.error('Smoke FAIL — revisar logs arriba y el deal en HubSpot.');
    process.exit(1);
  }
  console.log('Smoke OK ✓ — el flujo end-to-end persistió todo lo esperado.');
  process.exit(0);
}

main().catch((err) => {
  console.error('smoke crash:', err);
  process.exit(2);
});
