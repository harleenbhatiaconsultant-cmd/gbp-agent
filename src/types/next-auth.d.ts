import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  /**
   * The session carries identity only. Organization, role and capabilities are
   * resolved per-request from the database (see src/server/auth/session.ts) so
   * a revoked membership or changed role takes effect immediately rather than
   * when the token happens to expire.
   */
  interface Session {
    user: {
      id: string;
    } & DefaultSession['user'];
  }
}

export {};
