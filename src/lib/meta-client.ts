/**
 * Cliente HTTP para Meta WhatsApp Business Cloud API.
 * Refs: https://developers.facebook.com/docs/whatsapp/cloud-api/reference
 *
 * En STUB_MODE este módulo no debería ser invocado — las tools chequean el flag.
 */
import { STUB_MODE } from '../config/constants.js';
import { withRetry } from './retry.js';

const GRAPH_API_VERSION = 'v20.0';
const BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

function getEnv(): { phoneId: string; token: string } {
  if (STUB_MODE) {
    throw new Error('metaClient invocado en STUB_MODE — usar el flag STUB_MODE en las tools.');
  }
  const phoneId = process.env.META_WHATSAPP_PHONE_ID;
  const token = process.env.META_WHATSAPP_ACCESS_TOKEN;
  if (!phoneId || !token) {
    throw new Error('Faltan META_WHATSAPP_PHONE_ID o META_WHATSAPP_ACCESS_TOKEN.');
  }
  return { phoneId, token };
}

type MetaSendResponse = {
  messaging_product: 'whatsapp';
  contacts: Array<{ input: string; wa_id: string }>;
  messages: Array<{ id: string }>;
};

async function postMessage(body: Record<string, unknown>): Promise<MetaSendResponse> {
  const { phoneId, token } = getEnv();
  return withRetry(async () => {
    const res = await fetch(`${BASE_URL}/${phoneId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      // Adjuntamos status para que withRetry sepa si reintentar.
      const err = new Error(`Meta API ${res.status}: ${text}`) as Error & { status: number };
      err.status = res.status;
      throw err;
    }
    return (await res.json()) as MetaSendResponse;
  });
}

/**
 * Envía un template aprobado en Meta Business Manager.
 * Las variables se mapean en orden a los slots {{1}}, {{2}}... del cuerpo del template.
 */
export async function sendTemplate(
  phone: string,
  templateName: string,
  variables: Record<string, string>,
  languageCode = 'es_AR',
): Promise<{ messageId: string }> {
  const orderedKeys = Object.keys(variables).sort((a, b) => Number(a) - Number(b));
  const parameters = orderedKeys.map((k) => ({ type: 'text', text: variables[k] }));

  const components = parameters.length > 0 ? [{ type: 'body', parameters }] : [];

  const resp = await postMessage({
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      components,
    },
  });
  return { messageId: resp.messages[0].id };
}

/**
 * Envía texto libre. Solo válido dentro de la ventana de 24h post última inbound del cliente.
 * El caller debe verificar y pasar `lastInboundAt`; la verificación está en la tool.
 */
export async function sendFreeFormText(phone: string, text: string): Promise<{ messageId: string }> {
  const resp = await postMessage({
    messaging_product: 'whatsapp',
    to: phone,
    type: 'text',
    text: { body: text },
  });
  return { messageId: resp.messages[0].id };
}
