import { useEffect, useState } from 'react';
import { View, Text } from 'react-native';
import { router } from 'expo-router';
import { Screen, Card, Button, T } from '../components/ui';
import { colors, radius, space } from '../theme';
import { newSeedPhrase, identityFromSeed, fingerprint, bytesToHex } from '../lib/crypto';
import { saveSeed, loadIdentity, saveOwnerId } from '../lib/keystore';
import { api } from '../lib/api';
import { registerPushToken } from '../lib/notifications';

export default function Onboarding() {
  const [seed, setSeed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { loadIdentity().then((id) => { if (id) router.replace('/home'); }); }, []);

  function generate() { setSeed(newSeedPhrase()); }

  async function confirm() {
    if (!seed) return;
    setBusy(true);
    try {
      await saveSeed(seed);
      const id = identityFromSeed(seed);
      const { ownerId } = await api.registerOwner(bytesToHex(id.pub));
      await saveOwnerId(ownerId);
      // Registra subito il push token: senza, l'owner non riceve la notifica
      // «Tutto ok?» fino al riavvio successivo dell'app (il _layout la chiama
      // solo se ownerId era già presente all'avvio).
      registerPushToken('owner', ownerId).catch(() => {});
      router.replace('/home');
    } finally { setBusy(false); }
  }

  const words = seed?.split(' ') ?? [];

  return (
    <Screen>
      <Text style={T.display}>Sentinella</Text>
      <Text style={T.dim}>
        Prepara a freddo cosa rilasciare e a chi. Se un giorno smetti di rispondere, ci pensa lei.
      </Text>

      {!seed ? (
        <Card style={{ marginTop: space(4) }}>
          <Text style={T.heading}>La tua identità</Text>
          <Text style={T.dim}>
            Nasce da 12 parole. Sono l'unico modo per ritrovare la tua chiave se cambi telefono —
            scrivile su carta e tienile al sicuro. Non finiscono mai su un server.
          </Text>
          <Button label="Genera la mia seed phrase" onPress={generate} />
        </Card>
      ) : (
        <>
          <Card tone="heartbeat">
            <Text style={T.label}>SCRIVI QUESTE 12 PAROLE</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2) }}>
              {words.map((w, i) => (
                <View key={i} style={{ flexDirection: 'row', alignItems: 'baseline', backgroundColor: colors.surface, borderRadius: radius.sm, paddingHorizontal: space(3), paddingVertical: space(2), minWidth: '30%' }}>
                  <Text style={{ color: colors.heartbeat, fontWeight: '700', width: 22 }}>{i + 1}</Text>
                  <Text style={{ color: colors.ink, fontSize: 15 }}>{w}</Text>
                </View>
              ))}
            </View>
            <Text style={[T.dim, { color: colors.heartbeat }]}>
              Chiunque abbia queste parole può impersonarti. Non fotografarle, non salvarle in chiaro.
            </Text>
          </Card>
          <Button label={busy ? 'Attendi…' : 'Le ho scritte, continua'} onPress={confirm} variant="safe" disabled={busy} />
          <Button label="Rigenera" onPress={generate} variant="ghost" />
        </>
      )}
    </Screen>
  );
}
