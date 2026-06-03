import { useState } from 'react';
import { View, Text, TextInput } from 'react-native';
import { router } from 'expo-router';
import { Screen, Card, Button, T } from '../components/ui';
import { colors, space } from '../theme';
import { isValidSeedPhrase, identityFromSeed, bytesToHex, signChallenge } from '../lib/crypto';
import { saveSeed, saveOwnerId, saveSwitchId, saveAuthToken } from '../lib/keystore';
import { api } from '../lib/api';

type Step = 'input' | 'warning';

export default function Restore() {
  const [seedInput, setSeedInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<Step>('input');
  const [error, setError] = useState<string | null>(null);
  const [pendingSwitch, setPendingSwitch] = useState<any>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [resolvedSwitchId, setResolvedSwitchId] = useState<string | null>(null);

  async function handleRestore() {
    setError(null);
    const trimmed = seedInput.trim().toLowerCase();
    if (!isValidSeedPhrase(trimmed)) {
      setError('Seed phrase non valida. Controlla le 12 parole e riprova.');
      return;
    }
    setBusy(true);
    try {
      const identity = identityFromSeed(trimmed);
      const pubHex = bytesToHex(identity.pub);

      // Challenge → firma → verifica
      const { nonce } = await api.authChallenge(pubHex);
      const sig = signChallenge(identity.priv, nonce);
      const result = await api.authVerify(pubHex, nonce, sig);

      if (!result.ok || !result.token || !result.ownerId) {
        setError(result.reason ?? 'Autenticazione fallita. Questo account non esiste o la seed è errata.');
        return;
      }

      // Persisti identità
      await saveSeed(trimmed);
      await saveOwnerId(result.ownerId);
      await saveAuthToken(result.token);
      setSessionToken(result.token);

      // Cerca lo switch attivo
      const switches: any[] = result.switches ?? [];
      const active = switches.find((s: any) => s.state !== 'DISARMED');
      if (active) {
        await saveSwitchId(active.id);
        setResolvedSwitchId(active.id);
      }

      // Controlla se c'è un rilascio in corso
      const pending = switches.find(
        (s: any) => s.state === 'GRACE' || s.state === 'APPROVAL_PENDING'
      );
      if (pending) {
        setPendingSwitch(pending);
        setStep('warning');
      } else {
        router.replace('/home');
      }
    } catch (e: any) {
      setError(e?.message ?? 'Errore di rete. Riprova.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDisarm() {
    if (!resolvedSwitchId) { router.replace('/home'); return; }
    setBusy(true);
    try {
      await api.disarm(resolvedSwitchId);
      if (sessionToken) {
        api.auditSeedRestoreAck(sessionToken, resolvedSwitchId).catch(() => {});
      }
    } catch { /* best effort */ } finally {
      setBusy(false);
    }
    router.replace('/home');
  }

  function handleLeaveArmed() {
    router.replace('/home');
  }

  if (step === 'warning' && pendingSwitch) {
    return (
      <Screen>
        <Text style={T.display}>Attenzione</Text>

        <Card tone="danger">
          <Text style={T.heading}>Rilascio in corso</Text>
          <Text style={T.body}>
            Lo switch è attualmente in stato{' '}
            <Text style={{ fontWeight: '700' }}>{pendingSwitch.state}</Text>.
          </Text>
          <Text style={T.dim}>
            I tuoi contatti potrebbero stare approvando un rilascio. Puoi disarmare subito
            per interrompere il processo, oppure lasciare armato e accedere all'app normalmente.
          </Text>
        </Card>

        <Card tone="heartbeat">
          <Text style={T.label}>AVVISO DEK</Text>
          <Text style={T.dim}>
            La chiave di cifratura (DEK) non è recuperabile dalla sola seed. Puoi fare
            check-in e disarmare, ma non aggiungere contenuto finché non riarmi lo switch
            con una nuova DEK.
          </Text>
        </Card>

        <Button
          label={busy ? 'Attendi…' : 'Disarma adesso'}
          onPress={handleDisarm}
          variant="danger"
          disabled={busy}
        />
        <Button
          label="Vai all'app (lascia armato)"
          onPress={handleLeaveArmed}
          variant="ghost"
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <Text style={T.display}>Ripristina account</Text>
      <Text style={T.dim}>
        Inserisci le 12 parole della tua seed phrase per accedere al tuo account su questo dispositivo.
      </Text>

      <Card>
        <Text style={T.heading}>Seed phrase</Text>
        <TextInput
          value={seedInput}
          onChangeText={setSeedInput}
          placeholder="parola1 parola2 parola3 … parola12"
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          style={{
            borderWidth: 1,
            borderColor: colors.line,
            borderRadius: 8,
            padding: space(3),
            fontSize: 16,
            color: colors.ink,
            minHeight: 80,
            textAlignVertical: 'top',
          }}
        />
        {error && (
          <View style={{ backgroundColor: colors.dangerSoft, borderRadius: 8, padding: space(3) }}>
            <Text style={[T.dim, { color: colors.danger }]}>{error}</Text>
          </View>
        )}
        <Button
          label={busy ? 'Verifica in corso…' : 'Ripristina'}
          onPress={handleRestore}
          disabled={busy || seedInput.trim().length === 0}
        />
      </Card>

      <Card tone="heartbeat">
        <Text style={T.label}>NOTA SULLA DEK</Text>
        <Text style={T.dim}>
          La chiave di cifratura del contenuto non è derivabile dalla seed: è generata casualmente
          al momento dell'armo. Puoi fare check-in e disarmare, ma non aggiungere contenuto
          finché non riarmi lo switch da zero.
        </Text>
      </Card>
    </Screen>
  );
}
