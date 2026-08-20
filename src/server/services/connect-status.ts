/**
 * Whether the environment is configured for Google connections.
 *
 * Lives in the service layer so pages can ask without importing server config
 * directly — components and pages are barred from `@/config/env.server`.
 */

import { env } from '@/config/env.server';

export function isGoogleConnectConfigured(): boolean {
  return Boolean(
    env.GOOGLE_OAUTH_CLIENT_ID &&
      env.GOOGLE_OAUTH_CLIENT_SECRET &&
      // Without the encryption key a refresh token cannot be sealed, so the
      // flow would fail at the last step rather than the first.
      env.TOKEN_ENCRYPTION_KEY,
  );
}
