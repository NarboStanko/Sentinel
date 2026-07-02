import { useState, useEffect } from 'react';
import { View, Text, TextInput } from 'react-native';
import { router } from 'expo-router';
import * as ScreenCapture from 'expo-screen-capture';
import * as LocalAuthentication from 'expo-local-authentication';
import { randomBytes, bytesToHex } from '../lib/crypto';
import { hashPin } from '../lib/pinHash';
import { Screen, Card, Button, T } from '../components/ui';
import { colors, space, radius } from '../theme';
import { loadSeed, loadBackupPin, saveBackupPin, loadAuthToken } from '../lib/keystore';
import { api } from '../lib/api';

type Step = 'pin-setup' | 'pin-enter' | 'biometric' | 'countdown' | 'revealed' | 'hidden';

export default function Backup() {
  // Blocca screenshot per tutta la durata della schermata
  ScreenCapture.usePreventScreenCapture();

  const [step, setStep] = useState<Step>('pin-enter');
  const [seed, setSeed] = useState<string | null>(null);

  // PIN setup
  const [newPin, setNewPin] = useState('');
  const [newPinConfirm, setNewPinConfirm] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);

  // PIN enter
  const [enteredPin, setEnteredPin] = useState('');

  // Countdown
  const [count, setCount] = useState(10);
  const [revealCount, setRevealCount] = useState(60);

  useEffect(() => {
    (async () => {
      const [s, pin] = await Promise.all([loadSeed(), loadBackupPin()]);
      setSeed(s);
      setStep(pin ? 'pin-enter' : 'pin-setup');
    })();
  }, []);

  // 10-second countdown before revealing
  useEffect(() => {
    if (step !== 'countdown') return;
    setCount(10);
    const t = setInterval(() => {
      setCount((c) => {
        if (c <= 1) {
          clearInterval(t);
          setStep('revealed');
          // Log audit event (best effort)
          loadAuthToken().then((token) => {
            if (token) api.auditBackupViewed(token).catch(() => {});
          });
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [step]);

  // 60-second auto-hide after reveal
  useEffect(() => {
    if (step !== 'revealed') return;
    setRevealCount(60);
    const t = setInterval(() => {
      setRevealCount((c) => {
        if (c <= 1) {
          clearInterval(t);
          setStep('hidden');
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [step]);

  async function handleSetupPin() {
    setPinError(null);
    if (newPin.length < 4) { setPinError('Il PIN deve essere di almeno 4 cifre.'); return; }
    if (newPin !== newPinConfirm) { setPinError('I PIN non corrispondono.'); return; }
    const saltBytes = randomBytes(16);
    const salt = bytesToHex(saltBytes);
    const hash = hashPin(salt, newPin);
    await saveBackupPin(hash, salt);
    setNewPin('');
    setNewPinConfirm('');
    setStep('biometric');
  }

  async function handleEnterPin() {
    setPinError(null);
    const stored = await loadBackupPin();
    if (!stored) { setStep('pin-setup'); return; }
    const hash = hashPin(stored.saltHex, enteredPin);
    if (hash !== stored.hashHex) {
      setPinError('PIN errato. Riprova.');
      setEnteredPin('');
      return;
    }
    setEnteredPin('');
    setStep('biometric');
  }

  async function handleBiometric() {
    try {
      const hasHw = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      if (hasHw && enrolled) {
        const result = await LocalAuthentication.authenticateAsync({
          promptMessage: 'Conferma la tua identità per visualizzare la seed',
          cancelLabel: 'Annulla',
          disableDeviceFallback: false,
        });
        if (!result.success) return; // user cancelled or failed
      }
    } catch { /* biometrics non disponibili, procedi */ }
    setStep('countdown');
  }

  const words = seed?.split(' ') ?? [];

  // ── PIN SETUP ───────────────────────────────────────────────────────────────
  if (step === 'pin-setup') {
    return (
      <Screen>
        <Text style={T.display}>Imposta PIN backup</Text>
        <Text style={T.dim}>
          Scegli un PIN numerico per proteggere la visualizzazione della seed phrase.
        </Text>
        <Card>
          <Text style={T.heading}>Nuovo PIN</Text>
          <TextInput
            value={newPin}
            onChangeText={setNewPin}
            placeholder="Minimo 4 cifre"
            secureTextEntry
            keyboardType="number-pad"
            maxLength={6}
            style={{ borderWidth: 1, borderColor: colors.line, borderRadius: 8, padding: space(3), fontSize: 18, textAlign: 'center', letterSpacing: 8, color: colors.ink }}
          />
          <Text style={T.heading}>Conferma PIN</Text>
          <TextInput
            value={newPinConfirm}
            onChangeText={setNewPinConfirm}
            placeholder="Ripeti il PIN"
            secureTextEntry
            keyboardType="number-pad"
            maxLength={6}
            style={{ borderWidth: 1, borderColor: colors.line, borderRadius: 8, padding: space(3), fontSize: 18, textAlign: 'center', letterSpacing: 8, color: colors.ink }}
          />
          {pinError && (
            <Text style={[T.dim, { color: colors.danger }]}>{pinError}</Text>
          )}
          <Button label="Imposta PIN" onPress={handleSetupPin} />
        </Card>
        <Button label="Annulla" onPress={() => router.back()} variant="ghost" />
      </Screen>
    );
  }

  // ── PIN ENTER ───────────────────────────────────────────────────────────────
  if (step === 'pin-enter') {
    return (
      <Screen>
        <Text style={T.display}>Backup seed</Text>
        <Text style={T.dim}>Inserisci il PIN per accedere alla seed phrase.</Text>
        <Card>
          <TextInput
            value={enteredPin}
            onChangeText={setEnteredPin}
            placeholder="PIN"
            secureTextEntry
            keyboardType="number-pad"
            maxLength={6}
            autoFocus
            style={{ borderWidth: 1, borderColor: colors.line, borderRadius: 8, padding: space(3), fontSize: 18, textAlign: 'center', letterSpacing: 8, color: colors.ink }}
          />
          {pinError && (
            <Text style={[T.dim, { color: colors.danger }]}>{pinError}</Text>
          )}
          <Button label="Conferma PIN" onPress={handleEnterPin} disabled={enteredPin.length < 4} />
        </Card>
        <Button label="Annulla" onPress={() => router.back()} variant="ghost" />
      </Screen>
    );
  }

  // ── BIOMETRIC ───────────────────────────────────────────────────────────────
  if (step === 'biometric') {
    return (
      <Screen>
        <Text style={T.display}>Verifica biometrica</Text>
        <Text style={T.dim}>
          Usa il riconoscimento biometrico per un ulteriore livello di protezione.
        </Text>
        <Card>
          <Button label="Procedi con biometria" onPress={handleBiometric} />
        </Card>
        <Button label="Salta biometria" onPress={() => setStep('countdown')} variant="ghost" />
      </Screen>
    );
  }

  // ── COUNTDOWN ───────────────────────────────────────────────────────────────
  if (step === 'countdown') {
    return (
      <Screen>
        <Text style={T.display}>Preparazione…</Text>
        <Card tone="heartbeat">
          <Text style={[T.dim, { textAlign: 'center' }]}>
            La seed apparirà tra
          </Text>
          <Text style={{ fontSize: 64, fontWeight: '800', color: colors.heartbeat, textAlign: 'center' }}>
            {count}
          </Text>
          <Text style={[T.dim, { textAlign: 'center' }]}>secondi</Text>
        </Card>
        <Text style={[T.dim, { textAlign: 'center' }]}>
          Assicurati di essere in un posto privato e che nessuno stia guardando lo schermo.
        </Text>
      </Screen>
    );
  }

  // ── REVEALED ────────────────────────────────────────────────────────────────
  if (step === 'revealed') {
    return (
      <Screen>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={T.display}>Seed phrase</Text>
          <Text style={[T.label, { color: colors.heartbeat }]}>Si nasconde in {revealCount}s</Text>
        </View>

        <Card tone="heartbeat">
          <Text style={[T.label, { color: colors.heartbeat }]}>
            ATTENZIONE — NON FOTOGRAFARE
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2) }}>
            {words.map((w, i) => (
              <View key={i} style={{
                flexDirection: 'row', alignItems: 'baseline',
                backgroundColor: colors.surface, borderRadius: radius.sm,
                paddingHorizontal: space(3), paddingVertical: space(2), minWidth: '30%',
              }}>
                <Text style={{ color: colors.heartbeat, fontWeight: '700', width: 22 }}>{i + 1}</Text>
                <Text style={{ color: colors.ink, fontSize: 15 }}>{w}</Text>
              </View>
            ))}
          </View>
          <Text style={[T.dim, { color: colors.heartbeat }]}>
            Chiunque abbia queste parole può impersonarti. Usale solo per il ripristino.
          </Text>
        </Card>

        <Button label="Nascondi subito" onPress={() => setStep('hidden')} variant="danger" />
      </Screen>
    );
  }

  // ── HIDDEN ───────────────────────────────────────────────────────────────────
  return (
    <Screen>
      <Text style={T.display}>Seed nascosta</Text>
      <Card>
        <Text style={T.body}>La seed phrase è stata nascosta per sicurezza.</Text>
        <Button label="Mostra di nuovo" onPress={() => setStep('countdown')} variant="ghost" />
      </Card>
      <Button label="Torna all'app" onPress={() => router.back()} variant="ghost" />
    </Screen>
  );
}
