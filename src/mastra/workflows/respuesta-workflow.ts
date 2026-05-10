/**
 * Workflow B — clasificación de respuestas inbound.
 *
 * **STUB EN FASE 1**: la estructura está definida pero los webhooks NO se conectan.
 * Las routes /webhooks/* responden 200 + log "TODO Fase 2".
 * Cuando los webhooks de Meta y HubSpot estén listos, este workflow se invoca con
 * `{ dealId, contactId, channel, body, receivedAt }` y rutea según la categoría.
 *
 * Refs: MP.md §3, §7.
 */
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { isValidationError } from '@mastra/core/tools';
import { z } from 'zod';
import { ClassificationSchema } from '../agents/classifier-agent.js';
import { CanalSchema } from '../../lib/types.js';
import {
  addNoteToDealTool,
  createTaskForOwnerTool,
  setContactDoNotContactTool,
  updateDealPropertiesTool,
} from '../tools/hubspot-tools.js';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const InputSchema = z.object({
  dealId: z.string(),
  contactId: z.string(),
  channel: CanalSchema,
  body: z.string().describe('texto del mensaje inbound del cliente'),
  receivedAt: z.string().describe('ISO timestamp'),
});

const MatchedSchema = InputSchema.extend({
  matched: z.boolean(),
});

const ClassifiedSchema = MatchedSchema.extend({
  classification: ClassificationSchema,
});

const RoutedOutputSchema = z.object({
  dealId: z.string(),
  category: ClassificationSchema.shape.categoria,
  routed: z.enum(['hot-escalate', 'cold-propose-lost', 'optout-mark', 'ambiguous-soft-reply', 'unmatched']),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Helper compartido — ver cadencia-workflow.ts para la justificación del `any`.
 */
async function runTool<O>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool: { execute?: (input: any, ctx: any) => Promise<unknown> },
  input: unknown,
  ctx: { mastra?: unknown },
): Promise<O> {
  if (!tool.execute) throw new Error('Tool sin execute().');
  const result = await tool.execute(input, ctx);
  if (isValidationError(result)) throw new Error(`Tool validation error: ${result.message}`);
  return result as O;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

const matchToDealStep = createStep({
  id: 'matchToDeal',
  description:
    'Verifica que el dealId+contactId existan y estén en cadencia activa. En Fase 1 trust el caller (webhook).',
  inputSchema: InputSchema,
  outputSchema: MatchedSchema,
  execute: async ({ inputData, mastra }) => {
    const log = mastra?.getLogger();
    log?.info('matchToDeal', { dealId: inputData.dealId, channel: inputData.channel });
    return { ...inputData, matched: true };
  },
});

const classifyStep = createStep({
  id: 'classifyResponse',
  description: 'Llama al classifierAgent con el texto inbound.',
  inputSchema: MatchedSchema,
  outputSchema: ClassifiedSchema,
  execute: async ({ inputData, mastra }) => {
    const agent = mastra?.getAgent('classifierAgent');
    if (!agent) throw new Error('classifierAgent no registrado en Mastra.');
    const resp = await agent.generate(inputData.body, {
      structuredOutput: { schema: ClassificationSchema },
    });
    const classification = resp.object as z.infer<typeof ClassificationSchema>;
    mastra?.getLogger()?.info('classifyResponse OK', {
      dealId: inputData.dealId,
      categoria: classification.categoria,
      confianza: classification.confianza,
    });
    return { ...inputData, classification };
  },
});

const routeStep = createStep({
  id: 'routeAction',
  description: 'Aplica la acción según la categoría: hot/cold/optout/ambiguous.',
  inputSchema: ClassifiedSchema,
  outputSchema: RoutedOutputSchema,
  execute: async ({ inputData, mastra }) => {
    const log = mastra?.getLogger();
    const { dealId, contactId, classification } = inputData;
    const cat = classification.categoria;

    // Nota uniforme para todas las categorías → permite agregación de métricas
    // del classifier por simple grep sobre titles `[CLASSIFIER] <cat>`.
    await runTool<{ noteId: string }>(
      addNoteToDealTool,
      {
        dealId,
        title: `[CLASSIFIER] ${cat}`,
        body: `Mensaje cliente: ${inputData.body}\n\nRazonamiento: ${classification.razonamiento}\nConfianza: ${classification.confianza}\nAcción sugerida: ${classification.accion_sugerida}`,
      },
      { mastra },
    );

    if (cat === 'hot') {
      // Escalar a humano: pausar cadencia + crear task urgente.
      await runTool<{ ok: boolean }>(
        updateDealPropertiesTool,
        {
          dealId,
          properties: { reactivacion_estado: 'active_conversation', proximo_intento_fecha: null },
        },
        { mastra },
      );
      await runTool<{ taskId: string }>(
        createTaskForOwnerTool,
        {
          dealId,
          title: 'Cliente respondió interesado — tomá la conversación.',
          priority: 'HIGH',
          body: `Razonamiento clasificador: ${classification.razonamiento}\n\nMensaje cliente: ${inputData.body}`,
        },
        { mastra },
      );
      log?.info('routeAction hot', { dealId });
      return { dealId, category: cat, routed: 'hot-escalate' as const };
    }

    if (cat === 'cold') {
      await runTool<{ ok: boolean }>(
        updateDealPropertiesTool,
        {
          dealId,
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
          dealId,
          title: 'Cliente cerró: confirmar pérdida.',
          priority: 'MEDIUM',
          body: `Mensaje cliente: ${inputData.body}\n\nRazonamiento: ${classification.razonamiento}`,
        },
        { mastra },
      );
      log?.info('routeAction cold', { dealId });
      return { dealId, category: cat, routed: 'cold-propose-lost' as const };
    }

    if (cat === 'optout') {
      await runTool<{ ok: boolean }>(
        setContactDoNotContactTool,
        {
          contactId,
          value: true,
          reason: `Optout vía ${inputData.channel}: ${inputData.body.slice(0, 200)}`,
        },
        { mastra },
      );
      await runTool<{ ok: boolean }>(
        updateDealPropertiesTool,
        {
          dealId,
          properties: { reactivacion_estado: 'excluded', proximo_intento_fecha: null },
        },
        { mastra },
      );
      log?.info('routeAction optout', { dealId, contactId });
      return { dealId, category: cat, routed: 'optout-mark' as const };
    }

    // ambiguous: la cadencia sigue activa; la nota [CLASSIFIER] ambiguous ya quedó arriba.
    log?.info('routeAction ambiguous', { dealId });
    return { dealId, category: cat, routed: 'ambiguous-soft-reply' as const };
  },
});

// ---------------------------------------------------------------------------
// Workflow B (sin schedule — invocado por webhooks en Fase 2)
// ---------------------------------------------------------------------------

export const respuestaWorkflow = createWorkflow({
  id: 'respuesta-clasificacion',
  inputSchema: InputSchema,
  outputSchema: RoutedOutputSchema,
})
  .then(matchToDealStep)
  .then(classifyStep)
  .then(routeStep)
  .commit();
