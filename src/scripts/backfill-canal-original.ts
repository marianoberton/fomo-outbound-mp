/**
 * Backfill: setea `canal_original` en deals legacy donde la propiedad nunca se cargó.
 *
 * Usa `inferCanalOriginal()` (MP.md §14 OPEN) sobre el contact asociado:
 *   - solo email           → email
 *   - solo phone           → whatsapp
 *   - email + phone + cuit → email (cliente formal)
 *   - email + phone (sin cuit) → whatsapp
 *   - sin email ni phone   → no inferable (skip + reportar)
 *
 * Default es dry-run; pasar `--apply` para escribir en HubSpot.
 *
 * Uso:
 *   npm run backfill:canal           # dry-run
 *   npm run backfill:canal -- --apply
 */
import { Client } from '@hubspot/api-client';
import { inferCanalOriginal } from '../lib/business-rules.js';
import type { CanalOriginal } from '../lib/types.js';

type ContactProps = {
  email?: string | null;
  phone?: string | null;
  cuit?: string | null;
};

type Tally = {
  scanned: number;
  alreadySet: number;
  inferred: Record<CanalOriginal | 'none', number>;
  noContact: number;
  errors: number;
  applied: number;
};

const newTally = (): Tally => ({
  scanned: 0,
  alreadySet: 0,
  inferred: { email: 0, whatsapp: 0, manychat: 0, form: 0, none: 0 },
  noContact: 0,
  errors: 0,
  applied: 0,
});

async function loadContactProps(client: Client, contactId: string): Promise<ContactProps> {
  const c = await client.crm.contacts.basicApi.getById(contactId, ['email', 'phone', 'cuit']);
  return c.properties as ContactProps;
}

async function* iterateLegacyDeals(
  client: Client,
  pipelineId: string,
  stageId: string,
): AsyncGenerator<{ id: string; contactId: string | null }> {
  let after: string | undefined;
  while (true) {
    const res = await client.crm.deals.searchApi.doSearch({
      filterGroups: [
        {
          filters: [
            { propertyName: 'pipeline', operator: 'EQ', value: pipelineId },
            { propertyName: 'dealstage', operator: 'EQ', value: stageId },
            { propertyName: 'canal_original', operator: 'NOT_HAS_PROPERTY' },
          ],
        },
      ],
      properties: ['canal_original'],
      limit: 100,
      after,
    } as never);

    for (const result of res.results) {
      // Cargar la asociación de cada deal por separado (search no la trae).
      const full = await client.crm.deals.basicApi.getById(
        result.id,
        ['canal_original'],
        undefined,
        ['contacts'],
      );
      const contactId = full.associations?.contacts?.results?.[0]?.id ?? null;
      yield { id: result.id, contactId };
    }

    const next = (res.paging as { next?: { after?: string } } | undefined)?.next?.after;
    if (!next) break;
    after = next;
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  const pipelineId = process.env.HUBSPOT_PIPELINE_MAYORISTA_ID;
  const stageId = process.env.HUBSPOT_STAGE_SEGUIMIENTO_ID;

  if (!token || !pipelineId || !stageId) {
    console.error('Faltan env vars: HUBSPOT_PRIVATE_APP_TOKEN, HUBSPOT_PIPELINE_MAYORISTA_ID, HUBSPOT_STAGE_SEGUIMIENTO_ID');
    process.exit(1);
  }

  console.log(apply ? '⚠ MODO APPLY — voy a escribir en HubSpot.' : '· DRY-RUN — no se va a escribir nada. Pasá --apply para aplicar.');

  const client = new Client({ accessToken: token });
  const tally = newTally();

  for await (const { id: dealId, contactId } of iterateLegacyDeals(client, pipelineId, stageId)) {
    tally.scanned++;
    if (!contactId) {
      tally.noContact++;
      console.log(`  ${dealId}  ✗ sin contact asociado`);
      continue;
    }
    try {
      const props = await loadContactProps(client, contactId);
      const inferred = inferCanalOriginal({
        email: props.email,
        phone: props.phone,
        cuit: props.cuit,
      });
      if (inferred === null) {
        tally.inferred.none++;
        console.log(`  ${dealId}  ! contact ${contactId} sin email ni phone — revisar`);
        continue;
      }
      tally.inferred[inferred]++;
      console.log(`  ${dealId}  → ${inferred}${apply ? ' (apply)' : ' (dry)'}`);
      if (apply) {
        await client.crm.deals.basicApi.update(dealId, {
          properties: { canal_original: inferred },
        });
        tally.applied++;
      }
    } catch (err) {
      tally.errors++;
      console.error(`  ${dealId}  ✗ error: ${(err as Error).message}`);
    }
  }

  console.log('\n--- Resumen ---');
  console.log(`  scanned:     ${tally.scanned}`);
  console.log(`  email:       ${tally.inferred.email}`);
  console.log(`  whatsapp:    ${tally.inferred.whatsapp}`);
  console.log(`  no_inferable:${tally.inferred.none}`);
  console.log(`  sin_contact: ${tally.noContact}`);
  console.log(`  errors:      ${tally.errors}`);
  console.log(`  ${apply ? 'applied' : 'would_apply'}: ${apply ? tally.applied : tally.inferred.email + tally.inferred.whatsapp}`);

  if (!apply && (tally.inferred.email > 0 || tally.inferred.whatsapp > 0)) {
    console.log('\nPara escribir, re-correr con --apply:');
    console.log('  npm run backfill:canal -- --apply');
  }
}

main().catch((err) => {
  console.error('backfill crash:', err);
  process.exit(2);
});
