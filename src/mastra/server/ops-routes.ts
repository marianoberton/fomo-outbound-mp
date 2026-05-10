/**
 * Routes operacionales — health check para load balancers / docker.
 * Sin auth (publicly reachable).
 */
import { registerApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';

const STARTED_AT = Date.now();
const VERSION = process.env.npm_package_version ?? '0.0.0';

type MastraInstance = {
  getStorage: () => { listWorkflowRuns?: (a: unknown) => Promise<unknown> } | undefined;
};

export const opsRoutes = [
  registerApiRoute('/health', {
    method: 'GET',
    requiresAuth: false,
    handler: async (c: Context) => {
      const mastra = c.get('mastra') as MastraInstance;
      const storage = mastra.getStorage();
      let storageOk = false;
      try {
        if (storage?.listWorkflowRuns) {
          // Llamada cheap para validar que el storage responde.
          await storage.listWorkflowRuns({ perPage: 1 });
          storageOk = true;
        }
      } catch {
        storageOk = false;
      }
      const body = {
        ok: storageOk,
        version: VERSION,
        uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
        storage: storageOk ? 'ok' : 'unreachable',
      };
      return c.json(body, storageOk ? 200 : 503);
    },
  }),
];
