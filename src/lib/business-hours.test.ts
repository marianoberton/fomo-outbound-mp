/**
 * Tests de horario laboral AR (§13).
 *
 * Casos:
 *   - lunes 10am ART  → ✓
 *   - sábado 10am ART → ✗
 *   - feriado AR ART  → ✗
 *   - lunes 22:00 ART → ✗
 */
import { describe, expect, it } from 'vitest';
import { isHoliday, isWeekend, isWithinBusinessHours } from './business-hours.js';

// AR es UTC-3 sin DST: 10am ART = 13:00Z; 22:00 ART = 01:00Z (día siguiente UTC).

describe('isWithinBusinessHours', () => {
  it('lunes 10am ART → true', () => {
    // 2026-05-11 es lunes
    const d = new Date('2026-05-11T13:00:00Z');
    expect(isWithinBusinessHours(d)).toBe(true);
  });

  it('sábado 10am ART → false', () => {
    // 2026-05-09 es sábado
    const d = new Date('2026-05-09T13:00:00Z');
    expect(isWithinBusinessHours(d)).toBe(false);
  });

  it('lunes 22:00 ART (= 01:00 UTC martes) → false', () => {
    // 2026-05-12 01:00Z = lunes 11 22:00 ART
    const d = new Date('2026-05-12T01:00:00Z');
    expect(isWithinBusinessHours(d)).toBe(false);
  });

  it('domingo mediodía ART → false', () => {
    // 2026-05-10 es domingo
    const d = new Date('2026-05-10T15:00:00Z');
    expect(isWithinBusinessHours(d)).toBe(false);
  });

  it('feriado AR (1 de mayo, día del trabajador) → false', () => {
    // 2026-05-01 12:00 ART
    const d = new Date('2026-05-01T15:00:00Z');
    expect(isHoliday(d)).toBe(true);
    expect(isWithinBusinessHours(d)).toBe(false);
  });
});

describe('isWeekend', () => {
  it('sábado AR → true', () => {
    expect(isWeekend(new Date('2026-05-09T13:00:00Z'))).toBe(true);
  });
  it('domingo AR → true', () => {
    expect(isWeekend(new Date('2026-05-10T13:00:00Z'))).toBe(true);
  });
  it('lunes AR → false', () => {
    expect(isWeekend(new Date('2026-05-11T13:00:00Z'))).toBe(false);
  });
});
