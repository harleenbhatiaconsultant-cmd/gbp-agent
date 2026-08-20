/**
 * Auth.js (NextAuth v5) configuration — LOGIN ONLY.
 *
 * This governs "who is signed in to the platform". It is deliberately separate
 * from the Google Business Profile connection (src/server/integrations/google),
 * which is a second, explicit consent granting profile-management scope.
 * Signing in must never silently grant the ability to edit a business listing.
 *
 * SESSION STRATEGY — JWT, chosen deliberately:
 *   The dev sign-in provider below requires the Credentials provider, which
 *   Auth.js only supports with JWT sessions. The cost of JWT is that a token
 *   cannot be revoked server-side mid-lifetime. That cost is contained because
 *   the token carries ONLY a user id: organization membership, role and
 *   capabilities are resolved from the database on every request
 *   (see session.ts), so revoking access or changing a role takes effect
 *   immediately. Deleting a user is also checked there.
 */

import type { NextAuthConfig } from 'next-auth';
import { PrismaAdapter } from '@auth/prisma-adapter';
import type { Adapter } from 'next-auth/adapters';
import Google from 'next-auth/providers/google';
import Credentials from 'next-auth/providers/credentials';
import { prisma } from '@/server/db';
import { env, isProduction } from '@/config/env.server';
import { logger } from '@/server/observability/logger';

const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

function buildProviders(): NextAuthConfig['providers'] {
  const providers: NextAuthConfig['providers'] = [];

  if (env.GOOGLE_LOGIN_CLIENT_ID && env.GOOGLE_LOGIN_CLIENT_SECRET) {
    providers.push(
      Google({
        clientId: env.GOOGLE_LOGIN_CLIENT_ID,
        clientSecret: env.GOOGLE_LOGIN_CLIENT_SECRET,
        // Login only. No offline access, no Business Profile scope — those are
        // requested separately by the GBP connection flow.
        authorization: { params: { scope: 'openid email profile', prompt: 'select_account' } },
      }),
    );
  }

  /**
   * DEVELOPMENT SIGN-IN — never registered in production.
   *
   * Lets the platform be built and tested before Google OAuth credentials
   * exist. It accepts any email and provisions the user on first use. The
   * guard is the NODE_ENV check here plus a second assertion inside
   * `authorize`, so enabling it in production would take two deliberate edits.
   */
  if (!isProduction) {
    providers.push(
      Credentials({
        id: 'dev',
        name: 'Development sign-in',
        credentials: {
          email: { label: 'Email', type: 'email' },
          name: { label: 'Name', type: 'text' },
        },
        async authorize(credentials) {
          if (isProduction) {
            throw new Error('The development sign-in provider is disabled in production.');
          }

          const email = String(credentials?.email ?? '').trim().toLowerCase();
          if (!email || !email.includes('@')) return null;

          const name = String(credentials?.name ?? '').trim() || email.split('@')[0];

          const user = await prisma.user.upsert({
            where: { email },
            update: { lastLoginAt: new Date() },
            create: { email, name, emailVerified: new Date(), lastLoginAt: new Date() },
          });

          logger.warn({ email }, 'Development sign-in used');

          return { id: user.id, email: user.email, name: user.name, image: user.image };
        },
      }),
    );
  }

  return providers;
}

export const authConfig: NextAuthConfig = {
  // The extended client is structurally compatible with the adapter's
  // expectations; the cast is only needed because $extends widens the type.
  adapter: PrismaAdapter(prisma as unknown as Parameters<typeof PrismaAdapter>[0]) as Adapter,
  providers: buildProviders(),
  session: { strategy: 'jwt', maxAge: SESSION_MAX_AGE_SECONDS },
  trustHost: env.AUTH_TRUST_HOST,
  pages: { signIn: '/sign-in', error: '/sign-in' },
  callbacks: {
    async jwt({ token, user }) {
      // Only on initial sign-in. The token deliberately carries nothing but
      // identity — no role, no organization — so authorization decisions always
      // come from current database state rather than a stale token.
      if (user?.id) token.sub = user.id;
      return token;
    },
    async session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      return session;
    },
  },
  events: {
    async signIn({ user }) {
      if (!user.id) return;
      await prisma.user
        .update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
        .catch((error) => logger.error({ err: error }, 'Failed to record lastLoginAt'));
    },
  },
};
