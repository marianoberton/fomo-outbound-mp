# CLAUDE.md

Este archivo lo lee Claude Code automáticamente al abrir el repo. Contiene reglas del proyecto, skills disponibles y dónde encontrar la spec completa.

---

## Proyecto

**Outbound Reactivation Agent — Market Paper.** Agente que ejecuta una cadencia controlada de reactivación de deals estancados en HubSpot (pipeline mayorista, stage "Seguimiento") con tres intentos de contacto por WhatsApp y/o Email, y los lleva a ganado / perdido / congelado.

**Spec completa y autoritativa:** `MP.md` en la raíz del repo. Leé ese archivo entero antes de escribir código. Si algo de este `CLAUDE.md` parece contradecir la spec, gana la spec.

---

## Skills disponibles

Tenés disponible el **skill de Mastra** (framework TypeScript para agentes y workflows). Es la base sobre la que se construye este proyecto.

Cuándo usarlo:
- **Siempre** que vayas a tocar `src/mastra/agents/`, `src/mastra/workflows/`, `src/mastra/tools/` o `src/mastra/server/`.
- Antes de instanciar `new Agent()`, `new Mastra()`, `createTool()`, `createWorkflow()` o `createStep()`.
- Antes de configurar memoria, structured output, suspend/resume, branches, foreach, parallel, o el cron del Mastra server.
- Antes de exponer custom routes desde el server de Mastra (la UI de aprobación las necesita).

Cómo invocarlo:
- Lee la documentación del skill antes de implementar el primer agente, el primer workflow, y la primera custom route. No asumas APIs de memoria sin chequear.

Otros skills que **no aplican** a este proyecto (mencionados solo para descartar):
- `docx`, `pptx`, `xlsx`, `pdf`: este proyecto no genera documentos. El PDF del presupuesto ya viene cargado por otro sistema en el deal de HubSpot — solo lo referenciamos por URL.
- `frontend-design`: la UI de aprobación es deliberadamente mínima y descartable (HTML + vanilla JS, sin build step). No se aplica el sistema de diseño completo.

---

## Reglas del proyecto

### Lenguaje y stack
- **TypeScript estricto.** `strict: true` en `tsconfig.json`. Sin `any` salvo justificación en comentario.
- **Node 20+.** Usá `import` ESM, no CommonJS.
- **Mastra es la única abstracción de agentes.** No traer LangChain, LlamaIndex, ni otros frameworks de agentes en paralelo.
- **Validación con Zod.** Todos los schemas de tools, steps y structured outputs van en Zod.

### Reglas de negocio (no negociables sin avisar)
- El agente **NO ofrece descuentos numéricos ni porcentajes específicos**. Solo abre la conversación cuando el semáforo es rojo, para que la dueña tome el caso.
- El agente **NO negocia** respuestas calientes. Las clasifica y escala.
- Los deals ≥ 5.000.000 ARS **nunca** se marcan como perdidos automáticamente. Van a `frozen` y se notifica a la dueña.
- Toda transición a `lost` requiere confirmación humana vía task en HubSpot.
- Solo se contacta dentro de horario laboral argentino (Lun-Vie 9-18 ART, sin feriados AR).
- Si un contact tiene `no_contactar=true`, **nunca** se le envía nada — chequeo en el primer step de cada workflow.

### Idempotencia
- El cron puede correr dos veces el mismo día por error operacional. Cada step debe detectar duplicados (ej: si `ultimo_intento_fecha === today`, no reenviar).
- Los scripts de setup (propiedades HubSpot, seed de deals) deben ser idempotentes: si la propiedad ya existe, skip sin error.

### Errores y robustez
- **Nunca tragar errores en silencio.** Cualquier fallo de HubSpot o Meta API se loggea con stack y se propaga. El cron sigue con el siguiente deal del foreach.
- **Reintentos con backoff exponencial** para 429 y 5xx en HubSpot y Meta (3 intentos, base 1s).
- **Dentro/fuera ventana 24h de WhatsApp:** `sendWhatsAppFreeForm` tira error si está fuera; nunca hace fallback silencioso a template. El workflow elige explícitamente cuál llamar.

### Seguridad
- **Nunca hardcodear** tokens, IDs de pipeline, IDs de stage, ni números de teléfono. Todo va por env.
- El `APPROVAL_QUEUE_TOKEN` es el único auth de la UI de aprobación — tratarlo como password.
- No loggear el contenido completo de tokens ni de PII (emails y teléfonos sí están OK porque son operacionales y van a HubSpot).

### Logs
- Usar `PinoLogger` de Mastra.
- Formato estructurado: `{ workflowRun, dealId, step, action, outcome, durationMs }`.
- Nivel `info` para acciones normales, `warn` para skips esperables (fuera de horario, no_contactar), `error` para fallos.

---

## Workflow de implementación esperado

Seguí el orden de la sección 12 de la spec (Fase 1 — Entregables). Avisá al usuario cuando termines cada paso antes de avanzar al siguiente, especialmente:
- Después de configurar HubSpot tools (paso 2): para que el usuario corra el script de propiedades contra sandbox.
- Después del composer agent (paso 4): para review humano del prompt antes de seguir.
- Después de cadencia workflow (paso 5): para validar la lógica de `decideNextAction` con los tests del paso 10.

Si encontrás ambigüedad en la spec, **preguntá antes de asumir**. El negocio es B2B con clientes existentes — un mensaje mal mandado quema relación. Es preferible pausar y consultar que entregar y rehacer.

---

## Convenciones de código

- **Nombres de archivos:** kebab-case (`composer-agent.ts`, `cadencia-workflow.ts`).
- **Nombres de exports:** camelCase para variables/funciones, PascalCase para tipos y clases.
- **Un agente, un archivo.** Un workflow, un archivo. Las tools relacionadas pueden agruparse (`hubspot-tools.ts` exporta varias).
- **Comentarios JSDoc** breves en cada export público explicando qué hace y qué regla de negocio refleja.
- **Tests** en `src/**/*.test.ts` colocados al lado del archivo testeado, ejecutables con `npm test`.

---

## Comandos útiles esperados

El `package.json` final debe exponer al menos:

- `npm run dev` — server local con hot reload.
- `npm test` — corre vitest en modo single-run.
- `npm run setup:hubspot` — script de creación de propiedades custom contra el HubSpot del env actual (idempotente).
- `npm run seed:sandbox` — script que crea 5 deals fake en sandbox para testing manual.
- `npm run build` — compila TS a `dist/`.

---

## Items abiertos al inicio del proyecto

Los lista la sección 14 de la spec. No bloquean el arranque pero conviene tenerlos a la vista mientras implementás — algunos los va a ir cerrando el usuario en paralelo.