/**
 * Tests de verificación de firmas — Meta WhatsApp y HubSpot v3.
 * Vectores generados localmente con createHmac (mismo algoritmo que el verificador).
 */
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  verifyHubspotSignature,
  verifyMetaSignature,
} from './webhook-verify.js';

describe('verifyMetaSignature', () => {
  const secret = 'meta-test-secret';
  const body = '{"object":"whatsapp_business_account","entry":[{"id":"123"}]}';
  const valid = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

  it('acepta signature correcta', () => {
    expect(verifyMetaSignature(body, valid, secret)).toEqual({ ok: true });
  });

  it('rechaza signature inválida', () => {
    const bad = 'sha256=' + 'a'.repeat(64);
    const r = verifyMetaSignature(body, bad, secret);
    expect(r.ok).toBe(false);
  });

  it('rechaza header ausente', () => {
    const r = verifyMetaSignature(body, undefined, secret);
    expect(r.ok).toBe(false);
  });

  it('rechaza secret vacío', () => {
    const r = verifyMetaSignature(body, valid, '');
    expect(r.ok).toBe(false);
  });

  it('rechaza si el body cambió', () => {
    const r = verifyMetaSignature(body + ' ', valid, secret);
    expect(r.ok).toBe(false);
  });
});

describe('verifyHubspotSignature', () => {
  const secret = 'hubspot-test-secret';
  const method = 'POST';
  const uri = 'https://example.com/webhooks/hubspot-email';
  const body = '[{"eventId":1,"subscriptionType":"engagement.creation"}]';
  const ts = 1_700_000_000_000;
  const source = `${method}${uri}${body}${ts}`;
  const valid = createHmac('sha256', secret).update(source).digest('base64');

  it('acepta signature correcta dentro de la ventana', () => {
    const r = verifyHubspotSignature(body, method, uri, valid, String(ts), secret, {
      now: ts + 60_000,
    });
    expect(r).toEqual({ ok: true });
  });

  it('rechaza timestamp viejo (>5 min)', () => {
    const r = verifyHubspotSignature(body, method, uri, valid, String(ts), secret, {
      now: ts + 10 * 60_000,
    });
    expect(r.ok).toBe(false);
  });

  it('rechaza signature inválida', () => {
    const r = verifyHubspotSignature(body, method, uri, 'not-a-real-sig', String(ts), secret, {
      now: ts,
    });
    expect(r.ok).toBe(false);
  });

  it('rechaza si el body cambió', () => {
    const r = verifyHubspotSignature(body + 'x', method, uri, valid, String(ts), secret, {
      now: ts,
    });
    expect(r.ok).toBe(false);
  });

  it('rechaza headers ausentes', () => {
    const r1 = verifyHubspotSignature(body, method, uri, undefined, String(ts), secret, { now: ts });
    expect(r1.ok).toBe(false);
    const r2 = verifyHubspotSignature(body, method, uri, valid, undefined, secret, { now: ts });
    expect(r2.ok).toBe(false);
  });
});
