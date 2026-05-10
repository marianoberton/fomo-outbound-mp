/**
 * Tipos compartidos de dominio. El schema de propiedades está en MP.md §4.
 */
import { z } from 'zod';

export const ReactivacionEstadoSchema = z.enum([
  'eligible',
  'sent_attempt_1',
  'sent_attempt_2',
  'sent_attempt_3',
  'awaiting_response',
  'active_conversation',
  'awaiting_lost_confirmation',
  'frozen',
  'won',
  'lost',
  'excluded',
]);
export type ReactivacionEstado = z.infer<typeof ReactivacionEstadoSchema>;

export const CanalSchema = z.enum(['email', 'whatsapp']);
export type Canal = z.infer<typeof CanalSchema>;

export const CanalOriginalSchema = z.enum(['email', 'whatsapp', 'manychat', 'form']);
export type CanalOriginal = z.infer<typeof CanalOriginalSchema>;

export const SemaforoSchema = z.enum(['verde', 'amarillo', 'rojo']);
export type Semaforo = z.infer<typeof SemaforoSchema>;

export const ActionTypeSchema = z.enum([
  'first-fresh',
  'first-revival',
  'next-attempt',
  'freeze',
  'propose-lost',
  'skip',
]);
export type ActionType = z.infer<typeof ActionTypeSchema>;

export const DealSchema = z.object({
  id: z.string(),
  contactId: z.string().nullable(),
  amount: z.number().nullable(),
  reactivacion_estado: ReactivacionEstadoSchema.nullable(),
  intento_n: z.number().int().min(0).max(3),
  ultimo_intento_fecha: z.string().nullable(), // ISO date
  ultimo_intento_canal: CanalSchema.nullable(),
  proximo_intento_fecha: z.string().nullable(),
  canal_original: CanalOriginalSchema.nullable(),
  semaforo_cotizacion: SemaforoSchema.nullable(),
  monto_cotizado_ars: z.number().nullable(),
  pdf_presupuesto_url: z.string().nullable(),
  /** Días que el deal lleva en stage Seguimiento. */
  days_in_seguimiento: z.number().int().min(0).nullable(),
  /** Counter de fallas consecutivas del workflow sobre este deal. */
  intentos_fallidos: z.number().int().min(0).default(0),
});
export type Deal = z.infer<typeof DealSchema>;

export const ContactSchema = z.object({
  id: z.string(),
  firstname: z.string().nullable(),
  lastname: z.string().nullable(),
  company: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  cuit: z.string().nullable(),
  no_contactar: z.boolean(),
  no_contactar_motivo: z.string().nullable(),
});
export type Contact = z.infer<typeof ContactSchema>;

export const DealContextSchema = z.object({
  deal: DealSchema,
  contact: ContactSchema,
});
export type DealContext = z.infer<typeof DealContextSchema>;

/**
 * actionTypes que el composer entiende. Subset del cuadro §6.3 — los que generan mensaje.
 * `freeze`, `propose-lost`, `skip` NO van al composer (no envían).
 */
export const ComposerActionTypeSchema = z.enum([
  'first-fresh',
  'first-revival',
  'next-attempt',
  'soft-response',
]);
export type ComposerActionType = z.infer<typeof ComposerActionTypeSchema>;

/**
 * Structured output del composer — MP.md §6.4.
 * Sólo se popula la rama del canal correspondiente.
 */
export const ComposedMessageSchema = z.object({
  channel: CanalSchema,
  emailSubject: z.string().optional(),
  emailBody: z.string().optional(),
  whatsappTemplateName: z.string().optional(),
  whatsappVariables: z.record(z.string(), z.string()).optional(),
  reasoning: z.string().describe('1-2 líneas — para auditoría humana en la nota del deal.'),
});
export type ComposedMessage = z.infer<typeof ComposedMessageSchema>;
