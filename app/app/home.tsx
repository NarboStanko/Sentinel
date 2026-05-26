import { useEffect, useState, useCallback } from 'react';
import { View, Text, AppState } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Screen, Card, Button, Pill, T } from '../components/ui';
import { colors, space } from '../theme';
import { api } from '../lib/api';
import { loadOwnerId, loadSwitchId } from '../lib/keystore';

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

  const refresh = useCallback(async () => {
    const id = await loadSwitchId();
    setSwitchId(id);
    if (id) { const r = await api.getSwitch(id); setSw(r.switch); }
  }, []);

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
        <Button label={armed ? 'Modifica pacchetto' : 'Prepara il pacchetto'} onPress={() => router.push('/compose')} variant="ghost" />
        {armed && <Button label="Disarma" onPress={async () => { await api.disarm(switchId!); refresh(); }} variant="ghost" />}
      </View>

      <Text style={[T.dim, { marginTop: space(4) }]}>
        Il battito è gestito dal server: anche con l'app chiusa, riceverai una notifica «tutto ok?».
      </Text>
    </Screen>
  );
}
