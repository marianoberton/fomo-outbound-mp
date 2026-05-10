/**
 * Workflow scheduled — reporte semanal de métricas.
 *
 * Corre los lunes a las 9:00 ART. Carga deals del pipeline mayorista,
 * agrega métricas de los últimos 7 días, loguea el reporte estructurado
 * (queda en observability + Pino) y, si `SLACK_WEBHOOK_URL` está seteado,
 * postea un resumen al canal.
 *
 * Idempotencia: el reporte es read-only. Re-correr el mismo lunes produce
 * el mismo número (la ventana es un rolling 7d desde el momento del run).
 */
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { Client } from '@hubspot/api-client';
import { CONFIG, STUB_MODE } from '../../config/constants.js';
import {
  aggregate,
  filterBySince,
  parseSince,
  type DealLite,
  type FunnelMetrics,
} from '../../lib/metrics.js';

const ReportSchema = z.object({
  total: z.number(),
  since: z.string(),
  metrics: z.unknown(), // Serializa la FunnelMetrics tal cual.
  postedToSlack: z.boolean(),
});

async function loadAllDeals(token: string, pipelineId: string): Promise<DealLite[]> {
  const client = new Client({ accessToken: token });
  const out: DealLite[] = [];
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
      out.push({
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
  return out;
}

function slackBlocks(m: FunnelMetrics, since: string): { text: string; blocks: unknown[] } {
  const fmt = (n: number) => n.toLocaleString('es-AR');
  const fmtArs = (n: number) => `$${n.toLocaleString('es-AR')}`;
  const headerText = `:bar_chart: Reporte semanal — outbound-mp (últimos ${since})`;
  return {
    text: headerText,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: headerText } },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Total deals:*\n${fmt(m.total)}` },
          { type: 'mrkdwn', text: `*Engagement rate:*\n${m.rates.engagementRate}%` },
          { type: 'mrkdwn', text: `*Win rate:*\n${m.rates.winRate}%` },
          { type: 'mrkdwn', text: `*Freeze rate:*\n${m.rates.freezeRate}%` },
        ],
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Sent (1/2/3):*\n${fmt(m.intentos.intento1)} / ${fmt(m.intentos.intento2)} / ${fmt(m.intentos.intento3)}` },
          { type: 'mrkdwn', text: `*Active conv:*\n${fmt(m.outcomes.activeConversation)}` },
          { type: 'mrkdwn', text: `*Won / Lost:*\n${fmt(m.outcomes.won)} / ${fmt(m.outcomes.lost)}` },
          { type: 'mrkdwn', text: `*Frozen:*\n${fmt(m.outcomes.frozen)}` },
        ],
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*ARS ganado:*\n${fmtArs(m.totalArs.won)}` },
          { type: 'mrkdwn', text: `*ARS in-flight:*\n${fmtArs(m.totalArs.inFlight)}` },
        ],
      },
    ],
  };
}

async function postToSlack(webhookUrl: string, m: FunnelMetrics, since: string): Promise<void> {
  const payload = slackBlocks(m, since);
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Slack webhook ${res.status}: ${t.slice(0, 200)}`);
  }
}

const reporteSemanalStep = createStep({
  id: 'reporteSemanal',
  description:
    'Carga deals, agrega métricas de los últimos 7d, loguea reporte y postea a Slack si SLACK_WEBHOOK_URL está seteado.',
  inputSchema: z.object({}).passthrough(),
  outputSchema: ReportSchema,
  execute: async ({ mastra, runId }) => {
    const log = mastra?.getLogger();
    const since = '7d';
    const sinceIso = parseSince(since);

    if (STUB_MODE) {
      log?.warn('reporteSemanal corriendo en STUB_MODE — no carga deals reales', {
        workflowRun: runId,
      });
      const empty = aggregate([]);
      return { total: 0, since, metrics: empty, postedToSlack: false };
    }

    const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
    const pipelineId = process.env.HUBSPOT_PIPELINE_MAYORISTA_ID;
    if (!token || !pipelineId) {
      throw new Error('reporteSemanal: faltan HUBSPOT_PRIVATE_APP_TOKEN o HUBSPOT_PIPELINE_MAYORISTA_ID.');
    }

    const t0 = Date.now();
    const all = await loadAllDeals(token, pipelineId);
    const inWindow = filterBySince(all, sinceIso);
    const m = aggregate(inWindow);

    log?.info('reporteSemanal aggregated', {
      workflowRun: runId,
      step: 'reporteSemanal',
      action: 'aggregate',
      outcome: 'ok',
      total: inWindow.length,
      totalAllTime: all.length,
      rates: m.rates,
      durationMs: Date.now() - t0,
    });

    const slackUrl = process.env.SLACK_WEBHOOK_URL;
    let postedToSlack = false;
    if (slackUrl) {
      try {
        await postToSlack(slackUrl, m, since);
        postedToSlack = true;
        log?.info('reporteSemanal posted to slack', { workflowRun: runId });
      } catch (err) {
        log?.error('reporteSemanal slack post failed', {
          workflowRun: runId,
          error: (err as Error).message,
        });
      }
    }

    return { total: inWindow.length, since, metrics: m, postedToSlack };
  },
});

export const metricasSemanalWorkflow = createWorkflow({
  id: 'metricas-semanal',
  inputSchema: z.object({}).passthrough(),
  outputSchema: ReportSchema,
  schedule: {
    cron: '0 9 * * 1', // lunes 9:00
    timezone: CONFIG.BUSINESS_HOURS.timezone,
    inputData: {},
  },
})
  .then(reporteSemanalStep)
  .commit();
