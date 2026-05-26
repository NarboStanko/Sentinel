// Provider Google Drive — OAuth2 PKCE, scope drive.file.
//
// SETUP GOOGLE CLOUD CONSOLE (una-tantum)
// ────────────────────────────────────────
// 1. Crea progetto in https://console.cloud.google.com
// 2. Abilita "Google Drive API"
// 3. Crea credenziali OAuth → "ID client OAuth 2.0"
//    - Tipo: Applicazione Android  → package: org.sentinella.app
//                                    SHA-1: da `eas credentials` o keystore locale
//    - Tipo: Applicazione iOS      → bundle ID: org.sentinella.app
//    (NON usare tipo "Web" per app native — il client secret non può stare nel bundle)
// 4. Copia i client ID ottenuti in app.json (extra):
//      "googleDriveClientIdAndroid": "XXXX.apps.googleusercontent.com",
//      "googleDriveClientIdIos":     "XXXX.apps.googleusercontent.com"
//    Per iOS aggiungi anche lo schema inverso in app.json → ios.infoPlist:
//      "CFBundleURLTypes": [{ "CFBundleURLSchemes": ["com.googleusercontent.apps.XXXX"] }]
//    NOTA: NON committare i client ID se il repo è pubblico; usa expo-constants + env CI.
// 5. URI di redirect autorizzati:
//    - iOS:     com.googleusercontent.apps.XXXX:/  (schema inverso, gestito da iOS)
//    - Android: com.googleusercontent.apps.XXXX:/  (intent filter, gestito da expo-auth-session)
//
// NOTA DI SICUREZZA SUL LINK CONDIVISO
// ──────────────────────────────────────
// Il file su Drive è condiviso "chiunque abbia il link" (reader).
// Il puntatore (gdrive://fileId) va trattato come potenzialmente pubblico.
// La riservatezza è garantita SOLO dalla cifratura (XChaCha20-Poly1305 + Shamir):
// chiunque scarichi il blob non può decifrarlo senza k quote valide.

import type { StorageProvider } from '../storage';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';
import * as SecureStore from 'expo-secure-store';
import {
  AuthRequest,
  exchangeCodeAsync,
  makeRedirectUri,
  refreshAsync,
} from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

// Registra il handler di redirect (chiamato una volta nel root component)
WebBrowser.maybeCompleteAuthSession();

const DISCOVERY = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint:         'https://oauth2.googleapis.com/token',
  revocationEndpoint:    'https://oauth2.googleapis.com/revoke',
};

const SCOPE = 'https://www.googleapis.com/auth/drive.file';

const K_ACCESS  = 'sentinella.gdrive.access';
const K_REFRESH = 'sentinella.gdrive.refresh';
const K_EXPIRES = 'sentinella.gdrive.expires';

export class GoogleDriveProvider implements StorageProvider {
  readonly name = 'google-drive';

  private clientId: string;
  private accessToken:  string | null = null;
  private refreshToken: string | null = null;
  private expiresAt = 0;

  constructor() {
    const extra = Constants.expoConfig?.extra as Record<string, unknown> | undefined;
    const id = Platform.OS === 'ios'
      ? extra?.googleDriveClientIdIos
      : extra?.googleDriveClientIdAndroid;
    if (typeof id !== 'string' || !id) {
      throw new Error(
        '[GoogleDriveProvider] Client ID mancante in app.json extra. ' +
        'Vedi il commento SETUP in cima a questo file.'
      );
    }
    this.clientId = id;
  }

  isAuthorized(): boolean {
    return !!(this.accessToken || this.refreshToken);
  }

  /** Carica i token salvati → true se trovati */
  async loadSavedTokens(): Promise<boolean> {
    const [access, refresh, expires] = await Promise.all([
      SecureStore.getItemAsync(K_ACCESS),
      SecureStore.getItemAsync(K_REFRESH),
      SecureStore.getItemAsync(K_EXPIRES),
    ]);
    this.accessToken  = access;
    this.refreshToken = refresh;
    this.expiresAt    = expires ? parseInt(expires) : 0;
    return !!(access || refresh);
  }

  private async saveTokens(access: string, refresh: string | null | undefined, expiresIn: number) {
    this.accessToken = access;
    this.expiresAt   = Date.now() + expiresIn * 1000;
    await SecureStore.setItemAsync(K_ACCESS, access);
    await SecureStore.setItemAsync(K_EXPIRES, String(this.expiresAt));
    if (refresh) {
      this.refreshToken = refresh;
      await SecureStore.setItemAsync(K_REFRESH, refresh);
    }
  }

  async clearTokens(): Promise<void> {
    this.accessToken = this.refreshToken = null;
    this.expiresAt = 0;
    await Promise.all([
      SecureStore.deleteItemAsync(K_ACCESS),
      SecureStore.deleteItemAsync(K_REFRESH),
      SecureStore.deleteItemAsync(K_EXPIRES),
    ]);
  }

  // ── OAuth PKCE ───────────────────────────────────────────────────────────

  /** Avvia il flusso OAuth. Deve essere chiamato da un handler UI (tap su pulsante). */
  async authorize(): Promise<void> {
    const redirectUri = makeRedirectUri({ scheme: 'sentinella' });

    const request = new AuthRequest({
      clientId: this.clientId,
      redirectUri,
      scopes: [SCOPE],
      usePKCE: true,
      extraParams: {
        access_type: 'offline',  // richiedi refresh token
        prompt: 'consent',       // garantisce che Google rilasci sempre il refresh token
      },
    });

    await request.makeAuthUrlAsync(DISCOVERY);
    const result = await request.promptAsync(DISCOVERY);

    if (result.type !== 'success') {
      throw new Error(`[GoogleDriveProvider] Autorizzazione fallita: ${result.type}`);
    }

    const tokens = await exchangeCodeAsync(
      {
        clientId: this.clientId,
        redirectUri,
        code: result.params.code,
        extraParams: { code_verifier: request.codeVerifier! },
      },
      { tokenEndpoint: DISCOVERY.tokenEndpoint }
    );

    if (!tokens.accessToken) throw new Error('[GoogleDriveProvider] Nessun access token ricevuto');
    await this.saveTokens(tokens.accessToken, tokens.refreshToken, tokens.expiresIn ?? 3600);
  }

  // ── Token management ─────────────────────────────────────────────────────

  private async ensureToken(): Promise<string> {
    const BUFFER = 5 * 60 * 1000; // aggiorna 5 min prima della scadenza

    if (this.accessToken && Date.now() < this.expiresAt - BUFFER) {
      return this.accessToken;
    }

    if (this.refreshToken) {
      const result = await refreshAsync(
        { clientId: this.clientId, refreshToken: this.refreshToken },
        { tokenEndpoint: DISCOVERY.tokenEndpoint }
      );
      await this.saveTokens(
        result.accessToken,
        result.refreshToken ?? this.refreshToken,
        result.expiresIn ?? 3600
      );
      return this.accessToken!;
    }

    throw new Error(
      '[GoogleDriveProvider] Token scaduto e nessun refresh token disponibile. ' +
      'Chiama authorize() di nuovo.'
    );
  }

  // ── Upload ───────────────────────────────────────────────────────────────

  async upload(blob: Uint8Array): Promise<string> {
    const token = await this.ensureToken();

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
    const token  = await this.ensureToken();
    const fileId = pointer.slice('gdrive://'.length);
    await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  }
}
