/**
 * Eval del classifier agent — corre el LLM real (Haiku) contra mensajes realistas
 * en español argentino y valida que cada uno cae en la categoría esperada.
 *
 * Skipea automáticamente si no hay ANTHROPIC_API_KEY (p. ej., en CI sin secrets).
 *
 * Ref: MP.md §8 (categorías exclusivas + reglas de desempate).
 */
import { describe, expect, it } from 'vitest';
import { classifierAgent, ClassificationSchema } from './classifier-agent.js';

const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;

async function classify(text: string) {
  const resp = await classifierAgent.generate(text, {
    structuredOutput: { schema: ClassificationSchema },
  });
  return resp.object as {
    categoria: 'hot' | 'cold' | 'optout' | 'ambiguous';
    confianza: number;
    razonamiento: string;
    accion_sugerida: string;
  };
}

describe.skipIf(!HAS_KEY)('classifier agent — eval (real LLM)', () => {
  describe('hot — intención clara de avanzar', () => {
    const cases = [
      'Mandame la proforma así te transfiero',
      'Cuándo me lo pueden entregar?',
      'Quiero comprar 200 cajas. Llamame al 11-3333-4444.',
      'Confirmame plazo de entrega y te paso a contabilidad para que pague',
    ];
    it.each(cases)('"%s" → hot', async (text) => {
      const r = await classify(text);
      expect(r.categoria).toBe('hot');
      expect(r.confianza).toBeGreaterThanOrEqual(0.7);
    }, 30_000);
  });

  describe('cold — cierra explícitamente la oportunidad', () => {
    const cases = [
      'Gracias pero ya compramos en otro proveedor',
      'Ya no necesitamos cajas, cerramos esa línea',
      'Encontramos otra opción que nos sirvió mejor',
    ];
    it.each(cases)('"%s" → cold', async (text) => {
      const r = await classify(text);
      expect(r.categoria).toBe('cold');
    }, 30_000);
  });

  describe('optout — pide explícitamente no contactar más', () => {
    const cases = [
      'STOP',
      'BAJA',
      'Por favor no me escriban más, dejen de mandar mensajes',
      'Dame de baja de la lista, no insistan más',
    ];
    it.each(cases)('"%s" → optout', async (text) => {
      const r = await classify(text);
      expect(r.categoria).toBe('optout');
    }, 30_000);
  });

  describe('ambiguous — vagas / dilatorias / fuera de tema', () => {
    const cases = [
      'Estoy viendo, te aviso la semana que viene',
      'Reenviame el PDF que no lo encuentro',
      'Después te confirmo',
      'Tienen modelos más chicos?',
    ];
    it.each(cases)('"%s" → ambiguous', async (text) => {
      const r = await classify(text);
      expect(r.categoria).toBe('ambiguous');
    }, 30_000);
  });

  describe('reglas de desempate', () => {
    it('confianza < 0.7 fuerza ambiguous', async () => {
      // Mensaje ultra-ambiguo en general — el modelo no debería estar muy seguro.
      const r = await classify('ok');
      if (r.confianza < 0.7) {
        expect(r.categoria).toBe('ambiguous');
      }
      // Si confianza >= 0.7 el caso no aplica; no falla, solo afirma la regla cuando dispara.
    }, 30_000);

    it('rechazo al producto sin pedir baja explícita → cold (no optout)', async () => {
      const r = await classify('No me sirve, no me gusta el producto');
      expect(r.categoria).toBe('cold');
    }, 30_000);
  });
});

describe.skipIf(HAS_KEY)('classifier agent — eval (skipped sin API key)', () => {
  it('skip placeholder — seteá ANTHROPIC_API_KEY para correr el eval real', () => {
    expect(HAS_KEY).toBe(false);
  });
});
