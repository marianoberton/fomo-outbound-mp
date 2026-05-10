/**
 * Constantes de negocio y configuración runtime.
 * Las decisiones LOCKED de MP.md §2 viven acá. Cambiar algo implica editar este archivo, no env.
 */

export const CONFIG = {
  CADENCE_DAYS: {
    /** días desde intento 1 hasta intento 2 */
    ATTEMPT_2_OFFSET: 4,
    /** días desde intento 1 hasta intento 3 */
    ATTEMPT_3_OFFSET: 9,
    /** días totales desde intento 1 hasta cierre/revisión humana */
    FINAL_REVIEW_OFFSET: 14,
  },
  /** Umbral en ARS: deals ≥ esto se congelan en lugar de proponer pérdida tras 3 intentos. */
  BIG_DEAL_THRESHOLD_ARS: 5_000_000,
  /** Días que un deal queda congelado antes de re-encolarse (deals grandes). */
  FREEZE_DAYS: 60,
  /** Cuántos deals procesa el cron por día (backfill controlado). */
  BACKFILL_DAILY_LIMIT: 30,
  /**
   * Tras N fallos consecutivos del workflow sobre el mismo deal, el deal se marca
   * `excluded` y se saca de la cadencia (dead-letter). Evita loops infinitos sobre
   * deals con datos rotos (contact sin email/teléfono, prop corrupta, etc.).
   */
  MAX_FAILURES_BEFORE_DEAD_LETTER: 5,
  BUSINESS_HOURS: {
    start: 9,
    end: 18,
    timezone: 'America/Argentina/Buenos_Aires',
    skipWeekends: true,
  },
  /** 'on' = suspend antes de enviar para aprobación humana (Fase 1). */
  APPROVAL_MODE: (process.env.APPROVAL_MODE ?? 'on') as 'on' | 'off',
  /** Cron: 9:00 ART, lunes a viernes. */
  CRON_TIME: '0 9 * * 1-5',
  /**
   * Nombres de templates registradas en Meta Business Manager.
   * El cliente las registra; el código solo invoca por nombre.
   */
  WHATSAPP_TEMPLATES: {
    intento1_fresh: 'mp_intento1_fresh',
    intento1_revival: 'mp_intento1_revival',
    intento2_neutral: 'mp_intento2_neutral',
    intento2_amarillo: 'mp_intento2_amarillo',
    intento2_rojo: 'mp_intento2_rojo',
    intento3_cierre: 'mp_intento3_cierre',
  },
  MODELS: {
    composer: 'anthropic/claude-sonnet-4-6',
    classifier: 'anthropic/claude-haiku-4-5',
  },
} as const;

/**
 * Stub mode: cuando faltan credenciales reales, las tools devuelven mocks con log claro.
 * Activable explícitamente vía env, o se infiere si las env vars críticas están vacías.
 *
 * STUB_MODE controla el cliente HubSpot. STUB_SEND controla envíos outbound (Meta + email)
 * y por default sigue a STUB_MODE — pero el smoke test lo toma desacoplado, así puede
 * verificar contra HubSpot real sin mandar mensajes reales.
 */
export const STUB_MODE =
  (process.env.STUB_MODE ?? 'true').toLowerCase() === 'true' ||
  !process.env.HUBSPOT_PRIVATE_APP_TOKEN;

export const STUB_SEND = process.env.STUB_SEND
  ? process.env.STUB_SEND.toLowerCase() === 'true'
  : STUB_MODE;
