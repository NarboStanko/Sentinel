// Flusso di connessione Google Drive: ottiene i primi token e attiva il
// GoogleDriveProvider. NON reimplementa nulla: upload/download/refresh e la
// persistenza token vivono già in storage/googleDrive.ts — qui c'è solo
// l'orchestrazione (login, riattivazione all'avvio, stato, disconnessione).
//
// Sicurezza: PKCE puro, NESSUN client secret (i client ID OAuth sono pubblici
// per definizione; il flusso nativo non deve mai contenere il secret).
//
// NOTA su expo-auth-session v5 (SDK 51): l'opzione `useProxy` e il proxy
// auth.expo.io sono stati rimossi/dismessi da Expo. Il flusso usa quindi il
// redirect a scheme nativo (sentinella://) con il client ID Android — lo
// stesso che il provider usa per il refresh, così i token restano coerenti.
import Constants from 'expo-constants';
import { makeRedirectUri } from 'expo-auth-session';
import { GoogleDriveProvider } from './storage/googleDrive';
import { setActiveProvider, clearActiveProvider } from './storage';

// Istanza unica: il provider tiene i token in memoria dopo loadSavedTokens().
let _provider: GoogleDriveProvider | null = null;
function getProvider(): GoogleDriveProvider {
  if (!_provider) _provider = new GoogleDriveProvider(); // throw se client ID mancante in extra
  return _provider;
}

// In modalità test (storageProvider: 'devblob') il provider attivo resta
// DevBlob: il login salva comunque i token, ma non scavalca il flag di test.
function storageConfig(): string {
  return (Constants.expoConfig?.extra?.storageProvider as string) ?? (__DEV__ ? 'devblob' : 'none');
}

/** Avvia il flusso OAuth (da un tap utente). Salva i token e attiva il provider. */
export async function loginToDrive(): Promise<void> {
  const provider = getProvider();
  // Stesso calcolo fatto da provider.authorize(): loggato per verificarlo
  // contro gli URI autorizzati nella console Google al primo test.
  const redirectUri = makeRedirectUri({ scheme: 'sentinella' });
  console.log('[driveAuth] redirectUri =', redirectUri);
  await provider.authorize(); // PKCE → access + refresh + scadenza in SecureStore
  if (storageConfig() !== 'devblob') setActiveProvider(provider);
}

/** true se ci sono token salvati (e li carica in memoria nel provider). */
export async function isDriveConnected(): Promise<boolean> {
  try {
    return await getProvider().loadSavedTokens();
  } catch {
    return false; // client ID mancante (es. piattaforma non configurata)
  }
}

/** All'avvio: se Drive era già connesso, riattiva il provider coi token salvati. */
export async function connectDriveIfSaved(): Promise<boolean> {
  if (!(await isDriveConnected())) return false;
  if (storageConfig() !== 'devblob') setActiveProvider(getProvider());
  return true;
}

/** Cancella i token e disattiva il provider. */
export async function disconnectDrive(): Promise<void> {
  await getProvider().clearTokens();
  if (storageConfig() !== 'devblob') clearActiveProvider();
}
