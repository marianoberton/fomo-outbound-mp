/**
 * Workflow A — cadencia outbound (cron diario 9:00 ART, lun-vie).
 *
 * Pipeline alto nivel (MP.md §3, §6):
 *   fetchEligibleDeals → foreach(deal):
 *     loadContext → decideAction → compose → approvalGate → send → updateHubSpot
 *
 * Cada step es chico y devuelve el estado acumulado, así el siguiente accede a todo.
 */
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { isValidationError } from '@mastra/core/tools';
import { z } from 'zod';
import { CONFIG } from '../../config/constants.js';
import {
  decideNextAction,
  nextDelayDays,
  templateNameFor,
} from '../../lib/business-rules.js';
import {
  isWithinBusinessHours,
  nextBusinessDay,
  toIsoDate,
} from '../../lib/business-hours.js';
import {
  ActionTypeSchema,
  CanalSchema,
  ComposedMessageSchema,
  ContactSchema,
  DealContextSchema,
  DealSchema,
  type ComposedMessage,
} from '../../lib/types.js';
import {
  addNoteToDealTool,
  createTaskForOwnerTool,
  getDealContextTool,
  listEligibleDealsTool,
  updateDealPropertiesTool,
} from '../tools/hubspot-tools.js';
import { sendWhatsAppTemplateTool } from '../tools/whatsapp-tools.js';
import { sendEmailViaHubspotTool } from '../tools/email-tools.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Llama un tool.execute() y throwea si devuelve ValidationError.
 *
 * Justificación de `any` en input/ctx: el `ToolExecutionContext` de Mastra
 * es demasiado generic-heavy (TSchemaIn, TSchemaOut, TSuspend, TResume, ...)
 * para que un wrapper genérico pueda aceptarlo sin propagar 5+ parámetros de tipo
 * que no aportan valor al call site. Validamos en runtime con isValidationError().
 */
async function runTool<O>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool: { execute?: (input: any, ctx: any) => Promise<unknown> },
  input: unknown,
  ctx: { mastra?: unknown },
): Promise<O> {
  if (!tool.execute) throw new Error('Tool sin execute().');
  const result = await tool.execute(input, ctx);
  if (isValidationError(result)) {
    throw new Error(`Tool validation error: ${result.message}`);
  }
  return result as O;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const DecisionSchema = z.object({
  actionType: ActionTypeSchema,
  channel: CanalSchema,
  attemptNumber: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  reason: z.string(),
});

const ApprovalSchema = z.object({
  approved: z.boolean(),
  edits: z
    .object({
      subject: z.string().optional(),
      body: z.string().optional(),
      variables: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
});

const SendResultSchema = z.object({
  sent: z.boolean(),
  messageId: z.string().nullable(),
});

const PerDealOutcomeSchema = z.object({
  dealId: z.string(),
  actionType: ActionTypeSchema,
  outcome: z.enum(['sent', 'skipped', 'frozen', 'awaiting-lost', 'rejected', 'no-contact']),
  messageId: z.string().nullable(),
  reason: z.string(),
});

const FetchOutputSchema = z.object({ deals: z.array(DealSchema) });
const PerDealInputSchema = z.object({ deal: DealSchema });
const LoadContextOutputSchema = z.object({
  deal: DealSchema,
  context: DealContextSchema,
  noContact: z.boolean(),
});
const DecideOutputSchema = LoadContextOutputSchema.extend({
  decision: DecisionSchema,
});
const ComposeOutputSchema = DecideOutputSchema.extend({
  composed: ComposedMessageSchema.nullable(),
});
const ApprovalOutputSchema = ComposeOutputSchema.extend({
  approval: ApprovalSchema,
});
const SendOutputSchema = ApprovalOutputSchema.extend({
  sendResult: SendResultSchema,
});

const ApprovalSuspendSchema = z.object({
  dealId: z.string(),
  company: z.string().nullable(),
  contact: ContactSchema,
  decision: DecisionSchema,
  composed: ComposedMessageSchema,
});

// ---------------------------------------------------------------------------
// Outer step: fetch
// ---------------------------------------------------------------------------

const fetchEligibleDealsStep = createStep({
  id: 'fetchEligibleDeals',
  description: 'Lista deals elegibles del pipeline mayorista (proximo_intento_fecha <= hoy).',
  inputSchema: z.object({}).passthrough(),
  outputSchema: FetchOutputSchema,
  execute: async ({ mastra, runId }) => {
    const log = mastra?.getLogger();
    const start = Date.now();
    const result = await runTool<{ deals: unknown[] }>(
      listEligibleDealsTool,
      { limit: CONFIG.BACKFILL_DAILY_LIMIT },
      { mastra },
    );
    log?.info('fetchEligibleDeals OK', {
      workflowRun: runId,
      step: 'fetchEligibleDeals',
      action: 'list',
      outcome: 'ok',
      count: result.deals.length,
      durationMs: Date.now() - start,
    });
    // Validar contra el schema esperado para que TS sepa el shape exacto.
    return FetchOutputSchema.parse(result);
  },
});

// ---------------------------------------------------------------------------
// Per-deal steps
// ---------------------------------------------------------------------------

const loadContextStep = createStep({
  id: 'loadDealContext',
  description: 'Carga contact asociado y filtra no_contactar.',
  inputSchema: PerDealInputSchema,
  outputSchema: LoadContextOutputSchema,
  execute: async ({ inputData, mastra }) => {
    const ctx = await runTool<z.infer<typeof DealContextSchema>>(
      getDealContextTool,
      { dealId: inputData.deal.id },
      { mastra },
    );
    return {
      deal: inputData.deal,
      context: ctx,
      noContact: ctx.contact.no_contactar === true,
    };
  },
});

const decideActionStep = createStep({
  id: 'decideNextAction',
  description: 'Aplica el cuadro §6.3 y devuelve actionType+channel+attemptNumber.',
  inputSchema: LoadContextOutputSchema,
  outputSchema: DecideOutputSchema,
  execute: async ({ inputData, mastra, runId }) => {
    const log = mastra?.getLogger();
    const now = new Date();
    const inHours = isWithinBusinessHours(now);

    if (inputData.noContact) {
      log?.warn('decideNextAction skip: no_contactar', {
        workflowRun: runId,
        dealId: inputData.deal.id,
        step: 'decideNextAction',
        action: 'skip',
        outcome: 'no_contactar',
      });
      return {
        ...inputData,
        decision: {
          actionType: 'skip' as const,
          channel: 'email' as const,
          attemptNumber: 1 as const,
          reason: 'Contact marcado no_contactar=true.',
        },
      };
    }

    const decision = decideNextAction(inputData.deal, now, inHours);
    const level = decision.actionType === 'skip' ? 'warn' : 'info';
    log?.[level]('decideNextAction', {
      workflowRun: runId,
      dealId: inputData.deal.id,
      step: 'decideNextAction',
      action: decision.actionType,
      outcome: decision.reason,
      channel: decision.channel,
      attemptNumber: decision.attemptNumber,
    });
    return { ...inputData, decision };
  },
});

const composeStep = createStep({
  id: 'composeMessage',
  description:
    'Llama al composerAgent para generar el mensaje. Si actionType no requiere mensaje, devuelve null.',
  inputSchema: DecideOutputSchema,
  outputSchema: ComposeOutputSchema,
  execute: async ({ inputData, mastra }) => {
    const log = mastra?.getLogger();
    const a = inputData.decision.actionType;
    if (a !== 'first-fresh' && a !== 'first-revival' && a !== 'next-attempt') {
      return { ...inputData, composed: null };
    }

    const agent = mastra?.getAgent('composerAgent');
    if (!agent) throw new Error('composerAgent no registrado en Mastra.');

    const { deal, context, decision } = inputData;
    const suggestedTemplate =
      decision.channel === 'whatsapp'
        ? templateNameFor(
            decision.attemptNumber,
            deal.semaforo_cotizacion,
            deal.days_in_seguimiento ?? 0,
          )
        : undefined;

    const userPrompt = JSON.stringify(
      {
        actionType: decision.actionType,
        attemptNumber: decision.attemptNumber,
        channel: decision.channel,
        suggestedWhatsAppTemplate: suggestedTemplate,
        semaforo: deal.semaforo_cotizacion,
        daysSinceLastContact: deal.ultimo_intento_fecha
          ? Math.max(
              0,
              Math.floor(
                (Date.now() - new Date(deal.ultimo_intento_fecha).getTime()) /
                  (1000 * 60 * 60 * 24),
              ),
            )
          : null,
        cliente: {
          firstname: context.contact.firstname,
          lastname: context.contact.lastname,
          company: context.contact.company,
          cuit: context.contact.cuit,
        },
        presupuesto: {
          montoArs: deal.monto_cotizado_ars,
          pdfUrl: deal.pdf_presupuesto_url,
        },
      },
      null,
      2,
    );

    const t0 = Date.now();
    const resp = await agent.generate(userPrompt, {
      structuredOutput: { schema: ComposedMessageSchema },
    });
    const composed = resp.object as ComposedMessage;

    log?.info('composeMessage OK', {
      dealId: deal.id,
      step: 'composeMessage',
      action: 'generate',
      outcome: 'ok',
      channel: composed.channel,
      reasoning: composed.reasoning,
      durationMs: Date.now() - t0,
    });
    return { ...inputData, composed };
  },
});

const approvalGateStep = createStep({
  id: 'approvalGate',
  description:
    'Si APPROVAL_MODE=on y hay mensaje compuesto, suspende para revisión humana. Devuelve la decisión humana.',
  inputSchema: ComposeOutputSchema,
  outputSchema: ApprovalOutputSchema,
  suspendSchema: ApprovalSuspendSchema,
  resumeSchema: ApprovalSchema,
  execute: async ({ inputData, resumeData, suspend, mastra }) => {
    const log = mastra?.getLogger();
    if (!inputData.composed) {
      return { ...inputData, approval: { approved: true } };
    }
    if (CONFIG.APPROVAL_MODE === 'off') {
      return { ...inputData, approval: { approved: true } };
    }
    if (resumeData) {
      log?.info('approvalGate resume', {
        dealId: inputData.deal.id,
        approved: resumeData.approved,
        hasEdits: !!resumeData.edits,
      });
      return { ...inputData, approval: resumeData };
    }
    log?.info('approvalGate suspend', { dealId: inputData.deal.id });
    await suspend({
      dealId: inputData.deal.id,
      company: inputData.context.contact.company,
      contact: inputData.context.contact,
      decision: inputData.decision,
      composed: inputData.composed,
    });
    // suspend() halts execution; este return placeholder nunca se ejecuta hasta resume.
    return { ...inputData, approval: { approved: false } };
  },
});

const sendStep = createStep({
  id: 'sendMessage',
  description:
    'Envía el mensaje por el canal correspondiente. Si la aprobación trajo edits, los aplica.',
  inputSchema: ApprovalOutputSchema,
  outputSchema: SendOutputSchema,
  execute: async ({ inputData, mastra }) => {
    const log = mastra?.getLogger();
    const { composed, approval, decision } = inputData;

    if (!composed || !approval.approved) {
      return { ...inputData, sendResult: { sent: false, messageId: null } };
    }

    const edits = approval.edits;
    const subject = edits?.subject ?? composed.emailSubject ?? '';
    const body = edits?.body ?? composed.emailBody ?? '';
    const variables = edits?.variables ?? composed.whatsappVariables ?? {};

    const sendStart = Date.now();
    if (composed.channel === 'email') {
      if (!inputData.context.contact.id) {
        throw new Error(`Deal ${inputData.deal.id} sin contact.id para email.`);
      }
      const r = await runTool<{ messageId: string }>(
        sendEmailViaHubspotTool,
        { contactId: inputData.context.contact.id, subject, htmlBody: body },
        { mastra },
      );
      log?.info('sendMessage email OK', {
        dealId: inputData.deal.id,
        step: 'sendMessage',
        action: 'email',
        outcome: 'sent',
        messageId: r.messageId,
        durationMs: Date.now() - sendStart,
      });
      return { ...inputData, sendResult: { sent: true, messageId: r.messageId } };
    }

    // whatsapp
    const phone = inputData.context.contact.phone;
    if (!phone) {
      throw new Error(`Deal ${inputData.deal.id} contact sin phone para WhatsApp.`);
    }
    const templateName =
      composed.whatsappTemplateName ??
      templateNameFor(
        decision.attemptNumber,
        inputData.deal.semaforo_cotizacion,
        inputData.deal.days_in_seguimiento ?? 0,
      );
    const r = await runTool<{ messageId: string }>(
      sendWhatsAppTemplateTool,
      { phone, templateName, variables, languageCode: 'es_AR' },
      { mastra },
    );
    log?.info('sendMessage whatsapp OK', {
      dealId: inputData.deal.id,
      step: 'sendMessage',
      action: 'whatsapp',
      outcome: 'sent',
      templateName,
      messageId: r.messageId,
      durationMs: Date.now() - sendStart,
    });
    return { ...inputData, sendResult: { sent: true, messageId: r.messageId } };
  },
});

const updateHubSpotStep = createStep({
  id: 'updateHubSpot',
  description: 'Persiste estado en HubSpot — props + nota de auditoría + tasks si corresponde.',
  inputSchema: SendOutputSchema,
  outputSchema: PerDealOutcomeSchema,
  execute: async ({ inputData, mastra }) => {
    const log = mastra?.getLogger();
    const { deal, decision, composed, approval, sendResult, noContact } = inputData;
    const today = new Date();
    const todayIso = toIsoDate(today);

    type UpdatePropsInput = {
      dealId: string;
      properties: Record<string, string | number | boolean | null>;
    };
    type NoteInput = { dealId: string; title?: string; body: string };
    type TaskInput = {
      dealId: string;
      title: string;
      priority: 'LOW' | 'MEDIUM' | 'HIGH';
      body?: string;
    };

    // Caso 1: sin contacto (no_contactar)
    if (noContact) {
      await runTool<{ ok: boolean }>(
        updateDealPropertiesTool,
        { dealId: deal.id, properties: { reactivacion_estado: 'excluded' } },
        { mastra },
      );
      await runTool<{ noteId: string }>(
        addNoteToDealTool,
        {
          dealId: deal.id,
          title: '[AGENTE] Excluído de cadencia',
          body: 'Contact tiene no_contactar=true. Ningún mensaje enviado.',
        },
        { mastra },
      );
      return {
        dealId: deal.id,
        actionType: 'skip' as const,
        outcome: 'no-contact' as const,
        messageId: null,
        reason: 'Contact no_contactar=true',
      };
    }

    // Caso 2: skip por horario/feriado — reprogramar
    if (decision.actionType === 'skip') {
      const next = nextBusinessDay(today);
      await runTool<{ ok: boolean }>(
        updateDealPropertiesTool,
        { dealId: deal.id, properties: { proximo_intento_fecha: toIsoDate(next) } },
        { mastra },
      );
      log?.info('updateHubSpot skip', { dealId: deal.id, nextDate: toIsoDate(next) });
      return {
        dealId: deal.id,
        actionType: 'skip' as const,
        outcome: 'skipped' as const,
        messageId: null,
        reason: decision.reason,
      };
    }

    // Caso 3: freeze (deal grande tras 3 intentos)
    if (decision.actionType === 'freeze') {
      const futureDate = new Date(today);
      futureDate.setUTCDate(futureDate.getUTCDate() + CONFIG.FREEZE_DAYS);
      await runTool<{ ok: boolean }>(
        updateDealPropertiesTool,
        {
          dealId: deal.id,
          properties: {
            reactivacion_estado: 'frozen',
            proximo_intento_fecha: toIsoDate(futureDate),
          },
        },
        { mastra },
      );
      await runTool<{ taskId: string }>(
        createTaskForOwnerTool,
        {
          dealId: deal.id,
          title: 'Deal grande congelado. Revisar manualmente.',
          priority: 'HIGH',
          body: decision.reason,
        },
        { mastra },
      );
      await runTool<{ noteId: string }>(
        addNoteToDealTool,
        { dealId: deal.id, title: '[AGENTE] Freeze 60d', body: decision.reason },
        { mastra },
      );
      return {
        dealId: deal.id,
        actionType: 'freeze' as const,
        outcome: 'frozen' as const,
        messageId: null,
        reason: decision.reason,
      };
    }

    // Caso 4: propose-lost (deal chico tras 3 intentos)
    if (decision.actionType === 'propose-lost') {
      await runTool<{ ok: boolean }>(
        updateDealPropertiesTool,
        {
          dealId: deal.id,
          properties: {
            reactivacion_estado: 'awaiting_lost_confirmation',
            proximo_intento_fecha: null,
          },
        },
        { mastra },
      );
      await runTool<{ taskId: string }>(
        createTaskForOwnerTool,
        {
          dealId: deal.id,
          title: 'Confirmar pérdida tras 3 intentos sin respuesta.',
          priority: 'MEDIUM',
          body: decision.reason,
        },
        { mastra },
      );
      await runTool<{ noteId: string }>(
        addNoteToDealTool,
        { dealId: deal.id, title: '[AGENTE] Propuesta de pérdida', body: decision.reason },
        { mastra },
      );
      return {
        dealId: deal.id,
        actionType: 'propose-lost' as const,
        outcome: 'awaiting-lost' as const,
        messageId: null,
        reason: decision.reason,
      };
    }

    // Caso 5: rejected en aprobación humana
    if (composed && !approval.approved) {
      const tomorrow = new Date(today);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      await runTool<{ ok: boolean }>(
        updateDealPropertiesTool,
        { dealId: deal.id, properties: { proximo_intento_fecha: toIsoDate(tomorrow) } },
        { mastra },
      );
      await runTool<{ noteId: string }>(
        addNoteToDealTool,
        {
          dealId: deal.id,
          title: '[AGENTE] Rechazado en cola',
          body: 'Mensaje propuesto rechazado por revisor. Reprogramado para mañana con nueva propuesta.',
        },
        { mastra },
      );
      return {
        dealId: deal.id,
        actionType: decision.actionType,
        outcome: 'rejected' as const,
        messageId: null,
        reason: 'Rechazado en aprobación humana',
      };
    }

    // Caso 6: enviado correctamente
    if (sendResult.sent && composed) {
      const newIntento = decision.attemptNumber;
      const offsetDays = nextDelayDays(newIntento);
      const nextDate = new Date(today);
      nextDate.setUTCDate(nextDate.getUTCDate() + offsetDays);
      const nextEstado = `sent_attempt_${newIntento}` as const;

      await runTool<{ ok: boolean }>(
        updateDealPropertiesTool,
        {
          dealId: deal.id,
          properties: {
            reactivacion_estado: nextEstado,
            intento_n: newIntento,
            ultimo_intento_fecha: todayIso,
            ultimo_intento_canal: composed.channel,
            proximo_intento_fecha: toIsoDate(nextDate),
          },
        },
        { mastra },
      );

      const auditBody =
        composed.channel === 'email'
          ? `Subject: ${composed.emailSubject ?? ''}\n\n${composed.emailBody ?? ''}\n\nReasoning: ${composed.reasoning}`
          : `Template: ${composed.whatsappTemplateName ?? ''}\nVariables: ${JSON.stringify(composed.whatsappVariables ?? {})}\n\nReasoning: ${composed.reasoning}`;
      await runTool<{ noteId: string }>(
        addNoteToDealTool,
        {
          dealId: deal.id,
          title: `[AGENTE] Intento ${newIntento} enviado por ${composed.channel}`,
          body: auditBody,
        },
        { mastra },
      );

      return {
        dealId: deal.id,
        actionType: decision.actionType,
        outcome: 'sent' as const,
        messageId: sendResult.messageId,
        reason: decision.reason,
      };
    }

    // Fallback: nada se ejecutó (defensivo).
    return {
      dealId: deal.id,
      actionType: decision.actionType,
      outcome: 'skipped' as const,
      messageId: null,
      reason: 'No se ejecutó ninguna rama (revisar logs).',
    };
  },
});

// ---------------------------------------------------------------------------
// Per-deal nested workflow
// ---------------------------------------------------------------------------

/**
 * Handler de error a nivel workflow: incrementa el counter `intentos_fallidos` del
 * deal y, si supera el umbral, lo marca como `excluded` para sacarlo de la cadencia
 * (dead-letter). Evita loops infinitos sobre deals rotos.
 *
 * Se invoca cuando cualquier step del perDealWorkflow throws — el error se propaga
 * (CLAUDE.md: nunca tragar errores en silencio) pero el cron sigue con el siguiente
 * deal del foreach.
 */
async function handlePerDealError(args: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getInitData: () => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mastra?: any;
  error?: { message?: string };
}): Promise<void> {
  const init = args.getInitData() as { deal?: { id?: string; intentos_fallidos?: number } };
  const dealId = init?.deal?.id;
  const log = args.mastra?.getLogger?.();
  if (!dealId) return;

  const previous = init?.deal?.intentos_fallidos ?? 0;
  const next = previous + 1;
  const errMsg = args.error?.message ?? 'unknown error';

  log?.error?.('perDealWorkflow failed', {
    dealId,
    intentos_fallidos: next,
    error: errMsg,
  });

  try {
    if (next >= CONFIG.MAX_FAILURES_BEFORE_DEAD_LETTER) {
      await runTool<{ ok: boolean }>(
        updateDealPropertiesTool,
        {
          dealId,
          properties: {
            reactivacion_estado: 'excluded',
            intentos_fallidos: next,
            proximo_intento_fecha: null,
          },
        },
        { mastra: args.mastra },
      );
      await runTool<{ noteId: string }>(
        addNoteToDealTool,
        {
          dealId,
          title: '[AGENTE] Dead-letter — deal excluido',
          body: `El workflow falló ${next} veces consecutivas. Último error: ${errMsg}\n\nRevisar manualmente: probablemente el contact tiene datos faltantes (email, phone) o una prop está corrupta.`,
        },
        { mastra: args.mastra },
      );
      log?.warn?.('perDealWorkflow dead-lettered', { dealId, intentos_fallidos: next });
    } else {
      await runTool<{ ok: boolean }>(
        updateDealPropertiesTool,
        { dealId, properties: { intentos_fallidos: next } },
        { mastra: args.mastra },
      );
    }
  } catch (innerErr) {
    log?.error?.('handlePerDealError: incremento de counter falló', {
      dealId,
      error: (innerErr as Error).message,
    });
  }
}

/**
 * Workflow nested por-deal. Exportado para que tests de integración puedan
 * invocarlo sin pasar por la cron-scheduled workflow padre (cuyo evented engine
 * es lento de drivear desde tests).
 */
export const perDealWorkflow = createWorkflow({
  id: 'reactivacion-per-deal',
  inputSchema: PerDealInputSchema,
  outputSchema: PerDealOutcomeSchema,
  options: {
    onError: handlePerDealError,
  },
})
  .then(loadContextStep)
  .then(decideActionStep)
  .then(composeStep)
  .then(approvalGateStep)
  .then(sendStep)
  .then(updateHubSpotStep)
  .commit();

// ---------------------------------------------------------------------------
// Outer cadencia workflow + summary
// ---------------------------------------------------------------------------

const SummaryInputSchema = z.array(PerDealOutcomeSchema);
const SummaryOutputSchema = z.object({
  total: z.number(),
  byOutcome: z.record(z.string(), z.number()),
});

const summaryStep = createStep({
  id: 'summary',
  description: 'Loguea resumen del run.',
  inputSchema: SummaryInputSchema,
  outputSchema: SummaryOutputSchema,
  execute: async ({ inputData, mastra }) => {
    const log = mastra?.getLogger();
    const items = SummaryInputSchema.parse(inputData);
    const byOutcome: Record<string, number> = {};
    for (const r of items) {
      byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
    }
    log?.info('cadencia run summary', { total: items.length, byOutcome });
    return { total: items.length, byOutcome };
  },
});

export const cadenciaWorkflow = createWorkflow({
  id: 'reactivacion-cadencia',
  inputSchema: z.object({}).passthrough(),
  outputSchema: SummaryOutputSchema,
  schedule: {
    cron: CONFIG.CRON_TIME,
    timezone: CONFIG.BUSINESS_HOURS.timezone,
    inputData: {},
  },
})
  .then(fetchEligibleDealsStep)
  .map(async ({ inputData }) => {
    const parsed = FetchOutputSchema.parse(inputData);
    return parsed.deals.map((deal) => ({ deal }));
  })
  // `as never` requerido: Mastra infiere el tipo de array de `.map(...)` como
  // `unknown[]`, lo que choca con el inputSchema tipado del nested workflow.
  // El runtime valida con Zod en cada step — el cast solo destraba al type-checker.
  .foreach(perDealWorkflow as never, { concurrency: 1 })
  .then(summaryStep as never)
  .commit();
