/**
 * Singleton del cliente HubSpot. El retry vive en `./retry.ts` (compartido con Meta).
 * En STUB_MODE el cliente real nunca se inicializa — las tools devuelven mocks.
 */
import { Client } from '@hubspot/api-client';
import { STUB_MODE } from '../config/constants.js';

export { withRetry } from './retry.js';

let _client: Client | null = null;

export function getHubSpotClient(): Client {
  if (STUB_MODE) {
    throw new Error(
      'getHubSpotClient() llamado en STUB_MODE — usar el flag STUB_MODE en las tools antes de llamar al cliente.',
    );
  }
  if (!_client) {
    const accessToken = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
    if (!accessToken) {
      throw new Error('HUBSPOT_PRIVATE_APP_TOKEN no está seteado.');
    }
    _client = new Client({ accessToken, numberOfApiCallRetries: 0 });
  }
  return _client;
}
