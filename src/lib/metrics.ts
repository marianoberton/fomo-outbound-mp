/**
 * Métricas operacionales del agente outbound.
 *
 * Funciones puras de agregación; el script CLI las consume con datos cargados
 * desde HubSpot. Mantenerlas puras hace que sean testables sin mock de la API.
 */

import type { ReactivacionEstado } from './types.js';

export type DealLite = {
  id: string;
  reactivacion_estado: ReactivacionEstado | null;
  ultimo_intento_fecha: string | null;
  monto_cotizado_ars: number | null;
};

export type FunnelMetrics = {
  total: number;
  byEstado: Record<ReactivacionEstado | 'unknown', number>;
  intentos: { intento1: number; intento2: number; intento3: number };
  outcomes: {
    won: number;
    lost: number;
    frozen: number;
    awaitingLost: number;
    excluded: number;
    activeConversation: number;
    awaitingResponse: number;
    eligible: number;
  };
  rates: {
    /** % de deals contactados que respondieron (entró a conversación o awaiting_lost). */
    engagementRate: number;
    /** % de deals contactados que terminaron ganados. */
    winRate: number;
    /** % de deals contactados que se congelaron por monto >= umbral. */
    freezeRate: number;
    /** % de deals contactados que pidieron optout (pasaron a excluded). */
    optoutRate: number;
  };
  totalArs: {
    won: number;
    lost: number;
    frozen: number;
    inFlight: number;
  };
};

const ALL_ESTADOS: Array<ReactivacionEstado | 'unknown'> = [
  'eligible',
  'sent_attempt_1',
  'sent_attempt_2',
  'sent_attempt_3',
  'awaiting_response',
  'active_conversation',
  'awaiting_lost_confirmation',
  'frozen',
  'won',
  'lost',
  'excluded',
  'unknown',
];

const IN_FLIGHT_ESTADOS = new Set([
  'eligible',
  'sent_attempt_1',
  'sent_attempt_2',
  'sent_attempt_3',
  'awaiting_response',
  'active_conversation',
  'awaiting_lost_confirmation',
]);

/**
 * Filtra deals por ventana temporal sobre `ultimo_intento_fecha`.
 * Si `sinceIso` es null, devuelve todos.
 *
 * Deals que nunca recibieron un intento (intento_n=0, ultimo_intento_fecha=null)
 * se excluyen del filtro temporal porque no aportan al cálculo de tasas de conversión.
 */
export function filterBySince(deals: DealLite[], sinceIso: string | null): DealLite[] {
  if (!sinceIso) return deals;
  return deals.filter((d) => d.ultimo_intento_fecha && d.ultimo_intento_fecha >= sinceIso);
}

export function aggregate(deals: DealLite[]): FunnelMetrics {
  const byEstado: Record<ReactivacionEstado | 'unknown', number> = Object.fromEntries(
    ALL_ESTADOS.map((e) => [e, 0]),
  ) as Record<ReactivacionEstado | 'unknown', number>;

  const totalArs = { won: 0, lost: 0, frozen: 0, inFlight: 0 };

  for (const d of deals) {
    const estado = d.reactivacion_estado ?? 'unknown';
    byEstado[estado] = (byEstado[estado] ?? 0) + 1;

    const monto = d.monto_cotizado_ars ?? 0;
    if (estado === 'won') totalArs.won += monto;
    else if (estado === 'lost') totalArs.lost += monto;
    else if (estado === 'frozen') totalArs.frozen += monto;
    else if (IN_FLIGHT_ESTADOS.has(estado)) totalArs.inFlight += monto;
  }

  const intentos = {
    intento1: byEstado.sent_attempt_1,
    intento2: byEstado.sent_attempt_2,
    intento3: byEstado.sent_attempt_3,
  };
  const outcomes = {
    won: byEstado.won,
    lost: byEstado.lost,
    frozen: byEstado.frozen,
    awaitingLost: byEstado.awaiting_lost_confirmation,
    excluded: byEstado.excluded,
    activeConversation: byEstado.active_conversation,
    awaitingResponse: byEstado.awaiting_response,
    eligible: byEstado.eligible,
  };

  // Denominador para tasas: deals que YA fueron contactados al menos una vez.
  const contacted =
    intentos.intento1 +
    intentos.intento2 +
    intentos.intento3 +
    outcomes.activeConversation +
    outcomes.awaitingResponse +
    outcomes.awaitingLost +
    outcomes.frozen +
    outcomes.won +
    outcomes.lost +
    outcomes.excluded;

  const engaged = outcomes.activeConversation + outcomes.awaitingLost + outcomes.won;
  const rate = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);

  return {
    total: deals.length,
    byEstado,
    intentos,
    outcomes,
    rates: {
      engagementRate: rate(engaged, contacted),
      winRate: rate(outcomes.won, contacted),
      freezeRate: rate(outcomes.frozen, contacted),
      optoutRate: rate(outcomes.excluded, contacted),
    },
    totalArs,
  };
}

/**
 * Devuelve un ISO date YYYY-MM-DD a `n` días en el pasado desde `now`.
 * `since=='7d'` → hace 7 días. `since=='30d'` → hace 30. `since=='all'` → null (sin filtro).
 */
export function parseSince(since: string, now = new Date()): string | null {
  if (since === 'all') return null;
  const m = since.match(/^(\d+)d$/);
  if (!m) throw new Error(`since debe ser "7d", "30d", o "all" — recibido: ${since}`);
  const days = Number(m[1]);
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Classifier metrics (parsing de notes [CLASSIFIER] <categoria>)
// ---------------------------------------------------------------------------

export type ClassifierMetrics = {
  total: number;
  byCategory: { hot: number; cold: number; optout: number; ambiguous: number };
  rates: { hot: number; cold: number; optout: number; ambiguous: number };
};

export type NoteLite = {
  title: string;
  createdAt: string; // ISO
};

const CLASSIFIER_TITLE_RE = /^\[CLASSIFIER\]\s+(hot|cold|optout|ambiguous)\b/i;

/**
 * Extrae la categoría del título de una nota — null si no es una nota del classifier.
 */
export function extractClassifierCategory(
  title: string,
): 'hot' | 'cold' | 'optout' | 'ambiguous' | null {
  const m = title.match(CLASSIFIER_TITLE_RE);
  if (!m) return null;
  return m[1].toLowerCase() as 'hot' | 'cold' | 'optout' | 'ambiguous';
}

/**
 * Agrega counts y tasas a partir de notes con título `[CLASSIFIER] <categoria>`.
 * Filtra por ventana temporal sobre `createdAt`.
 */
export function aggregateClassifier(
  notes: NoteLite[],
  sinceIso: string | null,
): ClassifierMetrics {
  const byCategory = { hot: 0, cold: 0, optout: 0, ambiguous: 0 };
  let total = 0;
  for (const n of notes) {
    if (sinceIso && n.createdAt.slice(0, 10) < sinceIso) continue;
    const cat = extractClassifierCategory(n.title);
    if (!cat) continue;
    byCategory[cat]++;
    total++;
  }
  const rate = (n: number) => (total === 0 ? 0 : Math.round((n / total) * 1000) / 10);
  return {
    total,
    byCategory,
    rates: {
      hot: rate(byCategory.hot),
      cold: rate(byCategory.cold),
      optout: rate(byCategory.optout),
      ambiguous: rate(byCategory.ambiguous),
    },
  };
}

export function formatClassifierReport(m: ClassifierMetrics, label: string): string {
  const fmt = (n: number) => n.toLocaleString('es-AR');
  return `
=== Classifier — ${label} ===

Respuestas clasificadas: ${fmt(m.total)}

Counts:
  hot:       ${fmt(m.byCategory.hot)}
  cold:      ${fmt(m.byCategory.cold)}
  optout:    ${fmt(m.byCategory.optout)}
  ambiguous: ${fmt(m.byCategory.ambiguous)}

Distribución (% del total):
  hot:       ${m.rates.hot}%
  cold:      ${m.rates.cold}%
  optout:    ${m.rates.optout}%
  ambiguous: ${m.rates.ambiguous}%
`;
}

export function formatReport(m: FunnelMetrics, label: string): string {
  const fmt = (n: number) => n.toLocaleString('es-AR');
  const fmtArs = (n: number) => `$${n.toLocaleString('es-AR')}`;
  return `
=== Métricas — ${label} ===

Total deals analizados: ${fmt(m.total)}

Funnel:
  eligible:                  ${fmt(m.outcomes.eligible)}
  sent_attempt_1:            ${fmt(m.intentos.intento1)}
  sent_attempt_2:            ${fmt(m.intentos.intento2)}
  sent_attempt_3:            ${fmt(m.intentos.intento3)}
  awaiting_response:         ${fmt(m.outcomes.awaitingResponse)}
  active_conversation:       ${fmt(m.outcomes.activeConversation)}
  awaiting_lost_confirmation:${fmt(m.outcomes.awaitingLost)}
  frozen:                    ${fmt(m.outcomes.frozen)}
  won:                       ${fmt(m.outcomes.won)}
  lost:                      ${fmt(m.outcomes.lost)}
  excluded:                  ${fmt(m.outcomes.excluded)}

Tasas (sobre contactados):
  engagement (respondieron): ${m.rates.engagementRate}%
  ganados:                   ${m.rates.winRate}%
  congelados:                ${m.rates.freezeRate}%
  optout:                    ${m.rates.optoutRate}%

Monto ARS:
  ganado:    ${fmtArs(m.totalArs.won)}
  perdido:   ${fmtArs(m.totalArs.lost)}
  congelado: ${fmtArs(m.totalArs.frozen)}
  in-flight: ${fmtArs(m.totalArs.inFlight)}
`;
}
