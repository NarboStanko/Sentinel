import 'react-native-get-random-values';
import { useEffect, useRef } from 'react';
import { Stack, router } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { colors } from '../theme';
import { setupNotificationChannel, registerPushToken } from '../lib/notifications';
import { loadOwnerId, loadIdentity } from '../lib/keystore';
import { setActiveProvider } from '../lib/storage';
import { DevBlobProvider } from '../lib/storage/devBlob';

// Provider di storage inizializzato a livello di modulo (prima di qualsiasi render).
// Dev: DevBlobProvider attivo di default — nessuna azione manuale richiesta.
// Produzione: nessun default; GoogleDriveProvider va attivato dopo che l'utente
// ha completato l'OAuth (chiama setActiveProvider(new GoogleDriveProvider()) dopo
// provider.authorize() nella schermata di configurazione storage).
if (__DEV__) {
  setActiveProvider(new DevBlobProvider());
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

// Routing puro: usa solo data.type, mai identificatori sensibili dal payload.
// Lo state reale (quale switch) viene risolto da /pending su TLS.
function routeFromData(data: Record<string, unknown>) {
  if (data.type === 'checkin') {
    router.push('/home');
  } else if (data.type === 'approval') {
    router.push('/approve');
  } else if (data.type === 'recovery') {
    router.push('/social-recovery');
  }
}

export default function Layout() {
  // ref per evitare di registrare il listener più volte (StrictMode / hot reload)
  const responseListenerRef = useRef<Notifications.Subscription | null>(null);

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

    return () => {
      responseListenerRef.current?.remove();
      responseListenerRef.current = null;
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
      <Stack.Screen name="home"            options={{ headerShown: false }} />
      <Stack.Screen name="contacts"        options={{ title: 'Contatti fidati' }} />
      <Stack.Screen name="add-friend"      options={{ title: 'Aggiungi amico' }} />
      <Stack.Screen name="compose"         options={{ title: 'Prepara il pacchetto' }} />
      <Stack.Screen name="approve"         options={{ title: 'Richiesta di rilascio' }} />
      <Stack.Screen name="restore"         options={{ title: 'Ripristina account' }} />
      <Stack.Screen name="backup"          options={{ title: 'Backup seed' }} />
      <Stack.Screen name="social-recovery"  options={{ title: 'Recovery identità' }} />
      <Stack.Screen name="verify-seed"      options={{ title: 'Verifica seed' }} />
      <Stack.Screen name="audit-tools"      options={{ title: 'Strumenti di verifica' }} />
      <Stack.Screen name="verify-failed"    options={{ title: 'Verifica integrità' }} />
      <Stack.Screen name="recovery-confirm" options={{ title: 'Conferma recovery' }} />
    </Stack>
  );
}
