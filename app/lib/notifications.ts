// Gestione push notifications.
// REGOLA: il payload ricevuto contiene solo { type: 'checkin' | 'approval' }.
// Il routing reale (quale switch aprire) avviene chiamando /pending su TLS,
// mai fidandosi del payload.
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { api } from './api';

// Deve essere chiamata PRIMA di qualunque altra cosa su Android (8+).
// Senza channel le notifiche vengono scartate in silenzio.
export async function setupNotificationChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('default', {
    name: 'Sentinella',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: '#3E8E72',
  });
}

// Richiede i permessi e registra il push token con il server.
// Si chiama: owner → dopo onboarding; contatto → subito dopo /pair.
// Silenzia gli errori: se l'utente rifiuta i permessi o manca il projectId,
// il sistema funziona lo stesso (battito via polling su TLS).
export async function registerPushToken(
  role: 'owner' | 'contact',
  id: string
): Promise<void> {
  const projectId = (Constants.expoConfig?.extra as any)?.eas?.projectId;
  if (!projectId || projectId === '00000000-0000-0000-0000-000000000000') {
    console.warn('[notifications] EAS projectId non configurato — skip registrazione token');
    return;
  }

  let finalStatus: string;
  try {
    const { status: existing } = await Notifications.getPermissionsAsync();
    finalStatus = existing;
    if (existing !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
  } catch {
    return; // permessi non disponibili (simulatore, web)
  }
  if (finalStatus !== 'granted') return;

  try {
    const token = await Notifications.getExpoPushTokenAsync({ projectId });
    console.log('PUSH_TOKEN >>>', token.data);
    await api.registerPush(role, id, token.data);
  } catch (e) {
    console.warn('[notifications] registrazione token fallita:', e);
  }
}
