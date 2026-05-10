/**
 * Parsers puros de payloads de webhooks. Separados de webhooks-routes.ts para
 * que sean unit-testables sin levantar el server.
 *
 * Refs:
 *  - Meta: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 *  - HubSpot: webhook subscription delivers an array of events.
 */

export type MetaInboundMessage = {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  button?: { text: string };
  interactive?: { button_reply?: { title: string }; list_reply?: { title: string } };
};

export type MetaWebhookPayload = {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: {
        messaging_product?: string;
        messages?: MetaInboundMessage[];
        statuses?: unknown[];
      };
    }>;
  }>;
};

/**
 * Extrae el texto utilizable de un mensaje WhatsApp inbound.
 * - text.body → directo
 * - button.text → reply de botón template
 * - interactive.button_reply / list_reply → reply de menú
 * - cualquier otro tipo (image, audio, location, ...) → null (no clasificable como texto)
 */
export function extractTextFromMessage(msg: MetaInboundMessage): string | null {
  if (msg.type === 'text' && msg.text?.body) return msg.text.body;
  if (msg.type === 'button' && msg.button?.text) return msg.button.text;
  if (msg.type === 'interactive') {
    return (
      msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title ?? null
    );
  }
  return null;
}

/**
 * Recorre el payload de Meta y devuelve plana la lista de mensajes inbound.
 * Ignora silenciosamente entries malformados.
 */
export function extractInboundMessages(payload: MetaWebhookPayload): MetaInboundMessage[] {
  const out: MetaInboundMessage[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const msg of change.value?.messages ?? []) out.push(msg);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Approval queue snapshot walker
// ---------------------------------------------------------------------------

export type SnapshotLike = {
  status?: string;
  context?: Record<string, unknown>;
  suspendedPaths?: Record<string, unknown>;
};

export type ApprovalQueueItem = {
  runId: string;
  workflowName: string;
  forEachIndex: number | null;
  dealId: string;
  company: string | null;
  channel: string;
  attemptNumber: number;
  reasoning: string;
  composed: unknown;
  contact: unknown;
  decision: unknown;
  createdAt: string;
};

/**
 * Walk recursivo del snapshot del run buscando step results con status='suspended'
 * y un suspendPayload que matchea el shape del approvalGateStep.
 *
 * En workflows con foreach (como cadenciaWorkflow) hay una iteración suspendida
 * por deal — devuelve un item por cada una, con su forEachIndex.
 */
export function extractApprovalItems(
  runId: string,
  workflowName: string,
  createdAt: Date,
  snapshotRaw: unknown,
): ApprovalQueueItem[] {
  const out: ApprovalQueueItem[] = [];
  const snapshot: SnapshotLike =
    typeof snapshotRaw === 'string'
      ? (JSON.parse(snapshotRaw) as SnapshotLike)
      : (snapshotRaw as SnapshotLike);

  function visit(node: unknown, foreachIdxStack: (number | null)[]): void {
    if (!node || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      node.forEach((entry, idx) => visit(entry, [...foreachIdxStack, idx]));
      return;
    }

    const obj = node as Record<string, unknown>;
    const r = obj as { status?: string; suspendPayload?: unknown };
    if (r.status === 'suspended' && r.suspendPayload) {
      const payload = r.suspendPayload as {
        dealId?: string;
        company?: string | null;
        decision?: { channel?: string; attemptNumber?: number };
        composed?: { reasoning?: string };
        contact?: unknown;
      };
      if (payload?.dealId) {
        out.push({
          runId,
          workflowName,
          forEachIndex: foreachIdxStack[foreachIdxStack.length - 1] ?? null,
          dealId: payload.dealId,
          company: payload.company ?? null,
          channel: payload.decision?.channel ?? 'unknown',
          attemptNumber: payload.decision?.attemptNumber ?? 0,
          reasoning: payload.composed?.reasoning ?? '',
          composed: payload.composed,
          contact: payload.contact,
          decision: payload.decision,
          createdAt: createdAt.toISOString(),
        });
      }
    }

    for (const v of Object.values(obj)) visit(v, foreachIdxStack);
  }

  visit(snapshot, []);
  return out;
}
