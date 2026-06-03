import { useState, useEffect } from 'react';
import { View, Text, TextInput } from 'react-native';
import { router } from 'expo-router';
import { Screen, Card, Button, T } from '../components/ui';
import { colors, space, radius } from '../theme';
import { loadSeed } from '../lib/keystore';

export default function VerifySeed() {
  const [storedSeed, setStoredSeed] = useState<string | null>(null);
  const [inputs, setInputs] = useState<string[]>(Array(12).fill(''));
  const [checked, setChecked] = useState(false);
  const [mismatches, setMismatches] = useState<boolean[]>(Array(12).fill(false));
  const [allCorrect, setAllCorrect] = useState(false);

  useEffect(() => {
    loadSeed().then((s) => setStoredSeed(s));
  }, []);

  function handleChange(i: number, val: string) {
    const next = [...inputs];
    next[i] = val.trim().toLowerCase();
    setInputs(next);
    // Reset check state when user edits
    if (checked) { setChecked(false); setMismatches(Array(12).fill(false)); setAllCorrect(false); }
  }

  function verify() {
    if (!storedSeed) return;
    const stored = storedSeed.trim().toLowerCase().split(' ');
    const mm = inputs.map((w, i) => w !== stored[i]);
    setMismatches(mm);
    const ok = mm.every((m) => !m);
    setAllCorrect(ok);
    setChecked(true);
  }

  function skip() {
    router.back();
  }

  function proceed() {
    router.back();
  }

  return (
    <Screen>
      <Text style={T.display}>Verifica seed</Text>
      <Text style={T.dim}>
        Digita le 12 parole che hai scritto per confermare che il backup è corretto.
      </Text>

      <Card>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2) }}>
          {inputs.map((val, i) => (
            <View
              key={i}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: checked
                  ? mismatches[i] ? colors.dangerSoft : colors.safeSoft
                  : colors.surfaceAlt,
                borderRadius: radius.sm,
                paddingHorizontal: space(2),
                paddingVertical: space(1),
                minWidth: '30%',
              }}
            >
              <Text style={{ color: colors.inkDim, fontWeight: '700', width: 20, fontSize: 13 }}>
                {i + 1}
              </Text>
              <TextInput
                value={val}
                onChangeText={(t) => handleChange(i, t)}
                autoCapitalize="none"
                autoCorrect={false}
                style={{
                  flex: 1,
                  fontSize: 14,
                  color: checked && mismatches[i] ? colors.danger : colors.ink,
                  paddingVertical: space(1),
                }}
                placeholder={`parola ${i + 1}`}
                placeholderTextColor={colors.inkFaint}
              />
            </View>
          ))}
        </View>

        {checked && allCorrect && (
          <View style={{ backgroundColor: colors.safeSoft, borderRadius: 8, padding: space(3) }}>
            <Text style={[T.body, { color: colors.safe, fontWeight: '600' }]}>
              Perfetto! Seed verificata correttamente.
            </Text>
          </View>
        )}
        {checked && !allCorrect && (
          <View style={{ backgroundColor: colors.dangerSoft, borderRadius: 8, padding: space(3) }}>
            <Text style={[T.dim, { color: colors.danger }]}>
              Alcune parole non corrispondono (evidenziate in rosso). Controlla il tuo backup.
            </Text>
          </View>
        )}

        {!allCorrect && (
          <Button label="Verifica" onPress={verify} />
        )}
        {allCorrect && (
          <Button label="Continua" onPress={proceed} variant="safe" />
        )}
      </Card>

      <Button label="Salta" onPress={skip} variant="ghost" />
    </Screen>
  );
}
