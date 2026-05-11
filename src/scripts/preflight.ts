/**
 * Preflight: valida config + conectividad sin mutar nada.
 *
 * Corre todos los checks aunque alguno falle; devuelve exit code 0 si todo OK,
 * 1 si hay al menos un FAIL. WARN no rompe.
 *
 * Uso: `npm run preflight`
 */
import { Client } from '@hubspot/api-client';

type Status = 'OK' | 'FAIL' | 'WARN' | 'SKIP';
type Result = { name: string; status: Status; detail: string };

const results: Result[] = [];
const push = (name: string, status: Status, detail = '') =>
  results.push({ name, status, detail });

// ---------------------------------------------------------------------------
// Env vars
// ---------------------------------------------------------------------------

const REQUIRED_ENV = [
  'OPENAI_API_KEY',
  'HUBSPOT_PRIVATE_APP_TOKEN',
  'HUBSPOT_PIPELINE_MAYORISTA_ID',
  'HUBSPOT_STAGE_SEGUIMIENTO_ID',
  'HUBSPOT_DEAL_OWNER_ID',
  'APPROVAL_QUEUE_TOKEN',
];

const SOFT_ENV = [
  'HUBSPOT_TRANSACTIONAL_EMAIL_ID',
  'META_WHATSAPP_PHONE_ID',
  'META_WHATSAPP_ACCESS_TOKEN',
  'META_APP_SECRET',
  'META_WEBHOOK_VERIFY_TOKEN',
  'HUBSPOT_APP_SECRET',
];

function checkEnvVars(): void {
  for (const key of REQUIRED_ENV) {
    if (process.env[key]) push(`env.${key}`, 'OK', 'set');
    else push(`env.${key}`, 'FAIL', 'missing');
  }
  for (const key of SOFT_ENV) {
    if (process.env[key]) push(`env.${key}`, 'OK', 'set');
    else push(`env.${key}`, 'WARN', 'no seteado (feature relacionada quedará en stub o sin verificar)');
  }
}

// ---------------------------------------------------------------------------
// HubSpot
// ---------------------------------------------------------------------------

const DEAL_PROP_NAMES = [
  'reactivacion_estado',
  'intento_n',
  'ultimo_intento_fecha',
  'ultimo_intento_canal',
  'proximo_intento_fecha',
  'canal_original',
  'semaforo_cotizacion',
  'monto_cotizado_ars',
  'pdf_presupuesto_url',
];

const CONTACT_PROP_NAMES = ['no_contactar', 'no_contactar_motivo', 'wa_last_inbound_at'];

async function checkHubspot(): Promise<void> {
  const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!token) {
    push('hubspot.connectivity', 'SKIP', 'sin token');
    return;
  }
  const client = new Client({ accessToken: token, numberOfApiCallRetries: 0 });

  // Auth + connectivity: list owners (cheap, validates scopes mínimos).
  try {
    await client.crm.owners.ownersApi.getPage(undefined, undefined, 1);
    push('hubspot.connectivity', 'OK', 'token válido');
  } catch (err) {
    push('hubspot.connectivity', 'FAIL', (err as Error).message);
    return;
  }

  // Pipeline + stage existen.
  const pipelineId = process.env.HUBSPOT_PIPELINE_MAYORISTA_ID;
  const stageId = process.env.HUBSPOT_STAGE_SEGUIMIENTO_ID;
  if (pipelineId) {
    try {
      const pipeline = await client.crm.pipelines.pipelinesApi.getById('deals', pipelineId);
      push('hubspot.pipeline', 'OK', `"${pipeline.label}"`);
      if (stageId) {
        const found = pipeline.stages.find((s) => s.id === stageId);
        if (found) push('hubspot.stage', 'OK', `"${found.label}"`);
        else push('hubspot.stage', 'FAIL', `stage ${stageId} no existe en pipeline "${pipeline.label}"`);
      }
    } catch (err) {
      push('hubspot.pipeline', 'FAIL', (err as Error).message);
    }
  }

  // Owner.
  const ownerId = process.env.HUBSPOT_DEAL_OWNER_ID;
  if (ownerId) {
    try {
      const owner = await client.crm.owners.ownersApi.getById(Number(ownerId));
      push('hubspot.owner', 'OK', `${owner.email ?? owner.id}`);
    } catch (err) {
      push('hubspot.owner', 'FAIL', (err as Error).message);
    }
  }

  // Custom properties.
  for (const name of DEAL_PROP_NAMES) {
    try {
      await client.crm.properties.coreApi.getByName('deals', name);
      push(`hubspot.deal.${name}`, 'OK', 'existe');
    } catch {
      push(`hubspot.deal.${name}`, 'FAIL', 'falta — correr `npm run setup:hubspot`');
    }
  }
  for (const name of CONTACT_PROP_NAMES) {
    try {
      await client.crm.properties.coreApi.getByName('contacts', name);
      push(`hubspot.contact.${name}`, 'OK', 'existe');
    } catch {
      push(`hubspot.contact.${name}`, 'FAIL', 'falta — correr `npm run setup:hubspot`');
    }
  }

  // Transactional email template (soft).
  const emailId = process.env.HUBSPOT_TRANSACTIONAL_EMAIL_ID;
  if (emailId) {
    try {
      const res = await fetch(`https://api.hubapi.com/marketing/v3/emails/${emailId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) push('hubspot.transactionalEmail', 'OK', `id ${emailId}`);
      else push('hubspot.transactionalEmail', 'WARN', `${res.status} — verificá que el ID y los scopes`);
    } catch (err) {
      push('hubspot.transactionalEmail', 'WARN', (err as Error).message);
    }
  }
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

async function checkOpenAI(): Promise<void> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    push('openai.key', 'SKIP', 'sin OPENAI_API_KEY');
    return;
  }
  if (!key.startsWith('sk-')) {
    push('openai.key', 'WARN', 'formato inesperado (no empieza con sk-)');
  }

  // Tiny ping: GET /v1/models — más barato que un chat completion y valida la key igual.
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.ok) push('openai.connectivity', 'OK', 'API key válida');
    else {
      const body = await res.text().catch(() => '');
      push('openai.connectivity', 'FAIL', `${res.status}: ${body.slice(0, 120)}`);
    }
  } catch (err) {
    push('openai.connectivity', 'FAIL', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Meta WhatsApp
// ---------------------------------------------------------------------------

async function checkMeta(): Promise<void> {
  const phoneId = process.env.META_WHATSAPP_PHONE_ID;
  const token = process.env.META_WHATSAPP_ACCESS_TOKEN;
  if (!phoneId || !token) {
    push('meta.whatsapp', 'SKIP', 'phone_id o access_token no seteados');
    return;
  }
  try {
    const res = await fetch(
      `https://graph.facebook.com/v20.0/${phoneId}?fields=display_phone_number,verified_name`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (res.ok) {
      const json = (await res.json()) as { display_phone_number?: string; verified_name?: string };
      push('meta.whatsapp', 'OK', `${json.display_phone_number ?? phoneId} (${json.verified_name ?? 'unverified'})`);
    } else {
      const body = await res.text().catch(() => '');
      push('meta.whatsapp', 'FAIL', `${res.status}: ${body.slice(0, 120)}`);
    }
  } catch (err) {
    push('meta.whatsapp', 'FAIL', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function render(): boolean {
  const groups: Record<string, Result[]> = {};
  for (const r of results) {
    const group = r.name.split('.')[0];
    (groups[group] ??= []).push(r);
  }
  let hasFail = false;
  const symbols: Record<Status, string> = { OK: '✓', FAIL: '✗', WARN: '!', SKIP: '·' };
  for (const [group, list] of Object.entries(groups)) {
    console.log(`\n[${group}]`);
    for (const r of list) {
      const sym = symbols[r.status];
      const line = `  ${sym} ${r.status.padEnd(4)} ${r.name.padEnd(38)} ${r.detail}`;
      console.log(line);
      if (r.status === 'FAIL') hasFail = true;
    }
  }
  console.log('');
  const counts = { OK: 0, FAIL: 0, WARN: 0, SKIP: 0 };
  for (const r of results) counts[r.status]++;
  console.log(
    `Resultado: ${counts.OK} OK, ${counts.FAIL} FAIL, ${counts.WARN} WARN, ${counts.SKIP} SKIP`,
  );
  return !hasFail;
}

async function main(): Promise<void> {
  checkEnvVars();
  await Promise.all([checkHubspot(), checkOpenAI(), checkMeta()]);
  const ok = render();
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('preflight crash:', err);
  process.exit(2);
});
