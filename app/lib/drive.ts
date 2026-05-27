// Adattatore thin: mantiene la firma hex-string usata da compose.tsx e approve.tsx
// mentre il provider interno usa Uint8Array binario.
// Il provider attivo è configurato all'avvio dell'app via setActiveProvider().
import { getActiveProvider } from './storage';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

export async function uploadEncrypted(ciphertextHex: string): Promise<string> {
  return getActiveProvider().upload(hexToBytes(ciphertextHex));
}

export async function downloadEncrypted(pointer: string): Promise<string> {
  const bytes = await getActiveProvider().download(pointer);
  return bytesToHex(bytes);
}

export async function deleteEncrypted(pointer: string): Promise<void> {
  const p = getActiveProvider();
  if (p.delete) await p.delete(pointer);
}
