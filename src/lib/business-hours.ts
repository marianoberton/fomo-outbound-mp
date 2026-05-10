/**
 * Helpers de horario laboral y feriados argentinos.
 * Refs: MP.md §11 — usar paquete `date-holidays` con país 'AR'.
 */
import Holidays from 'date-holidays';
import { CONFIG } from '../config/constants.js';

const hd = new Holidays('AR');

const TZ = CONFIG.BUSINESS_HOURS.timezone;

/**
 * Devuelve hora (0-23) y día de semana (0=domingo .. 6=sábado) de la fecha dada,
 * resueltos en la zona horaria configurada (America/Argentina/Buenos_Aires).
 */
function localParts(date: Date): { hour: number; dayOfWeek: number; ymd: string } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
  const parts = fmt.formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const hour = Number(get('hour'));
  const weekdayShort = get('weekday'); // Mon, Tue, Wed, Thu, Fri, Sat, Sun
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayOfWeek = map[weekdayShort] ?? 0;
  const ymd = `${get('year')}-${get('month')}-${get('day')}`;
  return { hour, dayOfWeek, ymd };
}

export function isHoliday(date: Date): boolean {
  // date-holidays usa el TZ del sistema; le pasamos la fecha local AR derivada.
  const { ymd } = localParts(date);
  // hd.isHoliday acepta Date en TZ local del proceso; usamos un Date "anclado" al mediodía AR-equivalente
  // para evitar borde de medianoche. La forma simple: invocar con la fecha YMD a las 12:00 UTC-3 (AR sin DST).
  const result = hd.isHoliday(new Date(`${ymd}T12:00:00-03:00`));
  return Array.isArray(result) ? result.length > 0 : Boolean(result);
}

export function isWeekend(date: Date): boolean {
  const { dayOfWeek } = localParts(date);
  return dayOfWeek === 0 || dayOfWeek === 6;
}

export function isWithinBusinessHours(date: Date): boolean {
  if (CONFIG.BUSINESS_HOURS.skipWeekends && isWeekend(date)) return false;
  if (isHoliday(date)) return false;
  const { hour } = localParts(date);
  return hour >= CONFIG.BUSINESS_HOURS.start && hour < CONFIG.BUSINESS_HOURS.end;
}

/**
 * Devuelve la siguiente fecha (00:00 AR) que sea día hábil — saltea fines de semana y feriados.
 * Útil para reprogramar `proximo_intento_fecha` cuando hoy está fuera de ventana.
 */
export function nextBusinessDay(from: Date): Date {
  let cursor = new Date(from);
  cursor.setUTCDate(cursor.getUTCDate() + 1);
  for (let i = 0; i < 14; i++) {
    if (!isWeekend(cursor) && !isHoliday(cursor)) return cursor;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return cursor;
}

export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
