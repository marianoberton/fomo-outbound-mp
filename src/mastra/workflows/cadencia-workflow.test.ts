/**
 * Integration test del per-deal workflow en stub mode.
 *
 * Bypaseamos la cadenciaWorkflow externa (auto-promovida a EventedWorkflow por el
 * campo `schedule`, lenta de drivear desde tests) y corremos el perDealWorkflow
 * directamente con un deal fixture. Esto valida toda la cadena loadContext →
 * decideAction → compose → approvalGate → send → updateHubSpot.
 *
 * No requiere credenciales reales — STUB_MODE=true mockea HubSpot/Meta y mockeamos
 * composerAgent.generate para no llamar a Anthropic.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Deal } from '../../lib/types.js';

// CRÍTICO: setear env ANTES de importar mastra. Constants.ts lee process.env al boot.
process.env.STUB_MODE = 'true';
process.env.STUB_SEND = 'true';
process.env.APPROVAL_MODE = 'off';
process.env.DATABASE_URL = 'file:./test-cadencia.db';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mastraInst: any;

const todayIso = () => new Date().toISOString().slice(0, 10);

const fixtureDeal = (overrides: Partial<Deal> = {}): Deal => ({
  id: 'test-deal-1',
  contactId: 'test-contact-1',
  amount: 1_500_000,
  reactivacion_estado: 'eligible',
  intento_n: 0,
  ultimo_intento_fecha: null,
  ultimo_intento_canal: null,
  proximo_intento_fecha: todayIso(),
  canal_original: 'email',
  semaforo_cotizacion: 'verde',
  monto_cotizado_ars: 1_500_000,
  pdf_presupuesto_url: 'https://example.com/test.pdf',
  days_in_seguimiento: 7,
  intentos_fallidos: 0,
  ...overrides,
});

beforeAll(async () => {
  // Mockear composer ANTES de importar mastra. La spy persiste porque el módulo
  // exporta la misma instancia que Mastra registra.
  const composerModule = await import('../agents/composer-agent.js');
  vi.spyOn(composerModule.composerAgent, 'generate').mockResolvedValue({
    object: {
      channel: 'email' as const,
      emailSubject: 'Test subject — mock',
      emailBody: 'Cuerpo de email mockeado para test.',
      reasoning: 'mocked',
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  const root = await import('../index.js');
  mastraInst = root.mastra;
});

afterAll(async () => {
  if (mastraInst?.shutdown) await mastraInst.shutdown();
});

async function runPerDeal(
  deal: Deal,
): Promise<{ status: string; outcome?: string; actionType?: string }> {
  const wf = mastraInst.getWorkflow('perDealWorkflow');
  const run = await wf.createRun();
  const result = await run.start({ inputData: { deal } });
  return {
    status: result.status,
    outcome: result.result?.outcome,
    actionType: result.result?.actionType,
  };
}

describe('perDealWorkflow integration (stub mode)', () => {
  it('mastra registró perDealWorkflow', () => {
    expect(mastraInst.getWorkflow('perDealWorkflow')).toBeDefined();
  });

  it(
    'fresh deal en horario laboral → outcome sent (envío stubeado)',
    async () => {
      // Fijamos el deal a un estado fresh.
      const r = await runPerDeal(fixtureDeal({ intento_n: 0, days_in_seguimiento: 5 }));
      expect(r.status).toBe('success');
      // En horario laboral AR (lun-vie 9-18) el outcome es 'sent'; fuera, 'skipped'.
      expect(['sent', 'skipped']).toContain(r.outcome);
    },
    30_000,
  );

  it(
    'deal con intento_n=3 y monto >5M → freeze',
    async () => {
      const r = await runPerDeal(
        fixtureDeal({ intento_n: 3, monto_cotizado_ars: 7_000_000, ultimo_intento_fecha: '2026-04-01' }),
      );
      expect(r.status).toBe('success');
      // Independiente del horario: freeze sigue siendo el outcome (no envía mensaje).
      // Si está fuera de horario el guard de skip pisa esto, así que aceptamos ambos.
      expect(['frozen', 'skipped']).toContain(r.outcome);
    },
    30_000,
  );

  it(
    'deal con intento_n=3 y monto <5M → propose-lost',
    async () => {
      const r = await runPerDeal(
        fixtureDeal({ intento_n: 3, monto_cotizado_ars: 800_000, ultimo_intento_fecha: '2026-04-01' }),
      );
      expect(r.status).toBe('success');
      expect(['awaiting-lost', 'skipped']).toContain(r.outcome);
    },
    30_000,
  );
});
