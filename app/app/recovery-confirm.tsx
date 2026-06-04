import { useState } from 'react';
import { View, Text, TextInput, Pressable, Alert } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Screen, Card, Button, T } from '../components/ui';
import { colors, space, radius } from '../theme';
import { loadIdentity } from '../lib/keystore';
import { postAnchorEvent } from '../lib/auditChain';

const CONFIRM_PHRASE = 'AVVIA RECOVERY';

export default function RecoveryConfirm() {
  const params = useLocalSearchParams<{
    firstBadIndex: string;
    chainIndexAnchor: string;
  }>();

  const firstBadIndex    = parseInt(params.firstBadIndex ?? '-1', 10);
  const chainIndexAnchor = parseInt(params.chainIndexAnchor ?? '-1', 10);

  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy]               = useState(false);

  const canConfirm = confirmText === CONFIRM_PHRASE;

  async function handleConfirm() {
    if (!canConfirm) return;
    setBusy(true);
    try {
      const id = await loadIdentity();
      if (id) {
        await postAnchorEvent(
          'RECOVERY_CONFIRMED_AFTER_VERIFICATION_FAIL',
          { firstBadIndex, chainIndexAnchor },
          id,
        ).catch(() => {});
      }
      router.push('/social-recovery');
    } catch (e: any) {
      Alert.alert('Errore', e?.message ?? 'Impossibile avviare il recovery.');
    } finally {
      setBusy(false);
    }
  }

  function handleCancel() {
    router.back();
  }

  return (
    <Screen>
      <Text style={[T.title, { marginBottom: space(2) }]}>
        Conferma avvio recovery sociale
      </Text>

      <Card>
        <Text style={T.label}>CONSEGUENZE IRREVERSIBILI</Text>
        <View style={{ gap: space(2), marginTop: space(1) }}>
          {[
            'La tua chiave attuale sarà invalidata fra 7 giorni.',
            'Tutte le quote Shamir distribuite ai contatti diventeranno inutilizzabili.',
            'Dovrai rifare il pairing in persona con ciascun contatto.',
            'Gli switch armati dovranno essere ri-armati con la nuova chiave.',
            'Hai 7 giorni per annullare questa procedura (nella schermata Social recovery).',
          ].map((item, i) => (
            <View key={i} style={{ flexDirection: 'row', gap: space(2), alignItems: 'flex-start' }}>
              <Text style={[T.body, { color: colors.inkDim }]}>•</Text>
              <Text style={[T.body, { flex: 1, color: colors.inkDim }]}>{item}</Text>
            </View>
          ))}
        </View>
      </Card>

      <Card tone="danger">
        <Text style={T.label}>CONFERMA AZIONE</Text>
        <Text style={[T.body, { color: colors.inkDim, marginBottom: space(2) }]}>
          Digita esattamente la frase seguente per abilitare il bottone:
        </Text>
        <Text style={[T.mono, { color: colors.ink, marginBottom: space(3), textAlign: 'center' }]}>
          {CONFIRM_PHRASE}
        </Text>
        <TextInput
          value={confirmText}
          onChangeText={setConfirmText}
          placeholder="Digita: AVVIA RECOVERY"
          placeholderTextColor={colors.inkFaint}
          autoCapitalize="characters"
          autoCorrect={false}
          style={{
            borderWidth: 1,
            borderColor: canConfirm ? colors.danger : colors.line,
            borderRadius: radius.md,
            padding: space(4),
            fontSize: 16,
            color: colors.ink,
            backgroundColor: colors.surface,
            fontFamily: 'Courier',
            textAlign: 'center',
          }}
        />
      </Card>

      <View style={{ gap: space(3) }}>
        <Button
          label="Conferma e avvia"
          onPress={handleConfirm}
          variant="danger"
          disabled={!canConfirm || busy}
        />

        <Pressable onPress={handleCancel} style={{ alignItems: 'center', paddingVertical: space(3) }}>
          <Text style={[T.body, { color: colors.inkDim }]}>Annulla</Text>
        </Pressable>
      </View>
    </Screen>
  );
}
