/**
 * Encryption for OAuth refresh tokens at rest.
 *
 * A Google refresh token is a long-lived credential that can read and modify a
 * customer's business listing. A database dump must not be enough to use one,
 * so tokens are sealed with AES-256-GCM before they are stored.
 *
 * Format: `v<keyVersion>.<iv>.<authTag>.<ciphertext>`, each part base64url.
 * The version prefix lets the key be rotated without downtime: new writes use
 * the current key, and reads select the key the record was sealed with.
 *
 * GCM is authenticated, so tampering with stored ciphertext fails to open
 * rather than silently decrypting to garbage.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { env, requireTokenEncryptionKey } from '@/config/env.server';
import { ConfigurationError } from '@/server/errors';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit nonce, the GCM standard
const AUTH_TAG_LENGTH = 16;

/**
 * Additional authenticated data. Binds ciphertext to its purpose so a sealed
 * refresh token cannot be pasted into a field expecting a different secret.
 */
const AAD = Buffer.from('gbp-growth-agent:oauth-refresh-token');

function keyForVersion(version: number): Buffer {
  if (version !== env.TOKEN_ENCRYPTION_KEY_VERSION) {
    // When rotating, add the retired keys to a lookup here so existing records
    // stay readable while they are re-encrypted in the background.
    throw new ConfigurationError(
      `No encryption key available for key version ${version}. ` +
        `The current version is ${env.TOKEN_ENCRYPTION_KEY_VERSION}. ` +
        'A retired key must remain configured until every record is re-encrypted.',
      { requestedVersion: version },
    );
  }
  return requireTokenEncryptionKey();
}

export interface SealedToken {
  ciphertext: string;
  keyVersion: number;
}

/** Encrypts a token for storage. */
export function sealToken(plaintext: string): SealedToken {
  if (!plaintext) {
    throw new ConfigurationError('Refusing to seal an empty token.');
  }

  const keyVersion = env.TOKEN_ENCRYPTION_KEY_VERSION;
  const key = keyForVersion(keyVersion);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  cipher.setAAD(AAD);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: [
      `v${keyVersion}`,
      iv.toString('base64url'),
      authTag.toString('base64url'),
      encrypted.toString('base64url'),
    ].join('.'),
    keyVersion,
  };
}

/** Decrypts a stored token. Throws if the ciphertext was tampered with. */
export function openToken(sealed: string): string {
  const parts = sealed.split('.');
  if (parts.length !== 4) {
    throw new ConfigurationError('Malformed sealed token: expected 4 segments.');
  }

  const [versionPart, ivPart, tagPart, dataPart] = parts;
  if (!versionPart.startsWith('v')) {
    throw new ConfigurationError('Malformed sealed token: missing key version prefix.');
  }

  const keyVersion = Number.parseInt(versionPart.slice(1), 10);
  if (!Number.isInteger(keyVersion)) {
    throw new ConfigurationError('Malformed sealed token: unreadable key version.');
  }

  const key = keyForVersion(keyVersion);
  const iv = Buffer.from(ivPart, 'base64url');
  const authTag = Buffer.from(tagPart, 'base64url');
  const data = Buffer.from(dataPart, 'base64url');

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAAD(AAD);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** Constant-time comparison, for verifying webhook tokens and similar secrets. */
export function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
