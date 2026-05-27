// Provider di sviluppo — usa l'endpoint /dev/blob del server locale.
// SOLO per sviluppo e test end-to-end senza OAuth.
// In produzione usare GoogleDriveProvider (o altro provider reale).
import type { StorageProvider } from '../storage';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import Constants from 'expo-constants';

function base(): string {
  return (Constants.expoConfig?.extra?.serverUrl as string) ?? 'http://localhost:4000';
}

export class DevBlobProvider implements StorageProvider {
  readonly name = 'dev-blob';

  isAuthorized(): boolean { return true; }

  async upload(blob: Uint8Array): Promise<string> {
    const res = await fetch(base() + '/dev/blob', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: bytesToHex(blob) }),
    });
    if (res.status === 413) throw new Error('[DevBlobProvider] File troppo grande: il server ha rifiutato il payload (413). Controlla bodyLimit in index.ts.');
    if (!res.ok) throw new Error(`[DevBlobProvider] Upload fallito: ${res.status}`);
    const { pointer } = await res.json() as { pointer: string };
    return pointer;
  }

  async download(pointer: string): Promise<Uint8Array> {
    const res = await fetch(base() + '/dev/blob?pointer=' + encodeURIComponent(pointer));
    if (!res.ok) throw new Error(`[DevBlobProvider] Download fallito: ${res.status}`);
    const { data } = await res.json() as { data: string | null };
    if (data == null) throw new Error(`[DevBlobProvider] Blob non trovato: ${pointer}`);
    return hexToBytes(data);
  }

  async delete(_pointer: string): Promise<void> {
    // Il blob vive in memoria sul server — decade al riavvio; delete esplicito non necessario.
  }
}
