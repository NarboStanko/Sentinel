import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { getActiveProvider } from './storage';

export const MAX_FILE_BYTES  = 25 * 1024 * 1024;   // 25 MB per file
export const MAX_TOTAL_BYTES = 200 * 1024 * 1024;  // 200 MB pacchetto totale

export type AttachmentMeta = {
  pointer: string;
  name: string;
  mimeType: string;
  size: number;
  nonce: string;
};

export type PendingAttachment = {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
};

async function readFileBytes(uri: string): Promise<Uint8Array> {
  const res = await fetch(uri);
  if (!res.ok) throw new Error('Lettura file fallita: ' + uri);
  return new Uint8Array(await res.arrayBuffer());
}

// Cifra un allegato con la DEK dello switch e lo carica sul provider attivo.
// Il nome reale e il MIME restano solo nel manifest cifrato — mai sul server o storage.
export async function encryptAndUpload(
  att: PendingAttachment,
  dek: Uint8Array,
  onProgress?: (pct: number) => void,
): Promise<AttachmentMeta> {
  onProgress?.(0);
  const bytes = await readFileBytes(att.uri);
  onProgress?.(40);
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(dek, nonce).encrypt(bytes);
  onProgress?.(70);
  const pointer = await getActiveProvider().upload(ct);
  onProgress?.(100);
  return { pointer, name: att.name, mimeType: att.mimeType, size: att.size, nonce: bytesToHex(nonce) };
}

// Scarica e decifra un allegato; restituisce i byte in chiaro.
export async function decryptAttachment(meta: AttachmentMeta, dek: Uint8Array): Promise<Uint8Array> {
  const ct = await getActiveProvider().download(meta.pointer);
  return xchacha20poly1305(dek, hexToBytes(meta.nonce)).decrypt(ct);
}
