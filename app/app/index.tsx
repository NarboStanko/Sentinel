import { useEffect, useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { Screen, Card, Button, T } from '../components/ui';
import { colors, radius, space } from '../theme';
import { newSeedPhrase, identityFromSeed, bytesToHex } from '../lib/crypto';
import { saveSeed, loadIdentity, saveOwnerId } from '../lib/keystore';
import { api } from '../lib/api';
import { registerPushToken } from '../lib/notifications';

export default function Onboarding() {
  const [seed, setSeed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmedBackup, setConfirmedBackup] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => { loadIdentity().then((id) => { if (id) router.replace('/home'); }); }, []);

  function generate() {
    setSeed(newSeedPhrase());
    setConfirmedBackup(false);
    setCopied(false);
  }

  async function copySeed() {
    if (!seed) return;
    await Clipboard.setStringAsync(seed);
    setCopied(true);
    // reset after 10s so user doesn't think it's still in clipboard
    setTimeout(() => setCopied(false), 10000);
  }

  async function confirm() {
    if (!seed || !confirmedBackup) return;
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
        <>
          <Card style={{ marginTop: space(4) }}>
            <Text style={T.heading}>La tua identità</Text>
            <Text style={T.dim}>
              Nasce da 12 parole. Sono l'unico modo per ritrovare la tua chiave se cambi telefono —
              scrivile su carta e tienile al sicuro. Non finiscono mai su un server.
            </Text>
            <Button label="Genera la mia seed phrase" onPress={generate} />
          </Card>
          <Button
            label="Ho già un account — ripristina da seed"
            onPress={() => router.push('/restore')}
            variant="ghost"
          />
        </>
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
            <Button
              label={copied ? 'Copiata negli appunti (cancella presto)' : 'Copia seed'}
              onPress={copySeed}
              variant="ghost"
            />
          </Card>

          <Button
            label="Verifica che le hai scritte (consigliato)"
            onPress={async () => { if (seed) { await saveSeed(seed); router.push('/verify-seed'); } }}
            variant="ghost"
          />

          {/* Conferma scritta */}
          <Pressable
            onPress={() => setConfirmedBackup((p) => !p)}
            style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space(3), padding: space(2) }}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: confirmedBackup }}
          >
            <View style={{
              width: 22, height: 22, borderRadius: 6,
              borderWidth: 2, borderColor: confirmedBackup ? colors.safe : colors.line,
              backgroundColor: confirmedBackup ? colors.safe : 'transparent',
              alignItems: 'center', justifyContent: 'center', marginTop: 1,
            }}>
              {confirmedBackup && <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>✓</Text>}
            </View>
            <Text style={[T.dim, { flex: 1 }]}>
              Ho scritto la seed in un posto sicuro. Capisco che senza di essa non posso recuperare l'account.
            </Text>
          </Pressable>

          <Button
            label={busy ? 'Attendi…' : 'Le ho scritte, continua'}
            onPress={confirm}
            variant="safe"
            disabled={busy || !confirmedBackup}
          />
          <Button label="Rigenera" onPress={generate} variant="ghost" />
        </>
      )}
    </Screen>
  );
}
