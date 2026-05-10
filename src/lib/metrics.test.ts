/**
 * Tests de las funciones puras de agregación.
 */
import { describe, expect, it } from 'vitest';
import {
  aggregate,
  aggregateClassifier,
  extractClassifierCategory,
  filterBySince,
  parseSince,
  type DealLite,
  type NoteLite,
} from './metrics.js';

const deal = (overrides: Partial<DealLite>): DealLite => ({
  id: 'd',
  reactivacion_estado: 'eligible',
  ultimo_intento_fecha: null,
  monto_cotizado_ars: 1_000_000,
  ...overrides,
});

describe('aggregate', () => {
  it('cuenta por estado correctamente', () => {
    const deals: DealLite[] = [
      deal({ id: '1', reactivacion_estado: 'sent_attempt_1' }),
      deal({ id: '2', reactivacion_estado: 'sent_attempt_1' }),
      deal({ id: '3', reactivacion_estado: 'won' }),
      deal({ id: '4', reactivacion_estado: 'frozen' }),
    ];
    const m = aggregate(deals);
    expect(m.total).toBe(4);
    expect(m.intentos.intento1).toBe(2);
    expect(m.outcomes.won).toBe(1);
    expect(m.outcomes.frozen).toBe(1);
  });

  it('calcula tasas sobre el universo de contactados', () => {
    const deals: DealLite[] = [
      // 5 contactados: 1 won, 1 active_conversation, 2 sent_attempt_*, 1 frozen
      deal({ id: '1', reactivacion_estado: 'sent_attempt_1' }),
      deal({ id: '2', reactivacion_estado: 'sent_attempt_2' }),
      deal({ id: '3', reactivacion_estado: 'active_conversation' }),
      deal({ id: '4', reactivacion_estado: 'won' }),
      deal({ id: '5', reactivacion_estado: 'frozen' }),
      // 1 sin contactar (eligible) — no afecta tasas
      deal({ id: '6', reactivacion_estado: 'eligible' }),
    ];
    const m = aggregate(deals);
    // engaged = active_conversation + awaiting_lost + won = 2/5 = 40%
    expect(m.rates.engagementRate).toBe(40);
    expect(m.rates.winRate).toBe(20);
    expect(m.rates.freezeRate).toBe(20);
  });

  it('totaliza ARS por outcome', () => {
    const deals: DealLite[] = [
      deal({ id: '1', reactivacion_estado: 'won', monto_cotizado_ars: 2_000_000 }),
      deal({ id: '2', reactivacion_estado: 'won', monto_cotizado_ars: 1_500_000 }),
      deal({ id: '3', reactivacion_estado: 'frozen', monto_cotizado_ars: 7_000_000 }),
      deal({ id: '4', reactivacion_estado: 'sent_attempt_1', monto_cotizado_ars: 800_000 }),
    ];
    const m = aggregate(deals);
    expect(m.totalArs.won).toBe(3_500_000);
    expect(m.totalArs.frozen).toBe(7_000_000);
    expect(m.totalArs.inFlight).toBe(800_000);
  });

  it('estado null cuenta como unknown', () => {
    const m = aggregate([deal({ id: '1', reactivacion_estado: null })]);
    expect(m.byEstado.unknown).toBe(1);
  });

  it('lista vacía → todas las tasas en 0 sin dividir por cero', () => {
    const m = aggregate([]);
    expect(m.total).toBe(0);
    expect(m.rates.engagementRate).toBe(0);
    expect(m.rates.winRate).toBe(0);
  });
});

describe('filterBySince', () => {
  const deals: DealLite[] = [
    deal({ id: '1', ultimo_intento_fecha: '2026-05-01' }),
    deal({ id: '2', ultimo_intento_fecha: '2026-05-08' }),
    deal({ id: '3', ultimo_intento_fecha: null }), // nunca contactado
  ];

  it('null since → no filtra', () => {
    expect(filterBySince(deals, null)).toHaveLength(3);
  });

  it('filtra por fecha', () => {
    const out = filterBySince(deals, '2026-05-05');
    expect(out.map((d) => d.id)).toEqual(['2']);
  });

  it('excluye deals sin ultimo_intento_fecha cuando hay filtro', () => {
    const out = filterBySince(deals, '2020-01-01');
    expect(out.map((d) => d.id)).toEqual(['1', '2']); // el id=3 (null) queda fuera
  });
});

describe('parseSince', () => {
  const NOW = new Date('2026-05-09T12:00:00Z');

  it('"all" → null', () => {
    expect(parseSince('all', NOW)).toBeNull();
  });

  it('"7d" → hace 7 días', () => {
    expect(parseSince('7d', NOW)).toBe('2026-05-02');
  });

  it('"30d" → hace 30 días', () => {
    expect(parseSince('30d', NOW)).toBe('2026-04-09');
  });

  it('formato inválido → throw', () => {
    expect(() => parseSince('asdf', NOW)).toThrow();
    expect(() => parseSince('7days', NOW)).toThrow();
  });
});

describe('extractClassifierCategory', () => {
  it.each([
    ['[CLASSIFIER] hot', 'hot'],
    ['[CLASSIFIER] cold', 'cold'],
    ['[CLASSIFIER] optout', 'optout'],
    ['[CLASSIFIER] ambiguous', 'ambiguous'],
    ['[CLASSIFIER] HOT', 'hot'], // case insensitive
    ['[CLASSIFIER] hot — extra', 'hot'], // ignora sufijo después de la categoría
  ])('"%s" → %s', (title, expected) => {
    expect(extractClassifierCategory(title)).toBe(expected);
  });

  it.each([
    '[AGENTE] Intento 1 enviado por email',
    '[CLASSIFIER] unknown',
    '[CLASSIFIER]',
    'classifier hot',
    '',
  ])('"%s" → null', (title) => {
    expect(extractClassifierCategory(title)).toBeNull();
  });
});

describe('aggregateClassifier', () => {
  const note = (title: string, createdAt: string): NoteLite => ({ title, createdAt });

  it('cuenta y calcula tasas correctamente', () => {
    const notes: NoteLite[] = [
      note('[CLASSIFIER] hot', '2026-05-08T12:00:00Z'),
      note('[CLASSIFIER] hot', '2026-05-08T13:00:00Z'),
      note('[CLASSIFIER] cold', '2026-05-08T14:00:00Z'),
      note('[CLASSIFIER] ambiguous', '2026-05-08T15:00:00Z'),
      note('[AGENTE] Intento 1 enviado por email', '2026-05-08T16:00:00Z'), // ignored
    ];
    const m = aggregateClassifier(notes, null);
    expect(m.total).toBe(4);
    expect(m.byCategory).toEqual({ hot: 2, cold: 1, optout: 0, ambiguous: 1 });
    expect(m.rates.hot).toBe(50);
    expect(m.rates.cold).toBe(25);
    expect(m.rates.ambiguous).toBe(25);
  });

  it('filtra por ventana temporal sobre createdAt', () => {
    const notes: NoteLite[] = [
      note('[CLASSIFIER] hot', '2026-05-01T12:00:00Z'), // antes del cutoff
      note('[CLASSIFIER] cold', '2026-05-08T12:00:00Z'),
    ];
    const m = aggregateClassifier(notes, '2026-05-05');
    expect(m.total).toBe(1);
    expect(m.byCategory.cold).toBe(1);
    expect(m.byCategory.hot).toBe(0);
  });

  it('lista vacía → 0% sin dividir por cero', () => {
    const m = aggregateClassifier([], null);
    expect(m.total).toBe(0);
    expect(m.rates.hot).toBe(0);
  });
});
