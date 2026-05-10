/**
 * Tests de parsing de payloads de webhooks (Meta WA + walker de approval queue).
 */
import { describe, expect, it } from 'vitest';
import {
  extractApprovalItems,
  extractInboundMessages,
  extractTextFromMessage,
  type MetaInboundMessage,
  type MetaWebhookPayload,
} from './webhook-parsing.js';

// ---------------------------------------------------------------------------
// Meta payload parsing
// ---------------------------------------------------------------------------

describe('extractTextFromMessage', () => {
  it('text → text.body', () => {
    const m: MetaInboundMessage = {
      from: '5491100000001',
      id: 'wamid.x',
      timestamp: '1700000000',
      type: 'text',
      text: { body: 'Hola, quiero comprar' },
    };
    expect(extractTextFromMessage(m)).toBe('Hola, quiero comprar');
  });

  it('button → button.text (reply de quick-reply)', () => {
    const m: MetaInboundMessage = {
      from: '5491100000001',
      id: 'wamid.x',
      timestamp: '1700000000',
      type: 'button',
      button: { text: 'Sí, avancemos' },
    };
    expect(extractTextFromMessage(m)).toBe('Sí, avancemos');
  });

  it('interactive button_reply → title', () => {
    const m: MetaInboundMessage = {
      from: '5491100000001',
      id: 'wamid.x',
      timestamp: '1700000000',
      type: 'interactive',
      interactive: { button_reply: { title: 'Confirmar' } },
    };
    expect(extractTextFromMessage(m)).toBe('Confirmar');
  });

  it('interactive list_reply → title', () => {
    const m: MetaInboundMessage = {
      from: '5491100000001',
      id: 'wamid.x',
      timestamp: '1700000000',
      type: 'interactive',
      interactive: { list_reply: { title: 'Plazo: 15 días' } },
    };
    expect(extractTextFromMessage(m)).toBe('Plazo: 15 días');
  });

  it('image (no soportado por classifier) → null', () => {
    const m: MetaInboundMessage = {
      from: '5491100000001',
      id: 'wamid.x',
      timestamp: '1700000000',
      type: 'image',
    };
    expect(extractTextFromMessage(m)).toBeNull();
  });

  it('text con body vacío → null (defensivo)', () => {
    const m: MetaInboundMessage = {
      from: '5491100000001',
      id: 'wamid.x',
      timestamp: '1700000000',
      type: 'text',
      text: { body: '' },
    };
    expect(extractTextFromMessage(m)).toBeNull();
  });
});

describe('extractInboundMessages', () => {
  const buildMessage = (id: string): MetaInboundMessage => ({
    from: '5491100000001',
    id,
    timestamp: '1700000000',
    type: 'text',
    text: { body: `msg ${id}` },
  });

  it('aplana entry → changes → messages', () => {
    const payload: MetaWebhookPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'biz1',
          changes: [
            { field: 'messages', value: { messages: [buildMessage('a'), buildMessage('b')] } },
            { field: 'messages', value: { messages: [buildMessage('c')] } },
          ],
        },
      ],
    };
    const out = extractInboundMessages(payload);
    expect(out.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('payload sin entry → []', () => {
    expect(extractInboundMessages({})).toEqual([]);
  });

  it('change sin messages (solo statuses) → []', () => {
    const payload: MetaWebhookPayload = {
      entry: [{ changes: [{ value: { statuses: [{ ok: true }] } }] }],
    };
    expect(extractInboundMessages(payload)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Approval queue snapshot walker
// ---------------------------------------------------------------------------

describe('extractApprovalItems', () => {
  const RUN_ID = 'run-abc';
  const WF_NAME = 'cadenciaWorkflow';
  const CREATED = new Date('2026-05-09T10:00:00Z');

  const suspendPayload = (dealId: string) => ({
    dealId,
    company: 'Lab Test',
    decision: { channel: 'email', attemptNumber: 1 },
    composed: { reasoning: 'mocked' },
    contact: { id: 'contact-1', email: 'a@b.com' },
  });

  it('snapshot vacío → []', () => {
    expect(extractApprovalItems(RUN_ID, WF_NAME, CREATED, {})).toEqual([]);
  });

  it('extrae 1 item de un step suspended directo', () => {
    const snap = {
      context: {
        approvalGate: { status: 'suspended', suspendPayload: suspendPayload('deal-1') },
      },
    };
    const items = extractApprovalItems(RUN_ID, WF_NAME, CREATED, snap);
    expect(items).toHaveLength(1);
    expect(items[0].dealId).toBe('deal-1');
    expect(items[0].channel).toBe('email');
    expect(items[0].forEachIndex).toBeNull();
  });

  it('foreach con 2 iteraciones suspendidas → 2 items con forEachIndex', () => {
    const snap = {
      context: {
        foreach: [
          { approvalGate: { status: 'suspended', suspendPayload: suspendPayload('deal-A') } },
          { approvalGate: { status: 'suspended', suspendPayload: suspendPayload('deal-B') } },
        ],
      },
    };
    const items = extractApprovalItems(RUN_ID, WF_NAME, CREATED, snap);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.dealId)).toEqual(['deal-A', 'deal-B']);
    expect(items.map((i) => i.forEachIndex)).toEqual([0, 1]);
  });

  it('snapshot stringificado se parsea a JSON', () => {
    const snap = JSON.stringify({
      context: {
        approvalGate: { status: 'suspended', suspendPayload: suspendPayload('deal-S') },
      },
    });
    const items = extractApprovalItems(RUN_ID, WF_NAME, CREATED, snap);
    expect(items).toHaveLength(1);
    expect(items[0].dealId).toBe('deal-S');
  });

  it('ignora suspended sin dealId en payload', () => {
    const snap = {
      context: {
        otherStep: { status: 'suspended', suspendPayload: { reason: 'unrelated' } },
      },
    };
    expect(extractApprovalItems(RUN_ID, WF_NAME, CREATED, snap)).toEqual([]);
  });

  it('ignora steps con status distinto de suspended', () => {
    const snap = {
      context: {
        running: { status: 'success', output: { dealId: 'deal-1' } },
        another: { status: 'failed', error: 'boom' },
      },
    };
    expect(extractApprovalItems(RUN_ID, WF_NAME, CREATED, snap)).toEqual([]);
  });
});
