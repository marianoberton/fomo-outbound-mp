/**
 * Verificación de firmas de webhooks inbound.
 *
 * Meta WhatsApp:
 *   Header: `x-hub-signature-256: sha256=<hex>`
 *   sig = HMAC-SHA256(rawBody, app_secret).hex()
 *   Ref: https://developers.facebook.com/docs/messenger-platform/webhooks#security
 *
 * HubSpot v3:
 *   Header: `X-HubSpot-Signature-v3: <base64>`
 *   Header: `X-HubSpot-Request-Timestamp: <ms epoch>`
 *   source = `${method}${uri}${rawBody}${timestamp}`
 *   sig = base64(HMAC-SHA256(source, app_secret))
 *   Rechazar si |now - timestamp| > 5 min.
 *   Ref: https://developers.hubspot.com/docs/api/webhooks/validating-requests
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

function timingEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export type VerificationResult = { ok: true } | { ok: false; reason: string };

export function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  appSecret: string,
): VerificationResult {
  if (!appSecret) return { ok: false, reason: 'META_APP_SECRET no seteado' };
  if (!signatureHeader) return { ok: false, reason: 'header x-hub-signature-256 ausente' };
  const m = signatureHeader.match(/^sha256=([a-f0-9]+)$/i);
  if (!m) return { ok: false, reason: 'formato de signature inválido' };
  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
  if (!timingEqual(expected, m[1].toLowerCase())) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true };
}

export function verifyHubspotSignature(
  rawBody: string,
  method: string,
  fullUri: string,
  signatureHeader: string | null | undefined,
  timestampHeader: string | null | undefined,
  appSecret: string,
  options: { maxAgeMs?: number; now?: number } = {},
): VerificationResult {
  if (!appSecret) return { ok: false, reason: 'HUBSPOT_APP_SECRET no seteado' };
  if (!signatureHeader) return { ok: false, reason: 'header X-HubSpot-Signature-v3 ausente' };
  if (!timestampHeader) return { ok: false, reason: 'header X-HubSpot-Request-Timestamp ausente' };

  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'timestamp inválido' };

  const maxAge = options.maxAgeMs ?? 5 * 60 * 1000;
  const now = options.now ?? Date.now();
  if (Math.abs(now - ts) > maxAge) {
    return { ok: false, reason: `timestamp fuera de ventana (delta=${Math.abs(now - ts)}ms)` };
  }

  const source = `${method.toUpperCase()}${fullUri}${rawBody}${ts}`;
  const expected = createHmac('sha256', appSecret).update(source, 'utf8').digest('base64');
  if (!timingEqual(expected, signatureHeader)) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true };
}
