import { useState, useEffect } from 'react';
import { View, Text, TextInput, Pressable, Alert, ScrollView } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { router } from 'expo-router';
import { Screen, Card, Button, T } from '../components/ui';
import { colors, space, radius } from '../theme';
import { randomBytes } from '../lib/crypto';
import { bytesToHex } from '@noble/hashes/utils';
import { hashPin } from '../lib/pinHash';
import {
  loadBackupPin, loadDuressPin, saveDuressPin, deleteDuressPin,
  type DuressMode,
} from '../lib/keystore';
import { api } from '../lib/api';

type Step = 'auth-pin' | 'auth-biometric' | 'status' | 'choose-mode' | 'set-pin' | 'confirm-trigger' | 'delete-confirm';

// PIN deboli comunemente usati: vietati per il PIN di coercizione (≥ 6 cifre).
const BLACKLIST = [
  '000000', '111111', '222222', '333333', '444444', '555555',
  '666666', '777777', '888888', '999999',
  '123456', '654321', '234567', '987654',
  '112233', '123123', '121212', '000001',
];

const CONFIRM_TRIGGER_PHRASE = 'HO CAPITO';

async function validateDuressPin(
  pin: string,
  backupPin: { hashHex: string; saltHex: string } | null,
): Promise<string | null> {
  if (!/^\d+$/.test(pin)) return 'Il PIN deve contenere solo cifre.';
  if (pin.length < 6) return 'Il PIN di emergenza deve essere di almeno 6 cifre.';
  if (BLACKLIST.includes(pin)) return 'PIN troppo comune. Scegli una sequenza meno prevedibile.';
  if (backupPin) {
    const backupHash = hashPin(backupPin.saltHex, pin);
    if (backupHash === backupPin.hashHex) {
      return 'Il PIN di emergenza non può essere uguale al PIN di backup.';
    }
  }
  return null;
}

export default function DuressSetup() {
  const [step, setStep]               = useState<Step>('auth-pin');
  const [authPin, setAuthPin]         = useState('');
  const [authError, setAuthError]     = useState<string | null>(null);
  const [backupPinData, setBackupPinData] = useState<{ hashHex: string; saltHex: string } | null>(null);
  const [currentDuress, setCurrentDuress] = useState<{ mode: DuressMode } | null>(null);
  const [selectedMode, setSelectedMode] = useState<DuressMode>('facade');
  const [newPin, setNewPin]           = useState('');
  const [newPinConfirm, setNewPinConfirm] = useState('');
  const [pinError, setPinError]       = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy]               = useState(false);

  useEffect(() => {
    loadBackupPin().then(setBackupPinData);
  }, []);

  // ── Auth con backup PIN ────────────────────────────────────────────────────
  async function handleAuthPin() {
    setAuthError(null);
    if (!backupPinData) {
      // Nessun PIN di backup impostato: accedi direttamente con biometria
      setStep('auth-biometric');
      return;
    }
    const hash = hashPin(backupPinData.saltHex, authPin);
    if (hash !== backupPinData.hashHex) {
      setAuthError('PIN errato. Riprova.');
      setAuthPin('');
      return;
    }
    setAuthPin('');
    setStep('auth-biometric');
  }

  async function handleAuthBiometric() {
    try {
      const hasHw   = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      if (hasHw && enrolled) {
        const result = await LocalAuthentication.authenticateAsync({
          promptMessage: 'Conferma la tua identità per gestire il PIN di emergenza',
          cancelLabel: 'Annulla',
          disableDeviceFallback: false,
        });
        if (!result.success) return;
      }
    } catch { /* biometria non disponibile */ }

    const duress = await loadDuressPin();
    setCurrentDuress(duress ? { mode: duress.mode } : null);
    setStep('status');
  }

  // ── Status ────────────────────────────────────────────────────────────────
  function handleStartSetup() {
    setSelectedMode('facade');
    setNewPin('');
    setNewPinConfirm('');
    setPinError(null);
    setStep('choose-mode');
  }

  function handleDelete() {
    setStep('delete-confirm');
  }

  // ── Scelta modalità ────────────────────────────────────────────────────────
  function handleModeSelected() {
    setNewPin('');
    setNewPinConfirm('');
    setPinError(null);
    setStep('set-pin');
  }

  // ── Impostazione PIN ───────────────────────────────────────────────────────
  async function handleSavePin() {
    setPinError(null);
    if (newPin !== newPinConfirm) {
      setPinError('I PIN non corrispondono.');
      return;
    }
    const err = await validateDuressPin(newPin, backupPinData);
    if (err) { setPinError(err); return; }

    if (selectedMode === 'trigger') {
      // Richiede conferma aggiuntiva per la modalità più invasiva
      setConfirmText('');
      setStep('confirm-trigger');
    } else {
      await commitSave();
    }
  }

  async function handleConfirmTrigger() {
    if (confirmText !== CONFIRM_TRIGGER_PHRASE) return;
    await commitSave();
  }

  async function commitSave() {
    setBusy(true);
    try {
      const saltBytes = randomBytes(16);
      const salt = bytesToHex(saltBytes);
      const hash = hashPin(salt, newPin);
      await saveDuressPin(hash, salt, selectedMode);
      setCurrentDuress({ mode: selectedMode });

      api.auditAnchorEvent('DURESS_SETUP_CHANGED', { action: 'set', mode: selectedMode }).catch(() => {});
      setNewPin('');
      setNewPinConfirm('');
      setStep('status');
    } catch (e: any) {
      Alert.alert('Errore', e?.message ?? 'Impossibile salvare il PIN.');
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirmDelete() {
    setBusy(true);
    try {
      await deleteDuressPin();
      api.auditAnchorEvent('DURESS_SETUP_CHANGED', { action: 'deleted' }).catch(() => {});
      setCurrentDuress(null);
      setStep('status');
    } catch (e: any) {
      Alert.alert('Errore', e?.message ?? 'Impossibile eliminare il PIN.');
    } finally {
      setBusy(false);
    }
  }

  // ── AUTH PIN ───────────────────────────────────────────────────────────────
  if (step === 'auth-pin') {
    return (
      <Screen>
        <Text style={[T.display, { marginBottom: space(2) }]}>PIN di emergenza</Text>
        <Text style={[T.dim, { marginBottom: space(4) }]}>
          Inserisci il PIN di backup per accedere a questa sezione.
        </Text>
        <Card>
          <TextInput
            value={authPin}
            onChangeText={setAuthPin}
            placeholder="PIN di backup"
            secureTextEntry
            keyboardType="number-pad"
            maxLength={8}
            autoFocus
            style={{ borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, padding: space(3), fontSize: 18, textAlign: 'center', letterSpacing: 8, color: colors.ink }}
          />
          {authError && <Text style={[T.dim, { color: colors.danger }]}>{authError}</Text>}
          <Button label="Continua" onPress={handleAuthPin} disabled={authPin.length < 4} />
        </Card>
        <Button label="Annulla" onPress={() => router.back()} variant="ghost" />
      </Screen>
    );
  }

  // ── AUTH BIOMETRIA ─────────────────────────────────────────────────────────
  if (step === 'auth-biometric') {
    return (
      <Screen>
        <Text style={[T.display, { marginBottom: space(2) }]}>Verifica biometrica</Text>
        <Text style={[T.dim, { marginBottom: space(4) }]}>
          Conferma la tua identità per gestire il PIN di emergenza.
        </Text>
        <Card>
          <Button label="Procedi con biometria" onPress={handleAuthBiometric} />
        </Card>
        <Button label="Salta" onPress={async () => {
          const duress = await loadDuressPin();
          setCurrentDuress(duress ? { mode: duress.mode } : null);
          setStep('status');
        }} variant="ghost" />
      </Screen>
    );
  }

  // ── STATUS ────────────────────────────────────────────────────────────────
  if (step === 'status') {
    const modeLabel = currentDuress?.mode === 'facade'
      ? 'Modalità A — Facciata'
      : currentDuress?.mode === 'trigger'
      ? 'Modalità B — Rilascio silenzioso'
      : null;

    return (
      <Screen>
        <Text style={[T.heading, { marginBottom: space(2) }]}>PIN di emergenza</Text>
        <Text style={[T.body, { color: colors.inkDim, marginBottom: space(4) }]}>
          Configura un PIN che, inserito al posto di quello normale, attiva una misura di protezione
          senza che chi ti osserva se ne accorga.
        </Text>

        <Card tone={currentDuress ? 'safe' : 'surface'}>
          <Text style={T.label}>Stato attuale</Text>
          {currentDuress ? (
            <View style={{ gap: space(1) }}>
              <Text style={[T.body, { color: colors.safe, fontWeight: '600' }]}>PIN impostato</Text>
              <Text style={[T.body, { color: colors.inkDim }]}>{modeLabel}</Text>
            </View>
          ) : (
            <Text style={[T.body, { color: colors.inkDim }]}>Nessun PIN di emergenza impostato</Text>
          )}
        </Card>

        <Card>
          <Text style={T.label}>Modalità disponibili</Text>
          <View style={{ gap: space(2) }}>
            <View>
              <Text style={[T.body, { fontWeight: '600' }]}>A — Facciata</Text>
              <Text style={[T.body, { color: colors.inkDim }]}>
                L'app mostra dati fittizi (nessuno switch armato, contatti finti). Il server non
                riceve nulla. Utile se ti chiedono di sbloccare il telefono.
              </Text>
            </View>
            <View>
              <Text style={[T.body, { fontWeight: '600' }]}>B — Rilascio silenzioso</Text>
              <Text style={[T.body, { color: colors.inkDim }]}>
                Avvia immediatamente il flusso di approvazione per i tuoi contatti fidati, come se
                lo switch fosse scaduto. Non annullabile senza i contatti.
              </Text>
            </View>
          </View>
        </Card>

        <View style={{ gap: space(3) }}>
          <Button
            label={currentDuress ? 'Cambia PIN di emergenza' : 'Imposta PIN di emergenza'}
            onPress={handleStartSetup}
          />
          {currentDuress && (
            <Button label="Rimuovi PIN di emergenza" onPress={handleDelete} variant="danger" />
          )}
          <Button label="Chiudi" onPress={() => router.back()} variant="ghost" />
        </View>
      </Screen>
    );
  }

  // ── SCELTA MODALITÀ ────────────────────────────────────────────────────────
  if (step === 'choose-mode') {
    return (
      <Screen>
        <Text style={[T.heading, { marginBottom: space(2) }]}>Scegli la modalità</Text>

        {(['facade', 'trigger'] as DuressMode[]).map((mode) => {
          const isSelected = selectedMode === mode;
          return (
            <Pressable
              key={mode}
              onPress={() => setSelectedMode(mode)}
              style={{
                borderWidth: 2,
                borderColor: isSelected ? colors.accent : colors.line,
                borderRadius: radius.md,
                padding: space(4),
                marginBottom: space(3),
                backgroundColor: isSelected ? colors.surface : colors.bg,
              }}
            >
              <Text style={[T.body, { fontWeight: '700', color: isSelected ? colors.accent : colors.ink }]}>
                {mode === 'facade' ? 'A — Facciata' : 'B — Rilascio silenzioso'}
              </Text>
              <Text style={[T.body, { color: colors.inkDim, marginTop: space(1) }]}>
                {mode === 'facade'
                  ? 'Mostra dati fittizi. Reversibile. Nessuna notifica inviata.'
                  : 'Avvia il rilascio ai contatti. Azione immediata e difficile da annullare.'}
              </Text>
            </Pressable>
          );
        })}

        {selectedMode === 'trigger' && (
          <Card tone="danger">
            <Text style={T.label}>ATTENZIONE</Text>
            <Text style={T.body}>
              La modalità B avvia immediatamente una richiesta di approvazione ai tuoi contatti.
              Non puoi annullarla da solo — serve il quorum dei contatti. Usa questa modalità
              solo se sei certo di voler attivare il rilascio sotto coercizione.
            </Text>
          </Card>
        )}

        <Button label="Avanti" onPress={handleModeSelected} />
        <Button label="Indietro" onPress={() => setStep('status')} variant="ghost" />
      </Screen>
    );
  }

  // ── IMPOSTA PIN ────────────────────────────────────────────────────────────
  if (step === 'set-pin') {
    return (
      <Screen>
        <Text style={[T.heading, { marginBottom: space(2) }]}>
          Imposta PIN di emergenza
        </Text>
        <Text style={[T.body, { color: colors.inkDim, marginBottom: space(3) }]}>
          Modalità: <Text style={{ fontWeight: '700' }}>
            {selectedMode === 'facade' ? 'A — Facciata' : 'B — Rilascio silenzioso'}
          </Text>
        </Text>

        <Card>
          <Text style={T.label}>REQUISITI PIN</Text>
          <Text style={[T.body, { color: colors.inkDim }]}>
            • Almeno 6 cifre{'\n'}
            • Solo numeri{'\n'}
            • Diverso dal PIN di backup{'\n'}
            • Nessuna sequenza comune (000000, 123456…)
          </Text>
        </Card>

        <Card>
          <TextInput
            value={newPin}
            onChangeText={setNewPin}
            placeholder="Nuovo PIN (min. 6 cifre)"
            secureTextEntry
            keyboardType="number-pad"
            maxLength={8}
            style={{ borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, padding: space(3), fontSize: 18, textAlign: 'center', letterSpacing: 8, color: colors.ink }}
          />
          <TextInput
            value={newPinConfirm}
            onChangeText={setNewPinConfirm}
            placeholder="Conferma PIN"
            secureTextEntry
            keyboardType="number-pad"
            maxLength={8}
            style={{ borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, padding: space(3), fontSize: 18, textAlign: 'center', letterSpacing: 8, color: colors.ink, marginTop: space(3) }}
          />
          {pinError && <Text style={[T.dim, { color: colors.danger }]}>{pinError}</Text>}
        </Card>

        <Button
          label="Salva PIN"
          onPress={handleSavePin}
          disabled={newPin.length < 6 || newPinConfirm.length < 6 || busy}
        />
        <Button label="Indietro" onPress={() => setStep('choose-mode')} variant="ghost" />
      </Screen>
    );
  }

  // ── CONFERMA MODALITÀ TRIGGER ──────────────────────────────────────────────
  if (step === 'confirm-trigger') {
    const canConfirm = confirmText === CONFIRM_TRIGGER_PHRASE;
    return (
      <Screen>
        <Text style={[T.heading, { marginBottom: space(2) }]}>Conferma modalità B</Text>

        <Card tone="danger">
          <Text style={T.label}>CONSEGUENZE DELLA MODALITÀ B</Text>
          <View style={{ gap: space(2), marginTop: space(1) }}>
            {[
              'Inserendo questo PIN, i tuoi contatti riceveranno immediatamente una richiesta di approvazione.',
              'Il processo di rilascio parte senza possibilità di annullamento da parte tua.',
              "Solo il quorum dei tuoi contatti può fermare il rilascio (se non approvano).",
              'Usa questa modalità solo se sei fisicamente impossibilitato ad agire normalmente.',
            ].map((item, i) => (
              <View key={i} style={{ flexDirection: 'row', gap: space(2) }}>
                <Text style={[T.body, { color: colors.inkDim }]}>•</Text>
                <Text style={[T.body, { flex: 1, color: colors.inkDim }]}>{item}</Text>
              </View>
            ))}
          </View>
        </Card>

        <Card tone="danger">
          <Text style={[T.body, { color: colors.inkDim, marginBottom: space(2) }]}>
            Digita esattamente per abilitare il pulsante:
          </Text>
          <Text style={[T.mono, { color: colors.ink, marginBottom: space(3), textAlign: 'center' }]}>
            {CONFIRM_TRIGGER_PHRASE}
          </Text>
          <TextInput
            value={confirmText}
            onChangeText={setConfirmText}
            placeholder={`Digita: ${CONFIRM_TRIGGER_PHRASE}`}
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

        <Button
          label="Conferma e salva"
          onPress={handleConfirmTrigger}
          variant="danger"
          disabled={!canConfirm || busy}
        />
        <Button label="Indietro" onPress={() => setStep('set-pin')} variant="ghost" />
      </Screen>
    );
  }

  // ── CONFERMA ELIMINAZIONE ──────────────────────────────────────────────────
  if (step === 'delete-confirm') {
    return (
      <Screen>
        <Text style={[T.heading, { marginBottom: space(2) }]}>Rimuovi PIN di emergenza</Text>
        <Card tone="danger">
          <Text style={T.body}>
            Sei sicuro di voler rimuovere il PIN di emergenza? Non avrai più protezione attiva
            in caso di coercizione.
          </Text>
        </Card>
        <Button
          label="Sì, rimuovi"
          onPress={handleConfirmDelete}
          variant="danger"
          disabled={busy}
        />
        <Button label="Annulla" onPress={() => setStep('status')} variant="ghost" />
      </Screen>
    );
  }

  return null;
}
