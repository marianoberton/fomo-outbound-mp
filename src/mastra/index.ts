/**
 * Entry point de Mastra. Registra agents, workflows y storage.
 * El cron se declara en el propio workflow de cadencia (Mastra 1.x lo lee del campo `schedule`).
 */
import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { PostgresStore } from '@mastra/pg';
import { PinoLogger } from '@mastra/loggers';
import { composerAgent } from './agents/composer-agent.js';
import { classifierAgent } from './agents/classifier-agent.js';
import { cadenciaWorkflow, perDealWorkflow } from './workflows/cadencia-workflow.js';
import { respuestaWorkflow } from './workflows/respuesta-workflow.js';
import { metricasSemanalWorkflow } from './workflows/metricas-semanal-workflow.js';
import { approvalQueueRoutes } from './server/approval-queue-routes.js';
import { webhooksRoutes } from './server/webhooks-routes.js';
import { opsRoutes } from './server/ops-routes.js';
import { buildObservability } from './observability.js';

const databaseUrl = process.env.DATABASE_URL ?? 'file:./local.db';

/**
 * Selecciona el storage adapter según el formato de DATABASE_URL.
 *  - postgres:// | postgresql://  → PostgresStore (prod, multi-instance, concurrent updates)
 *  - file:                        → LibSQLStore (dev local)
 *  - libsql://                    → LibSQLStore (Turso)
 *
 * El evented engine del cron-scheduled workflow requiere concurrent updates,
 * que tanto Postgres como libsql soportan.
 */
const storage =
  databaseUrl.startsWith('postgres://') || databaseUrl.startsWith('postgresql://')
    ? new PostgresStore({ id: 'mastra-storage', connectionString: databaseUrl })
    : new LibSQLStore({ id: 'mastra-storage', url: databaseUrl });

export const mastra = new Mastra({
  agents: { composerAgent, classifierAgent },
  workflows: { cadenciaWorkflow, perDealWorkflow, respuestaWorkflow, metricasSemanalWorkflow },
  storage,
  logger: new PinoLogger({
    name: 'outbound-mp',
    level: (process.env.LOG_LEVEL as 'info' | 'debug' | 'warn' | 'error') ?? 'info',
  }),
  server: {
    apiRoutes: [...opsRoutes, ...approvalQueueRoutes, ...webhooksRoutes],
  },
  observability: buildObservability(),
});
