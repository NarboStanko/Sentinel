import 'react-native-get-random-values';
import '../lib/polyfills'; // TextEncoder/TextDecoder per Hermes — prima di ogni modulo che li usa
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { Stack, router, usePathname } from 'expo-router';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { colors } from '../theme';
import { setupNotificationChannel, registerPushToken } from '../lib/notifications';
import { loadOwnerId, loadIdentity } from '../lib/keystore';
import { setActiveProvider } from '../lib/storage';
import { DevBlobProvider } from '../lib/storage/devBlob';
import { connectDriveIfSaved } from '../lib/driveAuth';
import { isUnlocked, setUnlocked, setPendingRoute, noteBackground, shouldRelock } from '../lib/lockState';

// Provider di storage inizializzato a livello di modulo (prima di qualsiasi render).
// Regole di selezione (extra.storageProvider in app.json):
//   'devblob' → DevBlobProvider (override esplicito di sviluppo/test)
//   'auto' o assente (release) → Google Drive se connesso, altrimenti NESSUN
//     provider: l'app non crasha, ma l'armo è bloccato finché l'utente non
//     connette Drive (guardia in compose.tsx).
const storageProviderName = (Constants.expoConfig?.extra?.storageProvider as string) ?? 'auto';
if (storageProviderName === 'devblob') {
  setActiveProvider(new DevBlobProvider());
} else {
  connectDriveIfSaved().catch(() => {});
}

// Handler globale: mostra la notifica anche se l'app è in foreground.
// Deve essere registrato prima che qualunque notifica arrivi.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

export default function Layout() {
  // ref per evitare di registrare il listener più volte (StrictMode / hot reload)
  const responseListenerRef = useRef<Notifications.Subscription | null>(null);

  // Pathname corrente in ref: i listener (notifiche, AppState) sono registrati
  // una volta sola e non devono catturare un valore stantio.
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  useEffect(() => { pathnameRef.current = pathname; }, [pathname]);

  // Naviga verso /lock solo se non ci siamo già: un secondo replace rimonta la
  // lock screen e cancella il PIN che l'utente sta digitando.
  function goToLock() {
    if (pathnameRef.current !== '/lock') router.replace('/lock');
  }

  // Routing puro: usa solo data.type, mai identificatori sensibili dal payload.
  // Lo state reale (quale switch) viene risolto da /pending su TLS.
  // Se l'app è bloccata — O sta per ribloccarsi al rientro in foreground
  // (shouldRelock) — la destinazione viene parcheggiata e si passa dalla lock
  // screen, che la riprende dopo lo sblocco. Il controllo shouldRelock è
  // essenziale: l'ordine tra questo listener e il handler AppState che esegue
  // il relock non è garantito, e senza controllo il tap sulla notifica faceva
  // push su /approve, il relock lo sostituiva con /lock, e dopo lo sblocco
  // l'utente finiva su /home invece che sulla pagina di trasmissione quota.
  function routeFromData(data: Record<string, unknown>) {
    const dest =
      data.type === 'checkin'  ? '/home' :
      data.type === 'approval' ? '/approve' :
      data.type === 'recovery' ? '/social-recovery' : null;
    if (!dest) return;
    if (!isUnlocked() || shouldRelock()) {
      setPendingRoute(dest);
      goToLock();
      return;
    }
    router.push(dest as any);
  }

  useEffect(() => {
    (async () => {
      // 1. Channel PRIMA DI TUTTO su Android 8+ (senza channel le notifiche spariscono)
      await setupNotificationChannel();

      // 2. Registra il push token dell'owner se l'utente è già onboardato
      const ownerId = await loadOwnerId();
      if (ownerId) {
        registerPushToken('owner', ownerId).catch(() => {});
      }

      // 3. Gestisce il tap su notifica che ha avviato/risvegliato l'app (cold start)
      const identity = await loadIdentity();
      if (identity) {
        const last = await Notifications.getLastNotificationResponseAsync();
        if (last) {
          routeFromData(last.notification.request.content.data as Record<string, unknown>);
        }
      }
    })();

    // 4. Listener per tap con app in vita (idempotente via ref)
    if (!responseListenerRef.current) {
      responseListenerRef.current = Notifications.addNotificationResponseReceivedListener(
        (response) => {
          routeFromData(response.notification.request.content.data as Record<string, unknown>);
        }
      );
    }

    // 5. Riblocco dopo background prolungato (> LOCK_TIMEOUT_MS): al ritorno
    // in foreground l'app richiede di nuovo il PIN. Sotto soglia resta sbloccata.
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        noteBackground();
      } else if (state === 'active' && shouldRelock()) {
        setUnlocked(false);
        // goToLock (non replace diretto): se il listener notifiche ha già
        // parcheggiato la destinazione e navigato su /lock, un secondo replace
        // rimonterebbe la schermata azzerando il PIN digitato.
        goToLock();
      }
    });

    return () => {
      responseListenerRef.current?.remove();
      responseListenerRef.current = null;
      appStateSub.remove();
    };
  }, []);

  return (
    <Stack screenOptions={{
      headerStyle: { backgroundColor: colors.bg },
      headerShadowVisible: false,
      headerTintColor: colors.ink,
      headerTitleStyle: { fontWeight: '600' },
      contentStyle: { backgroundColor: colors.bg },
    }}>
      <Stack.Screen name="index"           options={{ headerShown: false }} />
      <Stack.Screen name="lock"            options={{ headerShown: false, gestureEnabled: false }} />
      <Stack.Screen name="home"            options={{ headerShown: false }} />
      <Stack.Screen name="contacts"        options={{ title: 'Contatti fidati' }} />
      <Stack.Screen name="add-friend"      options={{ title: 'Aggiungi amico' }} />
      <Stack.Screen name="compose"         options={{ title: 'Prepara il pacchetto' }} />
      <Stack.Screen name="approve"         options={{ title: 'Richiesta di rilascio' }} />
      <Stack.Screen name="received"        options={{ title: 'Pacchetti ricevuti' }} />
      <Stack.Screen name="received-package" options={{ title: 'Pacchetto ricevuto' }} />
      <Stack.Screen name="restore"         options={{ title: 'Ripristina account' }} />
      <Stack.Screen name="backup"          options={{ title: 'Backup seed' }} />
      <Stack.Screen name="social-recovery"  options={{ title: 'Recovery identità' }} />
      <Stack.Screen name="verify-seed"      options={{ title: 'Verifica seed' }} />
      <Stack.Screen name="audit-tools"      options={{ title: 'Strumenti di verifica' }} />
      <Stack.Screen name="verify-failed"    options={{ title: 'Verifica integrità' }} />
      <Stack.Screen name="recovery-confirm" options={{ title: 'Conferma recovery' }} />
      <Stack.Screen name="duress-setup"     options={{ title: 'PIN di emergenza' }} />
    </Stack>
  );
}
