// Sentinella — crypto core.
// Librerie auditate, pure JS, adatte a React Native:
//   @noble/curves  (P-256: derivazione chiave + ECDH)
//   @noble/ciphers (XChaCha20-Poly1305: cifratura simmetrica autenticata)
//   @noble/hashes  (sha256, hkdf)
//   @scure/bip39   (seed phrase 12 parole)
//
// MODELLO:
//  - Identita' = coppia P-256 derivata DETERMINISTICAMENTE dalla seed phrase.
//  - Contenuto cifrato UNA volta con una DEK random (XChaCha20-Poly1305).
//  - DEK spezzata con Shamir k-su-N; ogni quota cifrata (ECDH) per un contatto.
//  - Il rilascio richiede >= k quote -> ricombinazione -> decifratura.

import { p256 } from '@noble/curves/p256';
import { bytesToNumberBE, numberToBytesBE } from '@noble/curves/abstract/utils';
import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';
import { randomBytes, bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

export type Identity = { priv: Uint8Array; pub: Uint8Array }; // pub = punto compresso 33B
export type SealedBlob = { ephPub: string; nonce: string; ct: string };
export type Share = { x: number; y: Uint8Array };

const INFO = new TextEncoder().encode('sentinella/v1');

// ---------- seed phrase -> identita' deterministica ----------
export function newSeedPhrase(): string {
  return generateMnemonic(wordlist, 128); // 12 parole
}
export function isValidSeedPhrase(m: string): boolean {
  return validateMnemonic(m.trim().toLowerCase(), wordlist);
}
export function identityFromSeed(mnemonic: string): Identity {
  const seed = mnemonicToSeedSync(mnemonic.trim().toLowerCase()); // 64B
  // riduci a uno scalare valido in [1, n-1]
  const n = p256.CURVE.n;
  const scalar = (bytesToNumberBE(sha256(seed)) % (n - 1n)) + 1n;
  const priv = numberToBytesBE(scalar, 32);
  const pub = p256.getPublicKey(priv, true); // compresso (33B)
  return { priv, pub };
}
// impronta breve per verifica visiva (es. "safety number")
export function fingerprint(pub: Uint8Array): string {
  return bytesToHex(sha256(pub)).slice(0, 12).toUpperCase();
}

// confronto lessicografico usato per ordinamento deterministico
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

// Safety number leggibile a voce: ordina le due pubkey (garantisce commutatività),
// sha256, mappa i primi 12 byte a 6 parole BIP39 (uint16 % 2048, distribuzione uniforme).
// safetyNumber(a, b) === safetyNumber(b, a) sempre.
export function safetyNumber(pubA: Uint8Array, pubB: Uint8Array): string {
  const [lo, hi] = compareBytes(pubA, pubB) <= 0 ? [pubA, pubB] : [pubB, pubA];
  const buf = new Uint8Array(lo.length + hi.length);
  buf.set(lo); buf.set(hi, lo.length);
  const h = sha256(buf);
  const words: string[] = [];
  for (let i = 0; i < 6; i++) {
    const idx = ((h[i * 2] << 8) | h[i * 2 + 1]) % 2048;
    words.push(wordlist[idx]);
  }
  return words.join(' ');
}

// ---------- ECDH seal/open (cifra bytes per una chiave pubblica) ----------
function deriveKey(shared: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, undefined, INFO, 32);
}
export function sealTo(recipientPub: Uint8Array, plaintext: Uint8Array): SealedBlob {
  const eph = p256.utils.randomPrivateKey();
  const ephPub = p256.getPublicKey(eph, true);
  const shared = p256.getSharedSecret(eph, recipientPub); // punto condiviso
  const key = deriveKey(shared);
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(key, nonce).encrypt(plaintext);
  return { ephPub: bytesToHex(ephPub), nonce: bytesToHex(nonce), ct: bytesToHex(ct) };
}
export function openWith(myPriv: Uint8Array, blob: SealedBlob): Uint8Array {
  const ephPub = hexToBytes(blob.ephPub);
  const shared = p256.getSharedSecret(myPriv, ephPub);
  const key = deriveKey(shared);
  return xchacha20poly1305(key, hexToBytes(blob.nonce)).decrypt(hexToBytes(blob.ct));
}

// ---------- cifratura contenuto (testo + file) ----------
export function encryptContent(plaintext: Uint8Array) {
  const dek = randomBytes(32);
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(dek, nonce).encrypt(plaintext);
  return { dek, nonce: bytesToHex(nonce), ct: bytesToHex(ct) };
}
// Cifra con una DEK già esistente (per add-content senza ridistribuire le quote).
export function encryptWithKey(dek: Uint8Array, plaintext: Uint8Array): { nonce: string; ct: string } {
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(dek, nonce).encrypt(plaintext);
  return { nonce: bytesToHex(nonce), ct: bytesToHex(ct) };
}
export function decryptContent(dek: Uint8Array, nonceHex: string, ctHex: string): Uint8Array {
  return xchacha20poly1305(dek, hexToBytes(nonceHex)).decrypt(hexToBytes(ctHex));
}

// ---------- Shamir k-su-N su GF(256) ----------
// (per la produzione valutare una libreria dedicata e auditata)
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
(() => { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x ^= (x << 1); if (x & 0x100) x ^= 0x11b; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; })();
const gmul = (a: number, b: number) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];
const gdiv = (a: number, b: number) => a === 0 ? 0 : EXP[(LOG[a] + 255 - LOG[b]) % 255];

export function splitSecret(secret: Uint8Array, n: number, k: number): Share[] {
  const shares: Share[] = [];
  for (let i = 1; i <= n; i++) shares.push({ x: i, y: new Uint8Array(secret.length) });
  for (let bi = 0; bi < secret.length; bi++) {
    const co = new Uint8Array(k); co[0] = secret[bi];
    if (k > 1) co.set(randomBytes(k - 1), 1);
    for (const sh of shares) {
      let acc = 0, xp = 1;
      for (let c = 0; c < k; c++) { acc ^= gmul(co[c], xp); xp = gmul(xp, sh.x); }
      sh.y[bi] = acc;
    }
  }
  return shares;
}
export function combineSecret(shares: Share[]): Uint8Array {
  const len = shares[0].y.length, out = new Uint8Array(len);
  for (let bi = 0; bi < len; bi++) {
    let acc = 0;
    for (let i = 0; i < shares.length; i++) {
      let num = 1, den = 1;
      for (let j = 0; j < shares.length; j++) {
        if (i === j) continue;
        num = gmul(num, shares[j].x);
        den = gmul(den, shares[i].x ^ shares[j].x);
      }
      acc ^= gmul(shares[i].y[bi], gdiv(num, den));
    }
    out[bi] = acc;
  }
  return out;
}

// serializzazione quota per il trasporto
export const shareToWire = (s: Share) => ({ x: s.x, y: bytesToHex(s.y) });
export const shareFromWire = (w: { x: number; y: string }): Share => ({ x: w.x, y: hexToBytes(w.y) });

export { bytesToHex, hexToBytes, randomBytes };

// Firma una sfida (stringa UTF-8) con la chiave privata P-256.
// Formato compatto (64 byte, r+s): accettato da p256.verify() lato server.
// Usato per autenticarsi a /pending senza sessione server-side.
export function signChallenge(priv: Uint8Array, challenge: string): string {
  const hash = sha256(new TextEncoder().encode(challenge));
  return bytesToHex(p256.sign(hash, priv).toCompactRawBytes());
}

// ---------- OCCULTAMENTO METADATA ----------
// Il server NON deve sapere quale quota appartenga a quale contatto, ne' quante
// quote reali esistano. Le quote viaggiano come blob opachi, mescolate a "esche".
// Il contatto trova la propria per TRIAL DECRYPTION (prova ad aprirle tutte).
import { p256 as _p256 } from '@noble/curves/p256';

export function sealShare(recipientPub: Uint8Array, share: Share): string {
  const packed = new Uint8Array(1 + share.y.length);
  packed[0] = share.x; packed.set(share.y, 1);
  return JSON.stringify(sealTo(recipientPub, packed));
}
// Esca indistinguibile: cifrata verso una chiave effimera di cui nessuno ha la privata.
export function makeDecoy(secretLen = 32): string {
  const eph = _p256.utils.randomPrivateKey();
  const pub = _p256.getPublicKey(eph, true);
  return JSON.stringify(sealTo(pub, randomBytes(1 + secretLen)));
}
export function tryOpenShare(myPriv: Uint8Array, blobStr: string): Share | null {
  try {
    const o = openWith(myPriv, JSON.parse(blobStr));
    return { x: o[0], y: o.slice(1) };
  } catch { return null; } // tag non valido -> non e' la mia quota (o e' un'esca)
}
// Il contatto cerca la propria quota tra tutte le opache, senza che il server lo sappia.
export function findMyShare(blobs: string[], myPriv: Uint8Array): Share | null {
  for (const b of blobs) { const s = tryOpenShare(myPriv, b); if (s) return s; }
  return null;
}
