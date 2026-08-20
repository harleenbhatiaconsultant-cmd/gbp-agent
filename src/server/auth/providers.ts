/**
 * Which sign-in methods are available in this environment.
 *
 * Kept separate from config.ts so UI can ask the question without importing the
 * whole NextAuth configuration graph.
 */

import { env, isProduction } from '@/config/env.server';

export function isGoogleLoginEnabled(): boolean {
  return Boolean(env.GOOGLE_LOGIN_CLIENT_ID && env.GOOGLE_LOGIN_CLIENT_SECRET);
}

/** Development-only credentials sign-in. Never available in production. */
export function isDevSignInEnabled(): boolean {
  return !isProduction;
}
