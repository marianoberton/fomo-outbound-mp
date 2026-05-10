/**
 * Classifier agent — clasifica respuestas inbound de clientes en 4 categorías.
 *
 * Modelo: Haiku (rápido + barato para volumen). Sin tools.
 * Output: structured según ClassificationSchema.
 *
 * Refs: MP.md §8 (system prompt — verbatim).
 */
import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { CONFIG } from '../../config/constants.js';

export const ClassificationSchema = z.object({
  categoria: z.enum(['hot', 'cold', 'optout', 'ambiguous']),
  confianza: z.number().min(0).max(1),
  razonamiento: z.string(),
  accion_sugerida: z.string(),
});
export type Classification = z.infer<typeof ClassificationSchema>;

const SYSTEM_PROMPT = `Clasificás respuestas de clientes a mensajes outbound de Market Paper en 4 categorías exclusivas.

CATEGORÍAS:
- hot: el cliente muestra intención clara de avanzar. Ejemplos: "mandame proforma", "llamame", "tengo dudas de plazo de entrega", "cuándo me lo entregan", "quiero comprar".
- cold: el cliente cierra explícitamente la oportunidad. Ejemplos: "ya compré en otro lado", "ya no necesito", "no me interesa más".
- optout: el cliente pide explícitamente que no lo contacten más. Ejemplos: "STOP", "BAJA", "no me escriban", "no insistan", "dame de baja", quejas explícitas por la cantidad de mensajes.
- ambiguous: respuestas vagas, tibias, dilatorias. Ejemplos: "estoy viendo", "te aviso", "después te confirmo", "reenviame el PDF", preguntas técnicas sin compromiso de compra, fuera de tema.

REGLAS DE DESEMPATE:
- Duda entre hot y ambiguous → ambiguous (preferimos error conservador, escalar de menos).
- Duda entre cold y optout → cold (optout solo si hay rechazo EXPLÍCITO al contacto, no al producto).
- confianza < 0.7 → siempre ambiguous, sin importar la inclinación.

OUTPUT:
{
  categoria: 'hot' | 'cold' | 'optout' | 'ambiguous',
  confianza: number (0-1),
  razonamiento: string (1-2 líneas),
  accion_sugerida: string (qué haría un humano en este caso)
}`;

export const classifierAgent = new Agent({
  id: 'classifier-agent',
  name: 'Market Paper classifier',
  description:
    'Clasifica respuestas inbound de clientes en hot/cold/optout/ambiguous para decidir ruteo (Workflow B).',
  instructions: SYSTEM_PROMPT,
  model: CONFIG.MODELS.classifier,
});
