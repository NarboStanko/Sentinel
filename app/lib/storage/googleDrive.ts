// Provider Google Drive — scope drive.file (solo file creati dall'app).
//
// AUTENTICAZIONE
// ──────────────
// L'OAuth NON vive più qui: il login è gestito da lib/driveAuth.ts con
// Google Sign-In nativo (@react-native-google-signin). Questo provider riceve
// nel costruttore una token-source (getDriveAccessToken) che restituisce un
// access token valido a ogni chiamata — il refresh è nativo dentro
// GoogleSignin.getTokens(), quindi qui non c'è alcuna logica di refresh.
//
// SETUP GOOGLE CLOUD CONSOLE (una-tantum)
// ────────────────────────────────────────
// 1. Progetto in https://console.cloud.google.com con "Google Drive API" abilitata
// 2. Credenziali OAuth:
//    - Client ANDROID: package org.sentinella.app + SHA-1 del keystore EAS
//      (necessario perché il sign-in nativo verifichi l'app; non va nel codice)
//    - Client WEB: il suo ID va in app.json extra.googleDriveClientIdWeb
//      (la libreria lo richiede come webClientId anche per il login Android)
// 3. NESSUN client secret nel bundle, NESSUN redirect URI da registrare.
//
// NOTA DI SICUREZZA SUL LINK CONDIVISO
// ──────────────────────────────────────
// Il file su Drive è condiviso "chiunque abbia il link" (reader).
// Il puntatore (gdrive://fileId) va trattato come potenzialmente pubblico.
// La riservatezza è garantita SOLO dalla cifratura (XChaCha20-Poly1305 + Shamir):
// chiunque scarichi il blob non può decifrarlo senza k quote valide.

import type { StorageProvider } from '../storage';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';

export class GoogleDriveProvider implements StorageProvider {
  readonly name = 'google-drive';

  /** @param getAccessToken token-source (es. getDriveAccessToken di driveAuth):
   *  restituisce un access token valido, rinnovato nativamente se scaduto. */
  constructor(private readonly getAccessToken: () => Promise<string>) {}

  isAuthorized(): boolean {
    // La sessione è gestita da Google Sign-In; se manca, getAccessToken()
    // fallirà alla prima chiamata con un errore esplicito.
    return true;
  }

  // ── Upload ───────────────────────────────────────────────────────────────

  async upload(blob: Uint8Array): Promise<string> {
    const token = await this.getAccessToken();

    // Nome opaco: 32 hex casuali, nessuna estensione, nessun metadato rivelatore
    const opaqueId = bytesToHex(randomBytes(16));

    // Contenuto come stringa hex (evita problemi di encoding binario su RN)
    const content  = bytesToHex(blob);

    const boundary = 'SentBnd' + bytesToHex(randomBytes(4));
    const metadata = JSON.stringify({ name: opaqueId, mimeType: 'text/plain' });
    const body = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      metadata,
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      '',
      content,
      `--${boundary}--`,
    ].join('\r\n');

    const uploadRes = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
      }
    );

    if (!uploadRes.ok) {
      const detail = await uploadRes.text();
      throw new Error(`[GoogleDriveProvider] Upload fallito (${uploadRes.status}): ${detail}`);
    }

    const { id: fileId } = await uploadRes.json() as { id: string };

    // Rendi il file accessibile con link (reader a chiunque; la sicurezza è nella cifratura)
    const permRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}/permissions`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ role: 'reader', type: 'anyone' }),
      }
    );

    if (!permRes.ok) {
      throw new Error(`[GoogleDriveProvider] Permessi falliti (${permRes.status})`);
    }

    return `gdrive://${fileId}`;
  }

  // ── Download ─────────────────────────────────────────────────────────────

  async download(pointer: string): Promise<Uint8Array> {
    if (!pointer.startsWith('gdrive://')) {
      throw new Error(`[GoogleDriveProvider] Puntatore non valido: ${pointer}`);
    }
    const fileId = pointer.slice('gdrive://'.length);

    // File pubblico: download via URL uc senza autenticazione.
    // Funziona per file condivisi con "chiunque abbia il link" (reader).
    const url = `https://drive.google.com/uc?id=${encodeURIComponent(fileId)}&export=download`;
    const res = await fetch(url, { redirect: 'follow' });

    if (!res.ok) {
      throw new Error(`[GoogleDriveProvider] Download fallito (${res.status}) per ${pointer}`);
    }

    const hex = await res.text();
    return hexToBytes(hex);
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  async delete(pointer: string): Promise<void> {
    if (!pointer.startsWith('gdrive://')) return;
    const token  = await this.getAccessToken();
    const fileId = pointer.slice('gdrive://'.length);
    await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  }
}
