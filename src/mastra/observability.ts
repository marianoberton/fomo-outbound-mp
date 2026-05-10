/**
 * Configuración de observabilidad para Mastra.
 *
 * Layers:
 *  - DefaultExporter: siempre activo, persiste traces al storage de Mastra (Studio los lee).
 *  - LangfuseExporter: opcional, activado si LANGFUSE_PUBLIC_KEY está seteado.
 *  - SensitiveDataFilter: redacta tokens, emails, teléfonos, CUIT antes de exportar.
 *
 * Refs: MP.md §15 (hint de Langfuse / OpenTelemetry).
 */
import { DefaultExporter, Observability, SensitiveDataFilter } from '@mastra/observability';
import { LangfuseExporter } from '@mastra/langfuse';
import type { ObservabilityExporter, SpanOutputProcessor } from '@mastra/core/observability';

const SERVICE_NAME = 'outbound-mp';

/**
 * Campos PII y secretos custom que queremos redactar además de los defaults
 * (que ya cubren password, token, secret, key, apikey, auth, bearer, etc.).
 */
const EXTRA_SENSITIVE_FIELDS = [
  'email',
  'phone',
  'cuit',
  'access_token',
  'verify_token',
  'app_secret',
  'private_app_token',
  'meta_whatsapp_access_token',
  'hubspot_private_app_token',
];

export function buildObservability(): Observability {
  const exporters: ObservabilityExporter[] = [new DefaultExporter()];

  const langfusePub = process.env.LANGFUSE_PUBLIC_KEY;
  const langfuseSec = process.env.LANGFUSE_SECRET_KEY;
  if (langfusePub && langfuseSec) {
    exporters.push(
      new LangfuseExporter({
        publicKey: langfusePub,
        secretKey: langfuseSec,
        baseUrl: process.env.LANGFUSE_BASE_URL,
        environment: process.env.LANGFUSE_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
      }),
    );
  }

  const spanOutputProcessors: SpanOutputProcessor[] = [
    new SensitiveDataFilter({
      sensitiveFields: EXTRA_SENSITIVE_FIELDS,
      redactionStyle: 'partial',
    }),
  ];

  return new Observability({
    default: { enabled: false },
    configs: {
      default: {
        serviceName: SERVICE_NAME,
        exporters,
        spanOutputProcessors,
      },
    },
  });
}

export function isLangfuseEnabled(): boolean {
  return !!(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);
}
