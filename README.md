# outbound-mp

Agente de reactivación outbound para **Market Paper**. Construido con [Mastra](https://mastra.ai) en TypeScript.

Spec completo: ver [`MP.md`](./MP.md).

> **Estado**: Fase 2. Workflow A (cadencia) + Workflow B (respuestas inbound) wiredos end-to-end. `APPROVAL_MODE=on` por default. Webhooks reales (Meta + HubSpot) con verificación de firma.

---

## Quickstart

```bash
npm install
cp .env.example .env
# Editar .env con credenciales reales (o dejar vacío para correr en STUB_MODE)
npm run dev
```

`mastra dev` levanta el server + Mastra Studio en `http://localhost:4111`.

### Modo stub

Si `HUBSPOT_PRIVATE_APP_TOKEN` está vacío o `STUB_MODE=true`, las tools de HubSpot/Meta no llaman APIs reales — devuelven mocks coherentes con log claro. Útil para validar el flujo end-to-end sin credenciales. **El composer agent sí necesita `OPENAI_API_KEY`** para correr el LLM.

---

## Setup HubSpot

### 1. Crear las propiedades custom

Una vez cargado `HUBSPOT_PRIVATE_APP_TOKEN`:

```bash
npm run setup:hubspot
```

Crea idempotentemente las propiedades de Deal y Contact (ver `MP.md` §4). Re-correr el script es seguro — saltea las que ya existen.

### 2. Identificar pipeline y stage

En HubSpot, copiar:
- ID del pipeline "mayorista" → `HUBSPOT_PIPELINE_MAYORISTA_ID`
- ID del stage "Seguimiento" → `HUBSPOT_STAGE_SEGUIMIENTO_ID`
- ID de la owner del flujo (la dueña que recibe tasks) → `HUBSPOT_DEAL_OWNER_ID`

### 3. Template transaccional para emails

El agente envía emails vía Single Send API. Crear en HubSpot un template transaccional que use los merge tags:

- `{{ custom.subject_override }}` → en el subject
- `{{ custom.body_override }}` → en el body (con HTML libre)

Copiar el ID numérico del template → `HUBSPOT_TRANSACTIONAL_EMAIL_ID`.

### 4. Sandbox de prueba

```bash
npm run seed:sandbox
```

Crea 5 deals en distintos estados de la cadencia (fresh, revival, intento1, intento2, intento3-pendiente) con sus contactos asociados. Las propiedades quedan en `proximo_intento_fecha = hoy`, así el cron los recoge inmediatamente.

---

## Plantillas WhatsApp (Meta Business Manager)

El cliente registra manualmente las siguientes plantillas en Meta Business Manager. El código las invoca por nombre — si una falta, el envío falla con error claro de Meta.

| Nombre esperado | Uso | Categoría sugerida |
|---|---|---|
| `mp_intento1_fresh` | Primer contacto, deal con < 14 días en seguimiento | UTILITY |
| `mp_intento1_revival` | Primer contacto, deal con ≥ 14 días en seguimiento | UTILITY |
| `mp_intento2_neutral` | Segundo intento, semáforo verde | UTILITY |
| `mp_intento2_amarillo` | Segundo intento, precio medio (menciona flexibilidad de pago) | UTILITY |
| `mp_intento2_rojo` | Segundo intento, precio alto (abre conversación con dueña) | UTILITY |
| `mp_intento3_cierre` | Tercer intento, tono binario "avanzamos o cerramos" | UTILITY |

Las variables `{{1}}, {{2}}, ...` del cuerpo se mapean por el composer en el orden de las keys del objeto `whatsappVariables` (`'1' → {{1}}`, `'2' → {{2}}`, ...). Categoría exacta UTILITY vs MARKETING la elige el cliente al registrar.

---

## Variables de entorno

Ver [`.env.example`](./.env.example). Las claves necesarias:

| Variable | Para qué |
|---|---|
| `OPENAI_API_KEY` | composer + classifier |
| `HUBSPOT_PRIVATE_APP_TOKEN` | todas las llamadas a HubSpot |
| `HUBSPOT_PIPELINE_MAYORISTA_ID` | filtrar deals elegibles |
| `HUBSPOT_STAGE_SEGUIMIENTO_ID` | filtrar deals elegibles + calcular `days_in_seguimiento` |
| `HUBSPOT_DEAL_OWNER_ID` | dueño de las tasks (freeze, propose-lost, hot) |
| `HUBSPOT_TRANSACTIONAL_EMAIL_ID` | template para Single Send API |
| `META_WHATSAPP_PHONE_ID` + `META_WHATSAPP_ACCESS_TOKEN` | envío WhatsApp |
| `META_WEBHOOK_VERIFY_TOKEN` | handshake del webhook |
| `META_APP_SECRET` | verificación firma `x-hub-signature-256` |
| `HUBSPOT_APP_SECRET` | verificación firma `X-HubSpot-Signature-v3` |
| `APPROVAL_QUEUE_TOKEN` | header Bearer para la UI de aprobación |
| `APPROVAL_MODE` | `on` (suspend antes de enviar) o `off` (envía directo) |
| `DATABASE_URL` | LibSQL local (`file:./local.db`) o Postgres en prod |

---

## Conectar webhooks (Fase 2)

Los webhooks disparan **Workflow B** (clasificación de respuestas) cuando un cliente responde a un mensaje del agente.

### URL pública

`mastra dev` corre en `localhost:4111`. Para que Meta y HubSpot puedan llegar, expone el server con un túnel — por ejemplo `ngrok http 4111` o `cloudflared tunnel`. Vas a obtener una URL HTTPS pública (`https://xxx.ngrok-free.app`).

### WhatsApp (Meta Business Manager)

1. **App secret**: en la consola de Meta → tu App → Settings → Basic → "App Secret" → copiá a `META_APP_SECRET`.
2. **Verify token**: elegí cualquier string secreto y poné el mismo valor en `META_WEBHOOK_VERIFY_TOKEN` (env del server) y en el campo "Verify Token" del webhook config en Meta.
3. **Callback URL**: `https://<tu-url-publica>/webhooks/whatsapp`.
4. **Subscribe to fields**: marcá `messages`. Opcionalmente `message_status` si querés tracking de delivery.
5. Meta te hará un GET handshake al endpoint — si los tokens coinciden, queda activo.

El webhook valida la firma `x-hub-signature-256` con tu `META_APP_SECRET`. Mensajes de tipo `text`, `button` e `interactive` (button_reply / list_reply) se procesan; los otros se ignoran con log.

### HubSpot (App webhook subscription)

HubSpot webhooks **requieren una Public App** (no funcionan con un Private App por sí solos). Pasos:

1. **Crear Public App** en tu cuenta HubSpot (developers.hubspot.com).
2. En la app → "Webhooks" → URL: `https://<tu-url-publica>/webhooks/hubspot-email`.
3. **Suscribirse a** `engagement.creation` (o `email.creation` si tu cuenta lo usa). Filtrar por `hs_email_direction = INCOMING_EMAIL` si la API lo permite, si no, el código filtra al cargar el engagement.
4. **App secret**: en la app → "Auth" → "Client Secret" → copiá a `HUBSPOT_APP_SECRET`.
5. Instalar la public app en el portal del cliente para que los webhooks empiecen a llegar.

El webhook valida `X-HubSpot-Signature-v3` con tu `HUBSPOT_APP_SECRET` y rechaza eventos con timestamp > 5 min de desfasaje (anti-replay).

### Cómo funciona end-to-end

1. Cliente responde a un mensaje del agente (vía WhatsApp o email).
2. Meta / HubSpot envían el evento al webhook.
3. Server verifica firma → parsea → busca el deal activo del contacto (lookup por phone o email).
4. Persiste `wa_last_inbound_at` en el contact (si es WA) — habilita futuras respuestas free-form en la ventana de 24h.
5. Dispara `respuestaWorkflow` con `{ dealId, contactId, channel, body, receivedAt }`.
6. El classifier agent clasifica en hot / cold / optout / ambiguous.
7. Según la categoría: escalar (hot), proponer pérdida (cold), marcar no-contactar (optout) o dejar nota (ambiguous).

### Testing del webhook localmente

Con `STUB_MODE=true`, el lookup devuelve `null` por default y el workflow no se dispara — útil para testear el verifier de firma sin tocar HubSpot. Para forzar un disparo en stub, llamar el workflow directo desde Mastra Studio con un input fabricado.

---

## Aprobación humana (Fase 1)

Con `APPROVAL_MODE=on`, antes de cada envío el workflow se suspende.

Abrir `http://localhost:4111/approval-queue`:

- Pide el token la primera vez (lo guarda en `localStorage`)
- Lista cada deal pendiente con: empresa, dealId, canal, intento, mensaje propuesto, reasoning del composer
- Botones: **Aprobar** / **Editar** (subject/body para email, JSON de variables para whatsapp) / **Rechazar**
- Refresca cada 30s

Internamente, el listado lee runs `suspended` del workflow `reactivacion-cadencia`, walk del snapshot para extraer cada `suspendPayload` por iteración del foreach. Cada acción llama `run.resume({ resumeData, forEachIndex })` con la decisión humana.

---

## Observabilidad

Mastra trackea cada workflow run, agent generate y tool call como spans estructurados. La config vive en `src/mastra/observability.ts`.

### Layers activos

- **DefaultExporter** (siempre): persiste traces en el storage de Mastra. Visibles desde **Mastra Studio** en `/`.
- **LangfuseExporter** (opcional): si `LANGFUSE_PUBLIC_KEY` y `LANGFUSE_SECRET_KEY` están seteadas, también empuja a [Langfuse](https://langfuse.com) — útil para production: dashboards, costos por LLM call, búsqueda de traces.
- **SensitiveDataFilter**: redacta automáticamente los campos sensibles antes de exportar.

### Qué se redacta

Los defaults de Mastra cubren `password`, `token`, `secret`, `key`, `apikey`, `auth`, `bearer`, `jwt`, `credential`, `clientsecret`, `privatekey`, `refresh`, `ssn`. Sumamos PII del proyecto:

- `email`, `phone`, `cuit`
- `access_token`, `verify_token`, `app_secret`
- `private_app_token`, `meta_whatsapp_access_token`, `hubspot_private_app_token`

Modo de redacción: `partial` — muestra los primeros 3 + últimos 3 caracteres del valor, redacta el medio. Útil para confirmar identidad sin exponer el dato completo.

### Cómo conectar Langfuse

```bash
# 1. Crear proyecto en https://cloud.langfuse.com (o self-hosted)
# 2. Copiar las keys del proyecto a .env:
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_ENVIRONMENT=production
# 3. Restart del server
npm run dev
```

A partir del próximo workflow run vas a ver:
- Trace por run con timeline de cada step + duration
- Spans del composer/classifier con prompt + response (PII redactada)
- Costos por LLM call (Langfuse calcula con los tokens de cada provider)
- Tags y filtros por `environment`, `serviceName`, etc.

Si `LANGFUSE_PUBLIC_KEY` no está, el exporter no se monta — sin overhead.

### Mastra Studio (siempre disponible)

Aunque no tengas Langfuse, abrir `http://localhost:4111/` durante `npm run dev` te muestra:
- Lista de workflow runs (success / failed / suspended)
- Graph view por run con cada step y su output
- Schedules con next fire / pause control

Studio lee del DefaultExporter — todo trace queda persistido localmente sin configuración extra.

---

## Deploy a producción

### Build y run con Docker

```bash
docker build -t outbound-mp .
docker run --rm -p 4111:4111 --env-file .env outbound-mp
```

El build es multi-stage. La imagen final corre `node index.mjs` desde el bundle self-contained que produce `mastra build`. Healthcheck integrado contra `/health` cada 30s.

**Crítico:** el cron del workflow A vive en un `setInterval` del scheduler de Mastra. Necesita un host long-lived — Fly Machines, Railway, Render, ECS, GKE, o tu propio server. **No funciona en FaaS** (Lambda, Vercel Functions, Cloudflare Workers): el proceso se apaga entre requests y el `setInterval` se pierde.

### Storage en producción

LibSQL local (`file:./local.db`) sirve para dev. En prod usar **Postgres** para tener concurrent updates correctos (el evented engine que activa el cron lo requiere y soporta multi-instance).

```bash
DATABASE_URL=postgres://user:pass@host:5432/db
```

`src/mastra/index.ts` selecciona el adapter automáticamente según el prefijo de `DATABASE_URL`:

| Prefijo | Adapter | Uso |
|---|---|---|
| `file:` | `LibSQLStore` | dev local |
| `libsql://` | `LibSQLStore` | Turso hosted |
| `postgres://` o `postgresql://` | `PostgresStore` | producción |

`@mastra/pg` ya está en `dependencies` — no hay que instalar nada extra.

### Variables de entorno críticas en prod

Repaso de las que sí o sí tienen que estar setteadas:

```
OPENAI_API_KEY=
HUBSPOT_PRIVATE_APP_TOKEN=
HUBSPOT_PIPELINE_MAYORISTA_ID=
HUBSPOT_STAGE_SEGUIMIENTO_ID=
HUBSPOT_DEAL_OWNER_ID=
HUBSPOT_TRANSACTIONAL_EMAIL_ID=
META_WHATSAPP_PHONE_ID=
META_WHATSAPP_ACCESS_TOKEN=
META_APP_SECRET=
META_WEBHOOK_VERIFY_TOKEN=
HUBSPOT_APP_SECRET=
APPROVAL_QUEUE_TOKEN=
APPROVAL_MODE=on        # mantener ON al menos las primeras 2 semanas
DATABASE_URL=postgres://...
STUB_MODE=false
STUB_SEND=false
```

Correr `npm run preflight` en el servidor de prod después del primer deploy para validar que todo conecta.

### Healthcheck

`GET /health` devuelve `{ ok, version, uptimeSeconds, storage }` con status 200 si el storage responde, 503 si no. Sin auth (para load balancer).

### Operaciones — runbook

**Pausar el cron sin redeploy.** Si el agente está mandando algo raro, paralo inmediatamente desde otro proceso:

```typescript
import { MastraClient } from '@mastra/client-js';
const client = new MastraClient({ baseUrl: 'https://tu-host' });
await client.pauseSchedule('wf_reactivacion-cadencia');
// arreglás lo que sea, después:
await client.resumeSchedule('wf_reactivacion-cadencia');
```

`pauseSchedule` es durable — sobrevive restarts. `resumeSchedule` recomputa `nextFireAt` desde ahora, no dispara backlog.

**Disparar manualmente la cadencia.** Por ejemplo si un deal se quedó atascado y querés reprocesarlo hoy:

```typescript
const wf = mastra.getWorkflow('cadenciaWorkflow');
const run = await wf.createRun();
await run.start({ inputData: {} });
```

(O desde Mastra Studio: `/workflows/reactivacion-cadencia/run` con input `{}`.)

**Forzar un deal específico.** Setear `proximo_intento_fecha = hoy` en HubSpot y esperar al próximo cron, o dispararlo manualmente como arriba.

**Aprobar/rechazar mensajes en cola.** Abrir `/approval-queue` con el `APPROVAL_QUEUE_TOKEN` configurado.

### Troubleshooting común

| Síntoma | Causa probable | Acción |
|---|---|---|
| `/health` 503 | Storage caído o `DATABASE_URL` mal | Validar conectividad Postgres / migrations |
| Cron no dispara | Schedule pausado o adapter sin concurrent updates | `client.resumeSchedule(...)` o cambiar storage adapter |
| Webhook 401 | App secret mal configurado o body modificado por proxy | Confirmar que el proxy no transforma el body (signatures usan raw bytes) |
| Composer agent OOM o timeout | Prompt demasiado largo | Revisar el contexto del deal (PDF URL ok, no estás pegando el PDF entero) |
| Mensaje WhatsApp `131026` | Template no aprobado o categoría incorrecta en Meta | Re-registrar en Business Manager |
| Mensajes que no se envían pero el workflow dice "sent" | `STUB_SEND=true` heredado en prod | Verificar env vars; `STUB_MODE=false` y no tener `STUB_SEND` ni `STUB_MODE` en `true` |

---

## Trigger manual

Para forzar el workflow sobre un deal específico (sin esperar al cron, sin tocar `proximo_intento_fecha`):

```bash
npm run trigger -- --deal=12345
SMOKE_REAL_SEND=true npm run trigger -- --deal=12345    # mandar de verdad
```

Default: `APPROVAL_MODE=off`, `STUB_SEND=true`, HubSpot real. Útil durante testing manual o para forzar un re-procesamiento.

---

## Dead-letter (deals que fallan repetidamente)

Cada deal tiene un counter `intentos_fallidos`. Si el `perDealWorkflow` falla, `onError` lo incrementa. Tras `MAX_FAILURES_BEFORE_DEAD_LETTER` (default 5) fallos consecutivos, el deal se marca `excluded`, se le borra el `proximo_intento_fecha` (no se vuelve a procesar) y se agrega una nota `[AGENTE] Dead-letter — deal excluido` con el último error.

Esto evita loops infinitos sobre deals con datos rotos (contact sin email/teléfono, propiedades corruptas, etc.). Para sacar un deal del dead-letter manualmente: setear `intentos_fallidos=0` y `reactivacion_estado=eligible` desde HubSpot.

---

## Métricas operacionales

```bash
npm run metrics                                  # ventana default: 30d
npm run metrics -- --since 7d
npm run metrics -- --since all
npm run metrics -- --since 7d --json             # JSON para pipear
npm run metrics -- --since 7d --include-classifier   # suma rates hot/cold/optout/ambiguous
```

### Classifier rates

Con `--include-classifier`, el script también lee los notes con título `[CLASSIFIER] <categoria>` (que el `respuestaWorkflow` deja en cada deal cuando llega una respuesta inbound) y reporta la distribución hot / cold / optout / ambiguous + counts. Útil para ver si el agente está dejando pasar muchos optouts (señal de fatiga) o si las respuestas son mayormente ambiguas (señal de que el composer no está siendo claro).

### Reporte semanal automático

El workflow `metricas-semanal` corre solo los **lunes 9:00 ART**, agrega los últimos 7 días y loguea el reporte. Si está seteado `SLACK_WEBHOOK_URL`, también lo postea al canal con bloques formatteados.

Reporta sobre todos los deals del pipeline mayorista (no filtrado por stage para capturar `won`/`lost` también):

- **Funnel**: counts por estado (`eligible`, `sent_attempt_1..3`, `awaiting_response`, `active_conversation`, `awaiting_lost_confirmation`, `frozen`, `won`, `lost`, `excluded`).
- **Tasas** (sobre el universo de contactados, no sobre el total):
  - `engagement` = respondieron (active_conversation + awaiting_lost + won)
  - `winRate`, `freezeRate`, `optoutRate`
- **Monto ARS** ganado / perdido / congelado / in-flight.

La ventana se aplica sobre `ultimo_intento_fecha`. Deals que nunca recibieron un intento (intento_n=0) no entran en el filtro temporal — no aportan a tasas de conversión.

---

## Backfill de `canal_original` (deals legacy)

Si entrás con 300+ deals existentes que nunca tuvieron `canal_original` cargado, este script lo infiere desde el contact y lo persiste:

```bash
npm run backfill:canal              # dry-run, no escribe
npm run backfill:canal -- --apply   # aplica los cambios
```

Reglas (MP.md §14 OPEN):
- solo email → `email`
- solo phone → `whatsapp`
- email + phone + CUIT → `email` (cliente formal)
- email + phone (sin CUIT) → `whatsapp`
- sin email ni phone → no inferable (logea para revisión manual)

El script imprime un line-by-line por deal procesado y un resumen final con los totales por canal inferido + errores + sin-contacto.

---

## Pre-flight + Smoke test

Antes de poner el agente vivo, dos scripts validan que todo está bien cableado.

### `npm run preflight`

Read-only, no muta nada. Chequea:

- Env vars requeridas y opcionales
- HubSpot: token válido, pipeline + stage existen, deal owner existe, las 12 propiedades custom están creadas, template transaccional reachable
- OpenAI: GET /v1/models para validar la API key
- Meta WhatsApp: GET sobre el `phone_id` para validar token + pareja

Output: tabla con `✓ OK / ✗ FAIL / ! WARN / · SKIP` por check. Exit code 0 si todo pasó, 1 si hay fail.

### `npm run smoke`

E2E real contra HubSpot sandbox. **Requiere** que pongas un email + teléfono que controles:

```bash
SMOKE_CONTACT_EMAIL=tu-email@ejemplo.com SMOKE_CONTACT_PHONE=+5491100000099 npm run smoke
```

Lo que hace:

1. Crea (o recicla, idempotente) un contact + deal smoke con estado controlado: `intento_n=0`, semáforo verde, canal email, `proximo_intento_fecha=hoy`.
2. Dispara `cadenciaWorkflow` programáticamente (`APPROVAL_MODE=off` para no quedar suspendido).
3. Verifica que tras correr, el deal tiene: `reactivacion_estado=sent_attempt_1`, `intento_n=1`, `ultimo_intento_fecha=hoy`, `ultimo_intento_canal=email`, `proximo_intento_fecha=hoy+4d`.
4. Verifica que se agregó la nota `[AGENTE] Intento 1 enviado por email`.

**Por default `STUB_SEND=true`** — HubSpot real, mensaje stubeado (no manda email). Para validar también el send real:

```bash
SMOKE_REAL_SEND=true SMOKE_CONTACT_EMAIL=... npm run smoke
```

Si tu cuenta de HubSpot tiene otros deals con `proximo_intento_fecha=hoy`, el workflow los va a procesar también. Por eso es **imprescindible** correrlo contra sandbox, no producción.

---

## Cómo testear el flujo end-to-end

### Modo stub (sin credenciales)

```bash
APPROVAL_MODE=on npm run dev
```

En Mastra Studio (`/`), invocar el workflow `reactivacion-cadencia` con input `{}`. La tool `listEligibleDeals` devuelve 2 deals stub, el composer corre (necesita `OPENAI_API_KEY`), y el workflow suspende esperando aprobación. Verificar la UI en `/approval-queue`.

### Modo sandbox (HubSpot real, WhatsApp/email stub)

1. Setear `HUBSPOT_PRIVATE_APP_TOKEN` + IDs de pipeline/stage en `.env`
2. `npm run setup:hubspot` (una sola vez)
3. `npm run seed:sandbox` (crea 5 deals fake)
4. `STUB_MODE=true APPROVAL_MODE=on npm run dev`
5. Disparar `reactivacion-cadencia` desde Studio
6. Aprobar en `/approval-queue`
7. Verificar que las propiedades de los deals se actualizaron en HubSpot + las notas aparecen en el timeline

### Modo full (producción)

Requiere todas las credenciales más:
- Plantillas WhatsApp registradas en Meta Business Manager
- Template transaccional creado en HubSpot

---

## Tests

```bash
npm test            # vitest run
npm run test:watch  # modo watch
```

Cobertura actual:
- `decideNextAction` — todas las ramas del cuadro §6.3 + skip por horario + idempotencia + inferCanalOriginal
- `isWithinBusinessHours` — lunes 10am ✓, sábado ✗, feriado AR ✗, lunes 22:00 ✗
- `isWeekend`, `originalToChannel`, mapeos de canal por intento
- `verifyMetaSignature` y `verifyHubspotSignature` — firmas válidas/inválidas, body tampering, timestamp viejo
- `metrics` — agregación por estado, tasas, montos ARS, parser de ventana temporal
- **Integration test** del `perDealWorkflow` — 3 escenarios E2E con stub HubSpot/Meta + composer mockeado, sin credenciales
- **Classifier eval** — 17 casos reales de hot/cold/optout/ambiguous; skipean automáticamente sin `OPENAI_API_KEY`. Para correrlos: `OPENAI_API_KEY=sk-... npm test -- classifier`.

---

## Estructura del proyecto

```
src/
├── mastra/
│   ├── index.ts                      # Mastra instance (agents + workflows + storage + apiRoutes + observability)
│   ├── observability.ts              # DefaultExporter + Langfuse opcional + redacción PII
│   ├── agents/
│   │   ├── composer-agent.ts         # Sonnet — compone mensajes outbound
│   │   └── classifier-agent.ts       # Haiku — clasifica respuestas (Workflow B)
│   ├── workflows/
│   │   ├── cadencia-workflow.ts      # Workflow A — cron 9:00 ART lun-vie
│   │   ├── respuesta-workflow.ts     # Workflow B — clasificación de respuestas inbound
│   │   └── metricas-semanal-workflow.ts  # Reporte semanal lunes 9 ART (Slack opcional)
│   ├── tools/
│   │   ├── hubspot-tools.ts          # 6 tools del §9
│   │   ├── whatsapp-tools.ts         # template + free-form (con check 24h)
│   │   └── email-tools.ts            # Single Send API
│   └── server/
│       ├── ops-routes.ts             # /health (Fase 4 — deploy)
│       ├── approval-queue-routes.ts  # UI + API de aprobación humana
│       └── webhooks-routes.ts        # WhatsApp + HubSpot inbound (Fase 2)
├── lib/
│   ├── hubspot-client.ts             # singleton + retry exponencial 429/5xx
│   ├── meta-client.ts                # WhatsApp Cloud API v20
│   ├── retry.ts                      # withRetry compartido
│   ├── business-rules.ts             # decideNextAction (cuadro §6.3)
│   ├── business-hours.ts             # ventanas + feriados AR (date-holidays)
│   ├── webhook-verify.ts             # HMAC-SHA256 Meta + HubSpot v3
│   ├── inbound-lookup.ts             # phone/email → deal+contact activos
│   ├── metrics.ts                    # agregación pura para reportes
│   └── types.ts                      # schemas Zod compartidos
├── config/
│   └── constants.ts                  # CONFIG con decisiones LOCKED + STUB_MODE
└── scripts/
    ├── setup-hubspot-properties.ts   # crea 10 props de Deal + 3 de Contact
    ├── seed-sandbox-deals.ts         # 5 deals fake en distintos estados
    ├── preflight.ts                  # valida config + conectividad (read-only)
    ├── smoke.ts                      # E2E real contra sandbox
    ├── trigger.ts                    # fuerza per-deal workflow sobre 1 deal
    ├── backfill-canal-original.ts    # infiere canal_original sobre deals legacy
    └── metrics.ts                    # reporte funnel + tasas + ARS
src/lib/
├── business-rules.test.ts            # tests colocados al lado del archivo
├── business-hours.test.ts
└── webhook-verify.test.ts
```

---

## Items abiertos (no bloquean Fase 1)

Ver `MP.md` §14:

- **OPEN**: confirmar que `pdf_presupuesto_url` no existía como propiedad antes (el script lo crea de todas formas — idempotente).
- **OPEN**: nombre exacto del stage "Seguimiento" y pipeline "mayorista" — los lee de env.
- **OPEN**: categoría Meta de cada plantilla — el cliente decide al registrar.
- **OPEN**: lógica para inferir `canal_original` en deals legacy (sin la prop seteada). Hoy `decideNextAction` usa email como default si está null. Si querés inferir de email/teléfono, agregar en `business-rules.originalToChannel`.

---

## Out of scope (próximas fases)

- Calendario de feriados custom (hoy usa `date-holidays` AR estándar)
- Métricas / dashboard custom (Langfuse + Studio cubren el 80% — métricas custom solo si las querés)

---

## Decisiones técnicas a recordar

- **Idempotencia**: el cron puede correr 2 veces el mismo día. `decideNextAction` es determinística; `updateHubSpot` es safe-by-replace. Si querés blindarlo más, chequear `ultimo_intento_fecha === hoy` antes de enviar.
- **Concurrency**: `.foreach({ concurrency: 1 })` — secuencial por estabilidad y rate limits.
- **Logs**: PinoLogger de Mastra; cada step logea `{ dealId, step, action, outcome }`.
- **Retry**: HubSpot client wrappea cada llamada con backoff exponencial (500ms, 1s, 2s, 4s) sobre 429/5xx.
- **Modelos**: composer = `openai/gpt-5.5`, classifier = `openai/gpt-5.4-nano`. Verificados contra el provider registry de Mastra al implementar.
