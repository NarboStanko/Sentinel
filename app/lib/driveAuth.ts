// Connessione Google Drive via Google Sign-In NATIVO (selettore account Android):
// nessun redirect URI, nessun browser, refresh token gestito nativamente.
// Il GoogleDriveProvider (upload/download/delete) è riusato tal quale: riceve
// da qui una token-source (getDriveAccessToken) e non gestisce più OAuth.
//
// Sicurezza: NESSUN client secret. La libreria usa il WEB client ID per il
// login Android (richiesto dall'API Google), ma il flusso resta nativo e
// senza secret; il client Android è registrato in console via package+SHA-1.
import Constants from 'expo-constants';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { GoogleDriveProvider } from './storage/googleDrive';
import { setActiveProvider, clearActiveProvider } from './storage';

// drive.file = accesso solo ai file creati dall'app (minimo privilegio).
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

let configured = false;
function ensureConfigured(): void {
  if (configured) return;
  const webClientId = Constants.expoConfig?.extra?.googleDriveClientIdWeb as string | undefined;
  if (!webClientId) {
    throw new Error('[driveAuth] googleDriveClientIdWeb mancante in app.json extra.');
  }
  GoogleSignin.configure({
    webClientId,               // SÌ, il WEB client ID anche per il login Android
    scopes: [SCOPE],
    offlineAccess: true,       // necessario per il refresh token
  });
  configured = true;
}

// Istanza unica del provider, alimentata dalla token-source qui sotto.
let _provider: GoogleDriveProvider | null = null;
function getProvider(): GoogleDriveProvider {
  if (!_provider) _provider = new GoogleDriveProvider(getDriveAccessToken);
  return _provider;
}

// In modalità test (storageProvider: 'devblob') il provider attivo resta
// DevBlob: il login salva comunque la sessione, ma non scavalca il flag di test.
function storageConfig(): string {
  return (Constants.expoConfig?.extra?.storageProvider as string) ?? (__DEV__ ? 'devblob' : 'none');
}

/**
 * Token-source per il GoogleDriveProvider: GoogleSignin.getTokens() rinnova
 * automaticamente l'access token se scaduto (refresh nativo — la vecchia
 * logica di refresh manuale del provider non serve più).
 */
export async function getDriveAccessToken(): Promise<string> {
  ensureConfigured();
  const { accessToken } = await GoogleSignin.getTokens();
  return accessToken;
}

/** Avvia il login nativo (da un tap utente) e attiva il provider. */
export async function loginToDrive(): Promise<void> {
  ensureConfigured();
  await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  await GoogleSignin.signIn();
  await GoogleSignin.getTokens(); // verifica subito che l'access token arrivi
  if (storageConfig() !== 'devblob') setActiveProvider(getProvider());
}

/** true se c'è una sessione Google valida (ripristinata in silenzio se serve). */
export async function isDriveConnected(): Promise<boolean> {
  try {
    ensureConfigured();
    if (GoogleSignin.getCurrentUser() !== null) return true;
    if (!GoogleSignin.hasPreviousSignIn()) return false;
    await GoogleSignin.signInSilently();
    return true;
  } catch {
    return false;
  }
}

/** All'avvio: se Drive era già connesso, riattiva il provider. */
export async function connectDriveIfSaved(): Promise<boolean> {
  if (!(await isDriveConnected())) return false;
  if (storageConfig() !== 'devblob') setActiveProvider(getProvider());
  return true;
}

/** Scollega l'account Google e disattiva il provider. */
export async function disconnectDrive(): Promise<void> {
  ensureConfigured();
  try { await GoogleSignin.signOut(); } catch { /* già disconnesso */ }
  if (storageConfig() !== 'devblob') clearActiveProvider();
}
