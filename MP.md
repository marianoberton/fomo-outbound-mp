# Outbound Reactivation Agent — Market Paper

> Spec completa para implementar en **Mastra (TypeScript)**. Leé todo antes de escribir código. Las decisiones marcadas como `LOCKED` no se renegocian; las marcadas como `OPEN` se cargan como configurables.

---

## 1. Contexto de negocio

Market Paper vende cajas de packaging a medida para laboratorios y clientes B2B en Argentina. Operan con HubSpot (pipeline mayorista) y tienen un cuello de botella: **300+ deals estancados en stage "Seguimiento"** — presupuestos enviados sin resolución, ensuciando el pipeline.

**Objetivo del agente:** ejecutar una cadencia controlada de reactivación que lleve cada deal estancado a uno de tres outcomes en máximo 14 días desde el primer contacto: **ganado**, **perdido** (con confirmación humana), o **congelado** (deals grandes para retomar en 60 días).

**Filosofía clave:** el agente NO vende. Clasifica, contacta y rutea. Cuando un cliente responde, el agente decide si es señal caliente (escalar a humano) o no — pero no negocia ni cierra ventas.

---

## 2. Stack y decisiones LOCKED

| Item | Decisión |
|------|----------|
| Framework | Mastra (`@mastra/core@latest`) |
| Lenguaje | TypeScript (Node 20+) |
| Storage | LibSQL para dev, Postgres para prod (configurable vía env) |
| HubSpot | Private app token (provisto en env) |
| WhatsApp | Meta WhatsApp Business API directa |
| Email outbound | Casilla única vía HubSpot (una vendedora) |
| Cron | Diario, 9:00 ART, lunes a viernes |
| Pipeline target | Solo "mayorista" |
| Cadencia | 3 intentos: día 0 → día +4 → día +9 → revisión día +14 |
| Umbral deal grande | ≥ 5.000.000 ARS → freeze + notificación a la dueña |
| Approval gate | Activado en Fase 1 (testing), 1 sola persona aprueba |
| Backfill | 30 deals/día durante 10 días hábiles |
| Horarios envío | Lun-Vie 9-18 ART, sin feriados AR |

---

## 3. Arquitectura

Dos workflows independientes + dos agentes + tools + UI mínima de aprobación.

### Workflow A: `reactivacionCadenciaWorkflow` (cron diario)

```
[fetchEligibleDeals] → .foreach(deal):
  → loadDealContext
  → decideNextAction (.branch 5 ramas)
  → composeMessage (composerAgent)
  → approvalGate (suspend en testing)
  → sendMessage (.branch por canal)
  → updateHubSpot (props + nota)
```

### Workflow B: `respuestaClasificacionWorkflow` (event-driven via webhooks)

```
[matchToDeal] → classifyResponse (classifierAgent) → routeAction (.branch 4 ramas)
```

Categorías: `hot` (escalar) / `cold` (proponer pérdida) / `optout` (marcar no_contactar) / `ambiguous` (responder suave + seguir cadencia).

> **Fase 1**: implementar Workflow A completo + stub de Workflow B (webhooks no se conectan todavía).

---

## 4. Setup HubSpot — propiedades custom requeridas

Antes de correr código, generar (idealmente vía script con la API) estas propiedades:

### En `Deal`

| Property name | Type | Values |
|---------------|------|--------|
| `reactivacion_estado` | enum | `eligible`, `sent_attempt_1`, `sent_attempt_2`, `sent_attempt_3`, `awaiting_response`, `active_conversation`, `awaiting_lost_confirmation`, `frozen`, `won`, `lost`, `excluded` |
| `intento_n` | number | 0-3 |
| `ultimo_intento_fecha` | date | — |
| `ultimo_intento_canal` | enum | `email`, `whatsapp` |
| `proximo_intento_fecha` | date | clave: el cron lee esto |
| `canal_original` | enum | `email`, `whatsapp`, `manychat`, `form` |
| `semaforo_cotizacion` | enum | `verde`, `amarillo`, `rojo` |
| `monto_cotizado_ars` | number | umbral grande/chico |
| `pdf_presupuesto_url` | string | confirmar si ya existe; si no, crear |

### En `Contact`

| Property name | Type |
|---------------|------|
| `no_contactar` | bool |
| `no_contactar_motivo` | string |

> Crear un script `scripts/setup-hubspot-properties.ts` que cree estas propiedades de forma idempotente (skip si ya existen).

---

## 5. Estructura del proyecto Mastra

```
src/
├── mastra/
│   ├── index.ts                         # Mastra instance + cron registration
│   ├── agents/
│   │   ├── composer-agent.ts            # Sonnet
│   │   └── classifier-agent.ts          # Haiku
│   ├── workflows/
│   │   ├── cadencia-workflow.ts
│   │   └── respuesta-workflow.ts        # Stub Fase 1
│   ├── tools/
│   │   ├── hubspot-tools.ts
│   │   ├── whatsapp-tools.ts
│   │   └── email-tools.ts
│   └── server/
│       ├── approval-queue-routes.ts     # API + UI mínima
│       └── webhooks-routes.ts           # Stub Fase 1
├── lib/
│   ├── hubspot-client.ts
│   ├── meta-client.ts
│   ├── business-rules.ts                # decideNextAction logic, big-deal check
│   └── business-hours.ts                # ventanas + feriados AR
├── config/
│   └── constants.ts
├── scripts/
│   ├── setup-hubspot-properties.ts
│   └── seed-sandbox-deals.ts            # opcional, crear 5 deals fake en sandbox
├── .env.example
└── README.md
```

---

## 6. Especificación detallada — Workflow A (cadencia)

### 6.1 `fetchEligibleDealsStep`

```typescript
inputSchema: z.object({})
outputSchema: z.object({ deals: z.array(DealSchema) })
```

**Lógica:**
- Query HubSpot con: `pipelineId === MAYORISTA_ID` AND `dealStage === SEGUIMIENTO_ID` AND `proximo_intento_fecha <= hoy`.
- Para cada deal, cargar el contact asociado y filtrar `no_contactar !== true`.
- Ordenar por `proximo_intento_fecha` ascendente (atrasados primero).
- Limitar a `CONFIG.BACKFILL_DAILY_LIMIT` (default 30).

### 6.2 `loadDealContextStep`

Carga: deal completo, contact (nombre, email, teléfono, CUIT), URL del PDF, semáforo, monto, días en stage `Seguimiento` (calcular desde `entered_seguimiento_date`), historial de intentos previos (de las propiedades).

### 6.3 `decideNextActionStep` (branch crítico)

```typescript
outputSchema: z.object({
  actionType: z.enum(['first-fresh', 'first-revival', 'next-attempt', 'freeze', 'propose-lost', 'skip']),
  channel: z.enum(['email', 'whatsapp']),
  attemptNumber: z.number(),
})
```

**Reglas:**

| Estado actual | days_in_seguimiento | actionType resultante | channel |
|---------------|---------------------|----------------------|---------|
| `intento_n === 0` | < 14 | `first-fresh` | `canal_original` |
| `intento_n === 0` | ≥ 14 | `first-revival` | `canal_original` |
| `intento_n === 1` | — | `next-attempt` | canal alterno al último |
| `intento_n === 2` | — | `next-attempt` | volver a `canal_original` |
| `intento_n === 3` AND monto ≥ 5M | — | `freeze` | (no envía) |
| `intento_n === 3` AND monto < 5M | — | `propose-lost` | (no envía) |

**Skip conditions** (devuelven `actionType='skip'`, no envía nada y avanza `proximo_intento_fecha` al siguiente día hábil): fuera de horario / día no laborable / feriado AR.

### 6.4 `composeMessageStep` (agente)

Llamar al `composerAgent` con structured output. Si `actionType === 'freeze'` o `'propose-lost'`, **NO** llamar al composer — saltar a `updateHubSpot`.

```typescript
inputSchema (al agente): { dealContext, actionType, channel, attemptNumber, semaforo }

structuredOutput schema:
z.object({
  channel: z.enum(['email', 'whatsapp']),
  emailSubject: z.string().optional(),
  emailBody: z.string().optional(),
  whatsappTemplateName: z.string().optional(),
  whatsappVariables: z.record(z.string()).optional(),
  reasoning: z.string(), // para auditoría en la nota
})
```

### 6.5 `approvalGateStep`

```typescript
if (CONFIG.APPROVAL_MODE === 'on') {
  return await suspend({
    dealId, channel, composedMessage, attemptNumber, dealOwnerName
  })
}
// resumeData: { approved: boolean, edits?: { subject?, body?, variables? } }
```

Si `approved === false` → cortar el branch, marcar deal con nota "rechazado en cola por usuario", correr `proximo_intento_fecha = today + 1` para reintentar al día siguiente con nuevo mensaje.

Si `edits` viene, usar el texto editado tal cual sin volver a llamar al composer.

### 6.6 `sendMessageStep`

```typescript
.branch([
  [({ inputData }) => inputData.channel === 'email', sendEmailStep],
  [({ inputData }) => inputData.channel === 'whatsapp', sendWhatsAppStep],
])
```

**Importante WhatsApp:** siempre usar `sendWhatsAppTemplate` para outbound porque casi siempre estamos fuera de la ventana de 24h. Las plantillas las registra el cliente en Meta Business Manager — el código debe leer el nombre desde config.

### 6.7 `updateHubSpotStep`

- Update deal:
  - `intento_n = intento_n + 1`
  - `ultimo_intento_fecha = now`
  - `ultimo_intento_canal = channel`
  - `reactivacion_estado = sent_attempt_${intento_n}`
  - `proximo_intento_fecha = now + nextDelay(intento_n)` donde `nextDelay`: 1→4d, 2→5d, 3→5d (revisión humana día +14)
- Add timeline note:
  - Title: `"[AGENTE] Intento ${n} enviado por ${channel}"`
  - Body: `subject + body + reasoning del agente` (legible para humano)
- Si `actionType === 'freeze'`:
  - `reactivacion_estado = frozen`
  - `proximo_intento_fecha = now + 60d`
  - `createTaskForOwner` con: "Deal grande congelado. Revisar manualmente." priority=HIGH
- Si `actionType === 'propose-lost'`:
  - `reactivacion_estado = awaiting_lost_confirmation`
  - `createTaskForOwner` con: "Confirmar pérdida tras 3 intentos sin respuesta." priority=MEDIUM
  - `proximo_intento_fecha = null`

---

## 7. Especificación — Workflow B (respuesta) [STUB EN FASE 1]

Implementar la estructura, pero **sin conectar webhooks**. Dejar las routes `/webhooks/whatsapp` y `/webhooks/hubspot-email` listas pero respondiendo 200 + log "TODO Fase 2".

Schemas y branches de routing definidos para que en Fase 2 sea solo enchufar los webhooks de Meta y HubSpot.

---

## 8. Agentes — system prompts

### `composerAgent`

- Modelo: `anthropic/claude-sonnet-4-5` (o el último Sonnet disponible al momento de implementar)
- Sin tools. Recibe todo el contexto en el prompt.
- Structured output como en 6.4.

```
Sos el agente compositor de mensajes outbound de Market Paper, una empresa B2B argentina que vende cajas a medida para laboratorios y clientes industriales.

CONTEXTO QUE RECIBÍS POR REQUEST:
- Datos del cliente (nombre, empresa, CUIT si tiene)
- Resumen del presupuesto (productos, monto, URL del PDF)
- actionType: first-fresh | first-revival | next-attempt | soft-response
- attemptNumber: 1 | 2 | 3
- channel: email | whatsapp
- semaforo: verde (precio competitivo) | amarillo (medio) | rojo (alto)
- daysSinceLastContact

REGLAS DE TONO:
- Email: tratamiento "usted", profesional, conciso. 4-6 líneas máximo en el cuerpo. Subject claro, ≤50 caracteres.
- WhatsApp: tratamiento "vos", profesional pero más cálido. Mensajes cortos. Las plantillas tienen variables limitadas — usá los slots provistos.

REGLAS POR TIPO DE ACCIÓN:
- first-fresh: natural y suave. Referenciá el presupuesto explícitamente, mencioná el PDF. "Le escribimos para retomar..." o equivalente.
- first-revival: reconocé el tiempo pasado. "Vimos que su presupuesto quedó pendiente desde hace un tiempo, queríamos saber si todavía es de su interés."
- next-attempt (intento 2): más directo. Ofrecé aclarar dudas, plazos de entrega, condiciones de pago.
- next-attempt (intento 3): tono de cierre del ciclo. Binario: "¿avanzamos o cerramos esto por ahora? Cualquier respuesta nos ayuda."
- soft-response (Workflow B): respondé al mensaje del cliente con info útil, no empujes.

REGLAS POR SEMÁFORO:
- Verde: sin incentivo. Mensajes neutros y directos.
- Amarillo (intento 2 o 3): podés mencionar "tenemos flexibilidad en condiciones de pago si lo necesita".
- Rojo (intento 2 o 3): podés decir "si la propuesta económica no encaja, podemos revisarla juntos para ver si hay margen". ESTO DISPARA QUE LA DUEÑA TOME EL CASO — no estás ofreciendo descuento concreto, estás abriendo la conversación.

PROHIBIDO:
- Inventar datos, plazos, stock, precios.
- Ofrecer descuentos numéricos o porcentajes específicos.
- Mencionar competidores.
- Usar emojis.
- Hacer promesas que no podés sostener.
- Inventar urgencias falsas ("solo por hoy", "última oportunidad real").

OUTPUT: JSON estructurado según schema. En el campo `reasoning`, explicá en 1-2 líneas qué estrategia usaste y por qué — esto va a auditoría humana.
```

### `classifierAgent`

- Modelo: `anthropic/claude-haiku-4-5` (rápido + barato para volumen)
- Sin tools. Solo clasifica.

```
Clasificás respuestas de clientes a mensajes outbound de Market Paper en 4 categorías exclusivas.

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
}
```

---

## 9. Tools

Crear con `createTool` de Mastra, schemas Zod, errores propagados (no swallow).

### HubSpot (`hubspot-tools.ts`)

- `listEligibleDeals(date: Date, limit: number) → Deal[]`
- `getDealContext(dealId: string) → FullContext`
- `updateDealProperties(dealId: string, props: Partial<DealProps>)`
- `addNoteToDeal(dealId: string, body: string, metadata?: object)`
- `createTaskForOwner(dealId: string, title: string, priority: 'LOW'|'MEDIUM'|'HIGH', body?: string)`
- `setContactDoNotContact(contactId: string, value: boolean, reason?: string)`

Usar el SDK oficial `@hubspot/api-client` o REST directo. Wrap en cliente singleton con retry exponencial para 429/500.

### WhatsApp Meta (`whatsapp-tools.ts`)

- `sendWhatsAppTemplate(phone: string, templateName: string, variables: Record<string,string>) → { messageId }`
- `sendWhatsAppFreeForm(phone: string, text: string) → { messageId }` — internamente verifica que estamos dentro de ventana 24h, si no, **lanza error** (no fallback silencioso).

> Las plantillas se registran manualmente en Meta Business Manager. El código solo invoca por nombre. Documentar en README los nombres esperados: `mp_intento1_fresh`, `mp_intento1_revival`, `mp_intento2_neutral`, `mp_intento2_amarillo`, `mp_intento2_rojo`, `mp_intento3_cierre`. En Fase 1 el composer puede generar nombres y variables esperando que el cliente los registre antes de producción.

### Email (`email-tools.ts`)

- `sendEmailViaHubspot(toContactId: string, subject: string, htmlBody: string) → { messageId }` — usa la HubSpot Marketing/Transactional Email API o Single Send API con la casilla única configurada.

---

## 10. Approval queue UI (Fase 1, descartable)

Servir desde el server de Mastra:

- `GET /approval-queue` → HTML simple con tabla: dealId, owner, canal, mensaje propuesto, botones [Aprobar] [Editar] [Rechazar].
- `POST /approval-queue/:runId/approve` → llama `run.resume({ resumeData: { approved: true } })`.
- `POST /approval-queue/:runId/edit` → recibe `{ subject?, body? }` y resume con `{ approved: true, edits: ... }`.
- `POST /approval-queue/:runId/reject` → resume con `{ approved: false }`.

**Auth:** middleware que valida header `Authorization: Bearer ${process.env.APPROVAL_QUEUE_TOKEN}`. Un solo token. UI lo pide la primera vez y lo guarda en localStorage.

**Fuente de la cola:** listar workflow runs en estado `suspended` desde el storage de Mastra (`mastra.getWorkflow('reactivacionCadenciaWorkflow').listSuspendedRuns()` o equivalente — consultar API actual de Mastra).

UI: HTML + vanilla JS, sin build step. Estilo mínimo. No hace falta ser linda — esto se apaga en 2 semanas.

---

## 11. Configuración

### `src/config/constants.ts`

```typescript
export const CONFIG = {
  CADENCE_DAYS: {
    ATTEMPT_2_OFFSET: 4,    // días desde intento 1 hasta intento 2
    ATTEMPT_3_OFFSET: 9,    // días desde intento 1 hasta intento 3
    FINAL_REVIEW_OFFSET: 14 // días totales desde intento 1 hasta cierre
  },
  BIG_DEAL_THRESHOLD_ARS: 5_000_000,
  FREEZE_DAYS: 60,
  BACKFILL_DAILY_LIMIT: 30,
  BUSINESS_HOURS: {
    start: 9,
    end: 18,
    timezone: 'America/Argentina/Buenos_Aires',
    skipWeekends: true,
  },
  APPROVAL_MODE: (process.env.APPROVAL_MODE ?? 'on') as 'on' | 'off',
  CRON_TIME: '0 9 * * 1-5', // 9:00 lunes-viernes ART
  WHATSAPP_TEMPLATES: {
    intento1_fresh: 'mp_intento1_fresh',
    intento1_revival: 'mp_intento1_revival',
    intento2_neutral: 'mp_intento2_neutral',
    intento2_amarillo: 'mp_intento2_amarillo',
    intento2_rojo: 'mp_intento2_rojo',
    intento3_cierre: 'mp_intento3_cierre',
  },
}
```

### `.env.example`

```
ANTHROPIC_API_KEY=
HUBSPOT_PRIVATE_APP_TOKEN=
HUBSPOT_PIPELINE_MAYORISTA_ID=
HUBSPOT_STAGE_SEGUIMIENTO_ID=
HUBSPOT_DEAL_OWNER_ID=
HUBSPOT_SALES_INBOX_ID=
META_WHATSAPP_PHONE_ID=
META_WHATSAPP_ACCESS_TOKEN=
META_WEBHOOK_VERIFY_TOKEN=
APPROVAL_QUEUE_TOKEN=
APPROVAL_MODE=on
DATABASE_URL=file:./local.db
PORT=4111
```

### Feriados Argentina

Usar paquete `date-holidays` con país `'AR'`. Cargar al boot, exponer función `isHoliday(date: Date): boolean` desde `business-hours.ts`.

---

## 12. Fase 1 — Entregables de esta build

Implementar en este orden:

1. **Setup base**: `npm create mastra@latest`, instalar deps, estructura de carpetas, env vars, README inicial.
2. **HubSpot tools + script de setup de propiedades** (correr el script al final de Fase 1 contra sandbox).
3. **WhatsApp + Email tools** (clientes + funciones de envío con stubs si no hay credenciales aún para correr local).
4. **Composer agent** con structured output completo y los 6 actionTypes.
5. **Cadencia workflow** con todos los steps, branches, y manejo de skip por horario/feriado.
6. **Approval queue UI + API** funcionando end-to-end con `suspend/resume`.
7. **Classifier agent + respuesta workflow stub** (estructura, sin webhooks).
8. **Seed script** para crear 5 deals fake en sandbox de HubSpot, en distintos estados de la cadencia.
9. **README final** con: setup HubSpot (correr script de propiedades), registrar plantillas en Meta (con nombres esperados), env vars necesarios, cómo correr local, cómo testear el flujo end-to-end con `APPROVAL_MODE=on`.
10. **Tests unitarios** mínimos: `decideNextAction` con todos los casos del cuadro en 6.3.

**Fuera de scope Fase 1:**
- Deploy a producción (más adelante).
- Webhooks reales conectados (Fase 2).
- Métricas / dashboard.
- Calendario de feriados custom (usar `date-holidays` AR estándar por ahora).
- Activación del workflow B contra mensajes reales.

---

## 13. Testing strategy

### Unit
- `business-rules.decideNextAction`: cubrir las 5 ramas + skip por horario.
- `business-hours.isWithinBusinessHours`: lunes 10am ✓, sábado 10am ✗, feriado ✗, lunes 22:00 ✗.

### Integration
- HubSpot sandbox con 5 deals seed en estados {fresh, revival, intento1-enviado, intento2-enviado, intento3-pendiente-cierre}.
- Correr el workflow con `APPROVAL_MODE=off` y validar que avanza correctamente cada deal.

### Manual smoke
- `APPROVAL_MODE=on` + 1 deal en sandbox.
- Avanzar el deal manualmente por los 3 intentos, validando aprobación, edición y rechazo en la UI.
- Revisar las notas en HubSpot — deben ser legibles para humano.

---

## 14. Items abiertos (no bloquean Fase 1)

- **OPEN**: Confirmar que `pdf_presupuesto_url` ya existe como propiedad en HubSpot (el usuario lo confirmará al estar online). Si no existe, agregarla al script de setup.
- **OPEN**: Nombre exacto del stage "Seguimiento" y del pipeline "mayorista" en HubSpot. El usuario los provee. Mientras tanto, el código los lee de `process.env`.
- **OPEN**: Categoría Meta de cada plantilla (UTILITY vs MARKETING). Documentarlo en README; el cliente decide al registrarlas.
- **OPEN**: Definir el dueño exacto al que se asignan las tasks de "deal grande congelado" — `HUBSPOT_DEAL_OWNER_ID` lo configura, pero por ahora hardcoded a la dueña.
- **OPEN**: Lógica para inferir `canal_original` si no está cargado en deals legacy. Default sugerido: si tiene email pero no teléfono → email; si tiene teléfono → whatsapp; si ambos → email para deals con CUIT (más formal), whatsapp si no.

---

## 15. Notas finales para Claude Code

- **Idempotencia**: el cron puede correr 2 veces el mismo día por error. Cada step debe ser idempotente o detectar duplicados (ej: no enviar mismo intento dos veces — chequear `ultimo_intento_fecha === today` antes de enviar).
- **Logs**: usá `PinoLogger` de Mastra. Cada acción del workflow log a nivel info con `{ dealId, step, action, outcome }`. Errores a nivel error con stack trace.
- **Concurrency**: el `.foreach` puede correr serial — no necesitamos paralelizar 30 deals (HubSpot rate limits + estabilidad importan más que velocidad).
- **Observabilidad**: dejá hooks listos para agregar telemetría (Langfuse o OpenTelemetry) en Fase 3, no implementar todavía.
- **Documentación inline**: cada step y tool con un comentario JSDoc breve explicando qué hace y qué decisiones de negocio refleja.

Si tenés cualquier ambigüedad mientras implementás, **preguntá antes de asumir** — el negocio es delicado (si el agente manda mal mensajes a clientes B2B, quema relaciones). Es preferible parar y consultar que entregar algo y rehacer.

Una vez todos los pasos de la sección 12 estén listos: corré los tests, levantá el server local, mostrá la UI de aprobación con un deal seed avanzando por la cadencia. Ahí cerramos Fase 1.