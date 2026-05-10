/**
 * Reglas de negocio puras. Refs: MP.md §6.3 (cuadro de decisión).
 *
 * Mantener acá toda la lógica determinística para que sea fácil de testear.
 */
import { CONFIG } from '../config/constants.js';
import {
  type ActionType,
  type Canal,
  type CanalOriginal,
  type Deal,
} from './types.js';

export type Decision = {
  actionType: ActionType;
  channel: Canal;
  attemptNumber: 1 | 2 | 3;
  /** explicación legible para auditoría / nota en HubSpot */
  reason: string;
};

/**
 * Mapea canal_original (que puede ser email|whatsapp|manychat|form) al canal de envío (email|whatsapp).
 * Default: email. manychat → whatsapp; form → email.
 */
export function originalToChannel(co: CanalOriginal | null): Canal {
  if (co === 'whatsapp' || co === 'manychat') return 'whatsapp';
  return 'email';
}

/**
 * Infiere `canal_original` para deals legacy donde la propiedad nunca se cargó.
 *
 * Reglas (MP.md §14 OPEN):
 *  - solo email           → email
 *  - solo phone           → whatsapp
 *  - email + phone + cuit → email   (cliente formal con CUIT, preferimos email)
 *  - email + phone (sin cuit) → whatsapp
 *  - sin email ni phone   → null    (caller decide qué hacer — típicamente skip y marcar para revisión)
 */
export function inferCanalOriginal(contact: {
  email?: string | null;
  phone?: string | null;
  cuit?: string | null;
}): CanalOriginal | null {
  const hasEmail = !!contact.email && contact.email.trim() !== '';
  const hasPhone = !!contact.phone && contact.phone.trim() !== '';
  const hasCuit = !!contact.cuit && contact.cuit.trim() !== '';

  if (!hasEmail && !hasPhone) return null;
  if (hasEmail && !hasPhone) return 'email';
  if (!hasEmail && hasPhone) return 'whatsapp';
  // hasEmail && hasPhone
  return hasCuit ? 'email' : 'whatsapp';
}

function alternateChannel(c: Canal): Canal {
  return c === 'email' ? 'whatsapp' : 'email';
}

/**
 * Decide la acción a tomar para un deal en la cadencia de reactivación.
 *
 * @param deal estado actual del deal (props del cuadro §4)
 * @param now fecha/hora actual (inyectable para tests)
 * @param isWithinHours flag — si la fecha actual está en ventana laboral. Si es false, devolvemos `skip`.
 */
export function decideNextAction(
  deal: Deal,
  now: Date,
  isWithinHours: boolean,
): Decision {
  const original: Canal = originalToChannel(deal.canal_original);

  if (!isWithinHours) {
    return {
      actionType: 'skip',
      channel: original,
      attemptNumber: (Math.min(Math.max(deal.intento_n, 0), 2) + 1) as 1 | 2 | 3,
      reason: 'Fuera de ventana laboral / día no hábil / feriado AR',
    };
  }

  // Idempotencia (CLAUDE.md): si ya enviamos algo hoy, no reenviar aunque el cron corra dos veces.
  const todayIso = now.toISOString().slice(0, 10);
  if (deal.intento_n > 0 && deal.ultimo_intento_fecha === todayIso) {
    return {
      actionType: 'skip',
      channel: original,
      attemptNumber: Math.min(deal.intento_n, 3) as 1 | 2 | 3,
      reason: 'Ya se envió un intento hoy — guard de idempotencia.',
    };
  }

  const intento = deal.intento_n;
  const days = deal.days_in_seguimiento ?? 0;

  if (intento === 0) {
    if (days < 14) {
      return {
        actionType: 'first-fresh',
        channel: original,
        attemptNumber: 1,
        reason: `Primer contacto: deal con ${days}d en seguimiento (<14d, fresco).`,
      };
    }
    return {
      actionType: 'first-revival',
      channel: original,
      attemptNumber: 1,
      reason: `Primer contacto: deal con ${days}d en seguimiento (≥14d, revival).`,
    };
  }

  if (intento === 1) {
    return {
      actionType: 'next-attempt',
      channel: alternateChannel(deal.ultimo_intento_canal ?? original),
      attemptNumber: 2,
      reason: 'Intento 2: cambio de canal vs último.',
    };
  }

  if (intento === 2) {
    return {
      actionType: 'next-attempt',
      channel: original,
      attemptNumber: 3,
      reason: 'Intento 3: vuelve al canal original, tono de cierre.',
    };
  }

  // intento === 3 → freeze (deal grande) o propose-lost
  const monto = deal.monto_cotizado_ars ?? 0;
  if (monto >= CONFIG.BIG_DEAL_THRESHOLD_ARS) {
    return {
      actionType: 'freeze',
      channel: original,
      attemptNumber: 3,
      reason: `Tras 3 intentos, deal grande (${monto.toLocaleString('es-AR')} ARS ≥ umbral). Congelar 60d y notificar dueña.`,
    };
  }

  return {
    actionType: 'propose-lost',
    channel: original,
    attemptNumber: 3,
    reason: `Tras 3 intentos sin respuesta, deal chico (${monto.toLocaleString('es-AR')} ARS < umbral). Proponer pérdida (requiere confirmación humana).`,
  };
}

/**
 * Devuelve cuántos días hay que sumar a `ultimo_intento_fecha` (=hoy) para programar el próximo intento.
 * MP.md §6.7: 1→4d, 2→5d, 3→5d (revisión humana día +14).
 */
export function nextDelayDays(intentoJustSent: 1 | 2 | 3): number {
  const c = CONFIG.CADENCE_DAYS;
  if (intentoJustSent === 1) return c.ATTEMPT_2_OFFSET;
  if (intentoJustSent === 2) return c.ATTEMPT_3_OFFSET - c.ATTEMPT_2_OFFSET;
  return c.FINAL_REVIEW_OFFSET - c.ATTEMPT_3_OFFSET;
}

/**
 * Mapea (attemptNumber, semaforo, days_in_seguimiento) → nombre de template WhatsApp.
 * El composer también puede elegir el nombre, pero esto da un fallback determinístico.
 */
export function templateNameFor(
  attemptNumber: 1 | 2 | 3,
  semaforo: 'verde' | 'amarillo' | 'rojo' | null,
  daysInSeguimiento: number,
): string {
  const t = CONFIG.WHATSAPP_TEMPLATES;
  if (attemptNumber === 1) {
    return daysInSeguimiento < 14 ? t.intento1_fresh : t.intento1_revival;
  }
  if (attemptNumber === 2) {
    if (semaforo === 'amarillo') return t.intento2_amarillo;
    if (semaforo === 'rojo') return t.intento2_rojo;
    return t.intento2_neutral;
  }
  return t.intento3_cierre;
}
