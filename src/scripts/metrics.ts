/**
 * Reporta métricas operacionales del agente sobre los deals del pipeline mayorista.
 *
 * Uso:
 *   npm run metrics            # ventana default: 30d
 *   npm run metrics -- --since 7d
 *   npm run metrics -- --since all
 *   npm run metrics -- --json  # output JSON para pipear a otra herramienta
 */
import { Client } from '@hubspot/api-client';
import {
  aggregate,
  aggregateClassifier,
  filterBySince,
  formatClassifierReport,
  formatReport,
  parseSince,
  type DealLite,
  type NoteLite,
} from '../lib/metrics.js';

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

async function loadAllDeals(client: Client, pipelineId: string): Promise<DealLite[]> {
  const deals: DealLite[] = [];
  let after: string | undefined;
  while (true) {
    const res = await client.crm.deals.searchApi.doSearch({
      filterGroups: [
        { filters: [{ propertyName: 'pipeline', operator: 'EQ', value: pipelineId }] },
      ],
      properties: ['reactivacion_estado', 'ultimo_intento_fecha', 'monto_cotizado_ars'],
      limit: 100,
      after,
    } as never);

    for (const r of res.results) {
      deals.push({
        id: r.id,
        reactivacion_estado: (r.properties?.reactivacion_estado as DealLite['reactivacion_estado']) ?? null,
        ultimo_intento_fecha: (r.properties?.ultimo_intento_fecha as string | null) ?? null,
        monto_cotizado_ars: r.properties?.monto_cotizado_ars
          ? Number(r.properties.monto_cotizado_ars)
          : null,
      });
    }

    const next = (res.paging as { next?: { after?: string } } | undefined)?.next?.after;
    if (!next) break;
    after = next;
  }
  return deals;
}

async function loadClassifierNotes(client: Client, sinceIso: string | null): Promise<NoteLite[]> {
  const out: NoteLite[] = [];
  let after: string | undefined;
  while (true) {
    const filters: Array<{ propertyName: string; operator: string; value?: string }> = [
      { propertyName: 'hs_note_body', operator: 'CONTAINS_TOKEN', value: 'CLASSIFIER' },
    ];
    if (sinceIso) {
      filters.push({
        propertyName: 'hs_createdate',
        operator: 'GTE',
        value: `${sinceIso}T00:00:00Z`,
      });
    }
    const res = await client.crm.objects.notes.searchApi.doSearch({
      filterGroups: [{ filters }],
      properties: ['hs_note_body', 'hs_createdate'],
      limit: 100,
      after,
    } as never);
    for (const r of res.results) {
      // El title se guarda dentro de hs_note_body como `<b>[CLASSIFIER] hot</b><br/>...`.
      // Extraemos lo que viene después de <b> hasta </b>.
      const body = (r.properties?.hs_note_body as string | undefined) ?? '';
      const match = body.match(/<b>([^<]+)<\/b>/i);
      const title = match?.[1] ?? '';
      const created = (r.properties?.hs_createdate as string | undefined) ?? new Date().toISOString();
      out.push({ title, createdAt: created });
    }
    const next = (res.paging as { next?: { after?: string } } | undefined)?.next?.after;
    if (!next) break;
    after = next;
  }
  return out;
}

async function main(): Promise<void> {
  const since = getArg('--since') ?? '30d';
  const asJson = process.argv.includes('--json');
  const includeClassifier = process.argv.includes('--include-classifier');

  const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  const pipelineId = process.env.HUBSPOT_PIPELINE_MAYORISTA_ID;
  if (!token || !pipelineId) {
    console.error('Faltan HUBSPOT_PRIVATE_APP_TOKEN o HUBSPOT_PIPELINE_MAYORISTA_ID.');
    process.exit(1);
  }

  const sinceIso = parseSince(since);
  const client = new Client({ accessToken: token });

  if (!asJson) {
    process.stderr.write(`Cargando deals del pipeline mayorista... (since=${since})\n`);
  }

  const all = await loadAllDeals(client, pipelineId);
  const inWindow = filterBySince(all, sinceIso);
  const m = aggregate(inWindow);

  let classifierMetrics = null;
  if (includeClassifier) {
    if (!asJson) process.stderr.write('Cargando notes del classifier...\n');
    const notes = await loadClassifierNotes(client, sinceIso);
    classifierMetrics = aggregateClassifier(notes, sinceIso);
  }

  if (asJson) {
    console.log(JSON.stringify({ since, sinceIso, funnel: m, classifier: classifierMetrics }, null, 2));
  } else {
    const label = sinceIso ? `desde ${sinceIso} (últimos ${since})` : 'all-time';
    console.log(formatReport(m, label));
    if (classifierMetrics) {
      console.log(formatClassifierReport(classifierMetrics, label));
    }
  }
}

main().catch((err) => {
  console.error('metrics crash:', err);
  process.exit(2);
});
