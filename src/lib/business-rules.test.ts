/**
 * Tests del cuadro de decisión §6.3 — todas las ramas + skip por horario.
 */
import { describe, expect, it } from 'vitest';
import {
  decideNextAction,
  inferCanalOriginal,
  originalToChannel,
} from './business-rules.js';
import type { Deal } from './types.js';

const baseDeal = (overrides: Partial<Deal> = {}): Deal => ({
  id: 'deal-1',
  contactId: 'contact-1',
  amount: 1_500_000,
  reactivacion_estado: 'eligible',
  intento_n: 0,
  ultimo_intento_fecha: null,
  ultimo_intento_canal: null,
  proximo_intento_fecha: '2026-05-09',
  canal_original: 'email',
  semaforo_cotizacion: 'verde',
  monto_cotizado_ars: 1_500_000,
  pdf_presupuesto_url: null,
  days_in_seguimiento: 7,
  intentos_fallidos: 0,
  ...overrides,
});

const NOW = new Date('2026-05-12T13:00:00Z'); // martes mediodía UTC = 10am ART

describe('originalToChannel', () => {
  it('mapea email → email', () => expect(originalToChannel('email')).toBe('email'));
  it('mapea form → email', () => expect(originalToChannel('form')).toBe('email'));
  it('mapea whatsapp → whatsapp', () => expect(originalToChannel('whatsapp')).toBe('whatsapp'));
  it('mapea manychat → whatsapp', () => expect(originalToChannel('manychat')).toBe('whatsapp'));
  it('null defaultea a email', () => expect(originalToChannel(null)).toBe('email'));
});

describe('decideNextAction — skip por horario/feriado', () => {
  it('devuelve skip cuando isWithinHours=false sin importar el estado', () => {
    const d = decideNextAction(baseDeal(), NOW, false);
    expect(d.actionType).toBe('skip');
    expect(d.reason).toMatch(/ventana laboral|feriado/i);
  });
});

describe('decideNextAction — idempotencia (no reenviar si ya se envió hoy)', () => {
  it('skip si ultimo_intento_fecha === today y intento_n > 0', () => {
    const todayIso = NOW.toISOString().slice(0, 10);
    const d = decideNextAction(
      baseDeal({ intento_n: 1, ultimo_intento_fecha: todayIso }),
      NOW,
      true,
    );
    expect(d.actionType).toBe('skip');
    expect(d.reason).toMatch(/idempotencia/i);
  });

  it('NO skip si intento_n === 0 (todavía no se envió nada)', () => {
    const todayIso = NOW.toISOString().slice(0, 10);
    const d = decideNextAction(
      baseDeal({ intento_n: 0, ultimo_intento_fecha: todayIso }),
      NOW,
      true,
    );
    expect(d.actionType).not.toBe('skip');
  });

  it('NO skip si ultimo_intento_fecha es de ayer', () => {
    const yesterday = new Date(NOW.getTime() - 24 * 3600 * 1000).toISOString().slice(0, 10);
    const d = decideNextAction(
      baseDeal({ intento_n: 1, ultimo_intento_fecha: yesterday }),
      NOW,
      true,
    );
    expect(d.actionType).toBe('next-attempt');
  });
});

describe('decideNextAction — primer contacto (intento 0)', () => {
  it('first-fresh cuando days_in_seguimiento < 14', () => {
    const d = decideNextAction(baseDeal({ intento_n: 0, days_in_seguimiento: 7 }), NOW, true);
    expect(d.actionType).toBe('first-fresh');
    expect(d.attemptNumber).toBe(1);
    expect(d.channel).toBe('email');
  });

  it('first-revival cuando days_in_seguimiento ≥ 14', () => {
    const d = decideNextAction(baseDeal({ intento_n: 0, days_in_seguimiento: 21 }), NOW, true);
    expect(d.actionType).toBe('first-revival');
    expect(d.attemptNumber).toBe(1);
  });

  it('respeta canal_original — whatsapp', () => {
    const d = decideNextAction(
      baseDeal({ intento_n: 0, days_in_seguimiento: 5, canal_original: 'whatsapp' }),
      NOW,
      true,
    );
    expect(d.channel).toBe('whatsapp');
  });
});

describe('decideNextAction — intento 1 → next-attempt cambia canal', () => {
  it('si último canal fue email, próximo es whatsapp', () => {
    const d = decideNextAction(
      baseDeal({ intento_n: 1, ultimo_intento_canal: 'email', canal_original: 'email' }),
      NOW,
      true,
    );
    expect(d.actionType).toBe('next-attempt');
    expect(d.attemptNumber).toBe(2);
    expect(d.channel).toBe('whatsapp');
  });

  it('si último canal fue whatsapp, próximo es email', () => {
    const d = decideNextAction(
      baseDeal({ intento_n: 1, ultimo_intento_canal: 'whatsapp', canal_original: 'whatsapp' }),
      NOW,
      true,
    );
    expect(d.channel).toBe('email');
  });
});

describe('decideNextAction — intento 2 → next-attempt vuelve a canal_original', () => {
  it('vuelve a canal_original tras intento 2', () => {
    const d = decideNextAction(
      baseDeal({ intento_n: 2, ultimo_intento_canal: 'whatsapp', canal_original: 'email' }),
      NOW,
      true,
    );
    expect(d.actionType).toBe('next-attempt');
    expect(d.attemptNumber).toBe(3);
    expect(d.channel).toBe('email');
  });
});

describe('decideNextAction — intento 3 → freeze vs propose-lost', () => {
  it('freeze cuando monto ≥ 5M ARS', () => {
    const d = decideNextAction(
      baseDeal({ intento_n: 3, monto_cotizado_ars: 7_000_000 }),
      NOW,
      true,
    );
    expect(d.actionType).toBe('freeze');
    expect(d.reason).toMatch(/grande/i);
  });

  it('propose-lost cuando monto < 5M ARS', () => {
    const d = decideNextAction(
      baseDeal({ intento_n: 3, monto_cotizado_ars: 1_500_000 }),
      NOW,
      true,
    );
    expect(d.actionType).toBe('propose-lost');
    expect(d.reason).toMatch(/chico/i);
  });

  it('freeze justo en el umbral de 5M', () => {
    const d = decideNextAction(
      baseDeal({ intento_n: 3, monto_cotizado_ars: 5_000_000 }),
      NOW,
      true,
    );
    expect(d.actionType).toBe('freeze');
  });

  it('propose-lost cuando monto_cotizado_ars es null (default 0)', () => {
    const d = decideNextAction(
      baseDeal({ intento_n: 3, monto_cotizado_ars: null }),
      NOW,
      true,
    );
    expect(d.actionType).toBe('propose-lost');
  });
});

describe('inferCanalOriginal (deals legacy sin canal_original)', () => {
  it('solo email → email', () => {
    expect(inferCanalOriginal({ email: 'a@b.com', phone: null, cuit: null })).toBe('email');
  });

  it('solo phone → whatsapp', () => {
    expect(inferCanalOriginal({ email: null, phone: '+5491100000000', cuit: null })).toBe(
      'whatsapp',
    );
  });

  it('email + phone + CUIT → email (cliente formal)', () => {
    expect(
      inferCanalOriginal({
        email: 'a@b.com',
        phone: '+5491100000000',
        cuit: '20-12345678-9',
      }),
    ).toBe('email');
  });

  it('email + phone sin CUIT → whatsapp (cercano)', () => {
    expect(
      inferCanalOriginal({ email: 'a@b.com', phone: '+5491100000000', cuit: null }),
    ).toBe('whatsapp');
  });

  it('sin email ni phone → null (skip + revisión manual)', () => {
    expect(inferCanalOriginal({ email: null, phone: null, cuit: '20-12345678-9' })).toBe(null);
    expect(inferCanalOriginal({})).toBe(null);
  });

  it('strings vacíos cuentan como ausentes', () => {
    expect(inferCanalOriginal({ email: '', phone: '+5491100000000', cuit: null })).toBe(
      'whatsapp',
    );
    expect(inferCanalOriginal({ email: 'a@b.com', phone: '   ', cuit: null })).toBe('email');
  });
});
