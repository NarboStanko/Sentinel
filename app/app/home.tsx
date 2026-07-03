import { useEffect, useState, useCallback } from 'react';
import { View, Text, AppState, Alert } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Screen, Card, Button, Pill, T } from '../components/ui';
import { colors, space } from '../theme';
import { api } from '../lib/api';
import { loadOwnerId, loadSwitchId } from '../lib/keystore';
import { formatDuration } from '../lib/timing';
import { isFacadeActive, FACADE_SWITCH } from '../lib/facadeStore';
import { loginToDrive, isDriveConnected, disconnectDrive } from '../lib/driveAuth';

const STATE_LABEL: Record<string, { label: string; tone: 'safe' | 'heartbeat' | 'danger' | 'neutral' }> = {
  ACTIVE: { label: 'ARMATO', tone: 'safe' },
  GRACE: { label: 'IN ATTESA DI RISPOSTA', tone: 'heartbeat' },
  APPROVAL_PENDING: { label: 'APPROVAZIONE IN CORSO', tone: 'danger' },
  RELEASED: { label: 'RILASCIATO', tone: 'danger' },
  DISARMED: { label: 'DISARMATO', tone: 'neutral' },
};

export default function Home() {
  const [sw, setSw] = useState<any>(null);
  const [switchId, setSwitchId] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number>(0);
  const [driveConnected, setDriveConnected] = useState<boolean | null>(null);

  const refresh = useCallback(async () => {
    // Modalità facciata: dati fittizi locali, nessuna chiamata al server.
    if (await isFacadeActive()) {
      setSwitchId(null);
      setSw({ ...FACADE_SWITCH });
      return;
    }
    const id = await loadSwitchId();
    setSwitchId(id);
    if (id) { const r = await api.getSwitch(id); setSw(r.switch); }
  }, []);

  useEffect(() => { isDriveConnected().then(setDriveConnected); }, []);

  async function connectDrive() {
    try {
      await loginToDrive();
      setDriveConnected(true);
      Alert.alert('Google Drive connesso', 'I tuoi pacchetti cifrati verranno caricati sul tuo Drive.');
    } catch (e: any) {
      alert('Connessione a Drive non riuscita: ' + (e?.message ?? 'Errore sconosciuto'));
    }
  }

  async function confirmDisconnectDrive() {
    // Guardia: con uno switch armato che usa Drive, la disconnessione
    // lascerebbe i contatti senza accesso al pacchetto. Fail-safe: se lo
    // stato non è verificabile (rete), si blocca comunque.
    const ARMED_STATES = ['ACTIVE', 'GRACE', 'APPROVAL_PENDING'];
    try {
      const id = await loadSwitchId();
      if (id) {
        const { switch: s } = await api.getSwitch(id);
        if (s && ARMED_STATES.includes(s.state)) {
          Alert.alert(
            'Switch attivo',
            'Hai 1 switch attivo che usa Google Drive. Disarmalo prima di disconnettere, ' +
            'altrimenti i tuoi contatti non potranno accedere al pacchetto.',
          );
          return;
        }
      }
    } catch {
      Alert.alert('Verifica non riuscita', 'Impossibile verificare lo stato degli switch. Riprova.');
      return;
    }
    Alert.alert(
      'Disconnettere Google Drive?',
      'I token di accesso verranno rimossi da questo dispositivo. I file già caricati restano sul tuo Drive.',
      [
        { text: 'Annulla', style: 'cancel' },
        {
          text: 'Disconnetti', style: 'destructive',
          onPress: async () => { await disconnectDrive(); setDriveConnected(false); },
        },
      ],
    );
  }

  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));
  useEffect(() => {
    const t = setInterval(() => {
      if (sw?.next_check_at) setRemaining(Math.max(0, Math.round((sw.next_check_at - Date.now()) / 1000)));
    }, 1000);
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') refresh(); });
    return () => { clearInterval(t); sub.remove(); };
  }, [sw, refresh]);

  async function tuttoOk() {
    if (!switchId) return;
    try {
      await api.checkin(switchId);
      refresh();
    } catch (e: any) {
      alert('Errore nel check-in: ' + (e?.message ?? 'Errore sconosciuto'));
    }
  }

  function confirmRestart() {
    Alert.alert(
      'Ricrea il pacchetto da zero?',
      'Questa azione è irreversibile:\n\n' +
      '• Verrà generata una nuova chiave di cifratura\n' +
      '• Le quote attuali dei contatti non saranno più valide\n' +
      '• Dovrai ri-armare lo switch e ridistribuire le quote ai contatti\n\n' +
      'I contatti non ricevono notifica automatica.\n\n' +
      'Per aggiungere contenuto senza invalidare le quote usa invece "Aggiungi al pacchetto".',
      [
        { text: 'Annulla', style: 'cancel' },
        { text: 'Ricrea da zero', style: 'destructive', onPress: () => router.push('/compose') },
      ],
    );
  }

  const meta = STATE_LABEL[sw?.state ?? 'DISARMED'];
  const armed = sw && sw.state !== 'DISARMED';

  return (
    <Screen>
      <Text style={T.display}>Sentinella</Text>

      <Card tone={meta.tone === 'neutral' ? 'surface' : meta.tone}>
        <Pill label={meta.label} tone={meta.tone} />
        {armed ? (
          <>
            <Text style={[T.body, { marginTop: space(2) }]}>
              {sw.state === 'ACTIVE' && 'Tutto tranquillo. Prossimo controllo tra:'}
              {sw.state === 'GRACE' && 'Devi confermare ora, o partirà la richiesta ai contatti.'}
              {sw.state === 'APPROVAL_PENDING' && 'I tuoi contatti stanno decidendo se rilasciare.'}
              {sw.state === 'RELEASED' && 'La documentazione è stata rilasciata.'}
            </Text>
            {(sw.state === 'ACTIVE' || sw.state === 'GRACE') && (
              <Text style={{ fontSize: 44, fontWeight: '800', color: colors.ink, letterSpacing: -1 }}>
                {Math.floor(remaining / 60)}m {remaining % 60}s
              </Text>
            )}
            {sw.state === 'ACTIVE' && sw.interval_sec && (
              <Text style={{ fontSize: 12, color: colors.inkFaint }}>
                ogni {formatDuration(sw.interval_sec)} · grazia {formatDuration(sw.grace_sec)}
              </Text>
            )}
            {(sw.state === 'ACTIVE' || sw.state === 'GRACE') && (
              <Button label="Tutto ok" onPress={tuttoOk} variant="safe" />
            )}
          </>
        ) : (
          <Text style={T.dim}>Nessuno switch armato. Prepara un pacchetto per attivare la protezione.</Text>
        )}
      </Card>

      <View style={{ gap: space(3), marginTop: space(2) }}>
        <Button label="Contatti fidati" onPress={() => router.push('/contacts')} variant="ghost" />
        <Button label="Backup seed" onPress={() => router.push('/backup')} variant="ghost" />
        <Button label="PIN di emergenza" onPress={() => router.push('/duress-setup')} variant="ghost" />
        <Button label="Recovery" onPress={() => router.push('/social-recovery')} variant="ghost" />
        <Button label="Strumenti di verifica" onPress={() => router.push('/audit-tools')} variant="ghost" />
        {driveConnected === false && (
          <Button label="Connetti Google Drive" onPress={connectDrive} variant="ghost" />
        )}
        {driveConnected === true && (
          <Button label="Google Drive connesso — disconnetti" onPress={confirmDisconnectDrive} variant="ghost" />
        )}
        {sw?.state === 'ACTIVE' && (
          <Button label="Aggiungi al pacchetto" onPress={() => router.push({ pathname: '/compose', params: { mode: 'add' } })} variant="ghost" />
        )}
        {sw?.state === 'ACTIVE' && (
          <Button label="Ricrea da zero…" onPress={confirmRestart} variant="ghost" />
        )}
        {!armed && (
          <Button label="Prepara il pacchetto" onPress={() => router.push('/compose')} variant="ghost" />
        )}
        {armed && <Button label="Disarma" onPress={async () => { await api.disarm(switchId!); refresh(); }} variant="ghost" />}
      </View>

      <Text style={[T.dim, { marginTop: space(4) }]}>
        Il battito è gestito dal server: anche con l'app chiusa, riceverai una notifica «tutto ok?».
      </Text>
    </Screen>
  );
}
