import { View, Text, Pressable } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Screen, Card, Button, T } from '../components/ui';
import { colors, space } from '../theme';

export default function VerifyFailed() {
  const params = useLocalSearchParams<{
    firstBadIndex: string;
    chainIndexAnchor: string;
    reason: string;
  }>();

  const firstBadIndex    = parseInt(params.firstBadIndex ?? '-1', 10);
  const chainIndexAnchor = parseInt(params.chainIndexAnchor ?? '-1', 10);
  const reason           = params.reason ?? 'discrepanza rilevata';

  function goBack() {
    router.back();
  }

  function goRecoveryConfirm() {
    router.push({
      pathname: '/recovery-confirm',
      params: { firstBadIndex, chainIndexAnchor },
    });
  }

  function goHome() {
    router.push('/home');
  }

  return (
    <Screen>
      <Text style={[T.title, { marginBottom: space(2) }]}>
        Verifica integrità: discrepanza rilevata
      </Text>

      <Card tone="danger">
        <Text style={T.label}>PROBLEMA RILEVATO</Text>
        <Text style={T.body}>
          La catena di audit non corrisponde all'ancoraggio che hai inserito. La discrepanza è stata
          rilevata all'evento numero {firstBadIndex >= 0 ? firstBadIndex : '?'}.
        </Text>
      </Card>

      <Card>
        <Text style={T.label}>POSSIBILI CAUSE</Text>
        <Text style={T.body}>
          Possibili cause: (1) il server è stato effettivamente manomesso e qualcuno ha alterato la
          tua cronologia; (2) hai inserito un ancoraggio sbagliato o trascritto male un carattere;
          (3) un bug del sistema. La causa più comune è la (2).
        </Text>
      </Card>

      <Card>
        <Text style={T.label}>PRIMA DI PROCEDERE</Text>
        <Text style={T.body}>
          Prima di procedere col recovery, verifica: hai inserito l'ancoraggio corretto? Hai un altro
          ancoraggio salvato (es. su un altro dispositivo o supporto) che puoi provare? Hai
          recentemente cambiato dispositivo?
        </Text>
      </Card>

      <Card tone="heartbeat">
        <Text style={T.label}>AVVERTENZA IMPORTANTE</Text>
        <Text style={T.body}>
          Il recovery sociale è un'azione irreversibile per 7 giorni: invalida tutte le quote
          distribuite ai contatti, e dovrai rifare il pairing con loro per ri-armare gli switch.
          Usalo solo se sei convinto che il server sia compromesso.
        </Text>
      </Card>

      <View style={{ gap: space(3), marginTop: space(2) }}>
        <Button
          label="Riprova con un altro ancoraggio"
          onPress={goBack}
          variant="primary"
        />

        <Button
          label="Voglio avviare il recovery sociale"
          onPress={goRecoveryConfirm}
          variant="ghost"
        />

        <Pressable onPress={goHome} style={{ alignItems: 'center', paddingVertical: space(3) }}>
          <Text style={[T.dim, { color: colors.inkFaint }]}>Chiudi</Text>
        </Pressable>
      </View>
    </Screen>
  );
}
