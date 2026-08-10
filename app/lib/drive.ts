// Adattatore thin: mantiene la firma hex-string usata da compose.tsx e approve.tsx
// mentre il provider interno usa Uint8Array binario.
// Il provider attivo è configurato all'avvio dell'app via setActiveProvider().
//
// UPLOAD: richiede sempre un provider attivo e autenticato (è l'owner che carica).
// DOWNLOAD: NON richiede un provider. Un contatto riceve i documenti senza avere
// un account sullo storage dell'owner: se nessun provider è attivo, il puntatore
// viene risolto per schema e scaricato dal link pubblico (il download dei provider
// è già una fetch senza credenziali; solo l'upload le usa). La riservatezza sta
// nella cifratura del blob, non nel link.
import { getActiveProvider, isStorageReady, type StorageProvider } from './storage';
import { GoogleDriveProvider } from './storage/googleDrive';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

async function providerForPointer(pointer: string): Promise<StorageProvider> {
  if (pointer.startsWith('gdrive://')) {
    // GoogleDriveProvider.download è una fetch pubblica (uc?export=download):
    // la token-source non viene mai invocata in download, solo in upload/delete.
    return new GoogleDriveProvider(async () => {
      throw new Error('[drive] Solo download pubblico: upload non disponibile senza login Google.');
    });
  }
  if (pointer.startsWith('drive://dev/')) {
    // Import lazy: devBlob dipende da expo-constants (→ react-native), che i
    // test Node non possono caricare. Qui arriva solo codice che gira su device.
    const { DevBlobProvider } = await import('./storage/devBlob');
    return new DevBlobProvider();
  }
  throw new Error(`[drive] Schema del puntatore sconosciuto, impossibile scaricare: ${pointer}`);
}

export async function uploadEncrypted(ciphertextHex: string): Promise<string> {
  return getActiveProvider().upload(hexToBytes(ciphertextHex));
}

// Scarica un blob cifrato: provider attivo se c'è, altrimenti risoluzione per schema.
export async function downloadBlob(pointer: string): Promise<Uint8Array> {
  const provider = isStorageReady() ? getActiveProvider() : await providerForPointer(pointer);
  return provider.download(pointer);
}

export async function downloadEncrypted(pointer: string): Promise<string> {
  return bytesToHex(await downloadBlob(pointer));
}

export async function deleteEncrypted(pointer: string): Promise<void> {
  const p = getActiveProvider();
  if (p.delete) await p.delete(pointer);
}
