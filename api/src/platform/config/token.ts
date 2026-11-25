import { createHash, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { duration } from './duration.js';
import { parseEnv, type Env } from './env.js';
import { Secret } from './secret.js';

// Fingerprint of the public, local-only key in .env.example; startup refuses it when APP_ENV=prod.
export const DEV_TOKEN_KEY_FINGERPRINT =
  '913ad020842e7423a7bb83830058ee12811193db32f140d5510703eec0766609';

export const MAX_ACCESS_TOKEN_TTL_MS = 24 * 3_600_000;

export type TokenSettings = {
  readonly signingKey: Secret;
  readonly signingKeyFingerprint: string;
  readonly accessTokenTtlMs: number;
};

const KEY_RULE = 'base64 of a PKCS#8 PEM ECDSA P-256 private key';
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const PKCS8_HEADER = '-----BEGIN PRIVATE KEY-----';

export function loadTokenSettings(env: Env): TokenSettings {
  const parsed = parseEnv(env, {
    signingKey: { name: 'TOKEN_SIGNING_KEY', schema: signingKey },
    accessTokenTtlMs: {
      name: 'ACCESS_TOKEN_TTL',
      schema: duration({ fallback: '1h', maxMs: MAX_ACCESS_TOKEN_TTL_MS }),
    },
  });
  return {
    signingKey: parsed.signingKey.pem,
    signingKeyFingerprint: parsed.signingKey.fingerprint,
    accessTokenTtlMs: parsed.accessTokenTtlMs,
  };
}

// Hashing the public key in DER makes the fingerprint independent of how the PEM was encoded.
export function keyFingerprint(key: KeyObject): string {
  return createHash('sha256')
    .update(createPublicKey(key).export({ type: 'spki', format: 'der' }))
    .digest('hex');
}

const signingKey = z.string({ error: `required (${KEY_RULE})` }).transform((text, ctx) => {
  const decoded = decodeSigningKey(text);
  if (decoded !== undefined) return decoded;
  ctx.addIssue(`must be ${KEY_RULE}`);
  return z.NEVER;
});

function decodeSigningKey(text: string): { pem: Secret; fingerprint: string } | undefined {
  if (!BASE64.test(text)) return undefined;
  const pem = Buffer.from(text, 'base64').toString('utf8');
  if (!pem.trimStart().startsWith(PKCS8_HEADER)) return undefined;
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    return undefined;
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    return undefined;
  }
  return { pem: new Secret(pem), fingerprint: keyFingerprint(key) };
}
