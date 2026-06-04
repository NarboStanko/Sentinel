// Utility condivise per i test autenticati.
// Importa da @noble/* disponibili nel workspace sentinella.
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { canonicalize } from '../../../app/lib/canonicalize.js';

export interface KeyPair { priv: Uint8Array; pub: string; }

export function mkKeyPair(): KeyPair {
  const priv = p256.utils.randomPrivateKey();
  const pub  = bytesToHex(p256.getPublicKey(priv, true));
  return { priv, pub };
}

// Firma un body secondo lo schema canonico di auth.ts.
export function signBody(
  priv: Uint8Array,
  pub: string,
  method: string,
  urlPath: string,
  body: Record<string, unknown>,
  ts?: number,
): Record<string, unknown> {
  const t   = ts ?? Date.now();
  const hash = sha256(new TextEncoder().encode(canonicalize(method, urlPath, t, pub, body)));
  const sig  = bytesToHex(p256.sign(hash, priv).toCompactRawBytes());
  return { ...body, pub, ts: t, sig };
}
