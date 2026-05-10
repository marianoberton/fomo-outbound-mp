/**
 * Tools de WhatsApp (Meta Business Cloud API).
 * Refs: MP.md §9.
 *
 * Importante:
 *  - Outbound usa SIEMPRE templates (estamos casi siempre fuera de la ventana de 24h).
 *  - sendWhatsAppFreeForm valida la ventana de 24h y lanza error si está cerrada (no fallback silencioso).
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { STUB_SEND } from '../../config/constants.js';
import { sendFreeFormText, sendTemplate } from '../../lib/meta-client.js';
import { getLastInboundAt } from '../../lib/inbound-lookup.js';

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export const sendWhatsAppTemplateTool = createTool({
  id: 'sendWhatsAppTemplate',
  description:
    'Envía un template aprobado en Meta Business Manager. variables se mapea por orden a {{1}}, {{2}}, ...',
  inputSchema: z.object({
    phone: z.string().describe('E.164, ej: +5491100000000'),
    templateName: z.string(),
    variables: z.record(z.string(), z.string()).default({}),
    languageCode: z.string().default('es_AR'),
  }),
  outputSchema: z.object({ messageId: z.string() }),
  execute: async (input, ctx) => {
    const log = ctx?.mastra?.getLogger();

    if (STUB_SEND) {
      log?.info('[stub] sendWhatsAppTemplate', {
        phone: input.phone,
        templateName: input.templateName,
        variables: input.variables,
      });
      return { messageId: `stub-wa-${Date.now()}` };
    }

    const result = await sendTemplate(
      input.phone,
      input.templateName,
      input.variables ?? {},
      input.languageCode,
    );
    log?.info('sendWhatsAppTemplate OK', {
      phone: input.phone,
      templateName: input.templateName,
      messageId: result.messageId,
    });
    return result;
  },
});

export const sendWhatsAppFreeFormTool = createTool({
  id: 'sendWhatsAppFreeForm',
  description:
    'Envía texto libre por WhatsApp. SOLO válido dentro de la ventana de 24h después del último mensaje inbound del cliente.',
  inputSchema: z.object({
    phone: z.string(),
    text: z.string(),
    /**
     * ISO timestamp del último mensaje inbound. Si no se pasa pero sí `contactId`,
     * la tool lo lee del HubSpot prop `wa_last_inbound_at`.
     */
    lastInboundAt: z.string().nullable().optional(),
    /** Contact ID en HubSpot para lookup automático de lastInboundAt. */
    contactId: z.string().optional(),
  }),
  outputSchema: z.object({ messageId: z.string() }),
  execute: async (input, ctx) => {
    const log = ctx?.mastra?.getLogger();

    let lastInboundIso: string | null = input.lastInboundAt ?? null;
    if (!lastInboundIso && input.contactId) {
      lastInboundIso = await getLastInboundAt(input.contactId);
    }

    const lastInbound = lastInboundIso ? new Date(lastInboundIso).getTime() : null;
    const now = Date.now();
    const withinWindow = lastInbound !== null && now - lastInbound <= TWENTY_FOUR_HOURS_MS;

    if (!withinWindow) {
      throw new Error(
        `WhatsApp 24h window CERRADA para ${input.phone} (lastInboundAt=${lastInboundIso ?? 'null'}). Usar sendWhatsAppTemplate.`,
      );
    }

    if (STUB_SEND) {
      log?.info('[stub] sendWhatsAppFreeForm', { phone: input.phone, text: input.text });
      return { messageId: `stub-wa-free-${Date.now()}` };
    }

    const result = await sendFreeFormText(input.phone, input.text);
    log?.info('sendWhatsAppFreeForm OK', { phone: input.phone, messageId: result.messageId });
    return result;
  },
});

export const whatsappTools = {
  sendWhatsAppTemplateTool,
  sendWhatsAppFreeFormTool,
};
