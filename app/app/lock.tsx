import { useState, useEffect } from 'react';
import { Text, TextInput, Alert } from 'react-native';
import { router } from 'expo-router';
import { Screen, Card, Button, T } from '../components/ui';
import { colors, space, radius } from '../theme';
import { randomBytes } from '../lib/crypto';
import { bytesToHex } from '@noble/hashes/utils';
import { hashPin } from '../lib/pinHash';
import { validatePinFormat, PIN_MIN_LENGTH } from '../lib/pinPolicy';
import { loadBackupPin, saveBackupPin, loadDuressPin } from '../lib/keystore';
import { checkLockout, recordFailure, resetLockout, formatLockoutMs } from '../lib/lockout';
import { setUnlocked, consumePendingRoute } from '../lib/lockState';
import { activateFacade, deactivateFacade, isFacadeActive, getFacadeActivatedAt } from '../lib/facadeStore';
import { api } from '../lib/api';

// Lock screen: unico gate di accesso all'app.
// SOLO PIN, niente biometria (il dito è coercibile). Nessun riferimento a
// funzioni di emergenza: la schermata non deve suggerire che esistano.
type Mode = 'loading' | 'create' | 'unlock';

const inputStyle = {
  borderWidth: 1, borderColor: colors.line, borderRadius: radius.md,
  padding: space(3), fontSize: 18, textAlign: 'center' as const,
  letterSpacing: 8, color: colors.ink,
};

export default function Lock() {
  const [mode, setMode] = useState<Mode>('loading');
  const [backupPin, setBackupPin] = useState<{ hashHex: string; saltHex: string } | null>(null);

  // Sblocco
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [now, setNow] = useState(Date.now());

  // Creazione
  const [newPin, setNewPin] = useState('');
  const [newPinConfirm, setNewPinConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const stored = await loadBackupPin();
      setBackupPin(stored);
      if (stored) {
        const { locked, remainingMs } = await checkLockout();
        if (locked) setLockedUntil(Date.now() + remainingMs);
      }
      setMode(stored ? 'unlock' : 'create');
    })();
  }, []);

  // Countdown del lockout: tick di 1s finché siamo in lockout.
  const isLocked = lockedUntil > now;
  useEffect(() => {
    if (!isLocked) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isLocked]);

  function goInside() {
    setUnlocked(true);
    router.replace((consumePendingRoute() ?? '/home') as any);
  }

  // ── Sblocco ─────────────────────────────────────────────────────────────────
  // Ordine di confronto: PRIMA il duress PIN (in caso di ambiguità vince la
  // sicurezza), poi il backup PIN. Entrambi i percorsi sono indistinguibili
  // dall'esterno: stesso azzeramento lockout, stessa navigazione, nessun
  // messaggio/ritardo differenziale.
  async function handleUnlock() {
    setError(null);
    const { locked, remainingMs } = await checkLockout();
    if (locked) { setLockedUntil(Date.now() + remainingMs); setPin(''); return; }
    if (!backupPin) return;

    // 1) Duress PIN
    const duress = await loadDuressPin();
    if (duress && hashPin(duress.saltHex, pin) === duress.hashHex) {
      setPin('');
      // Un PIN duress è un PIN valido: azzera il lockout come uno sblocco normale.
      await resetLockout();
      if (duress.mode === 'facade') {
        // Modalità A: facciata locale, il server non riceve nulla.
        await activateFacade();
      } else {
        // Modalità B: trigger silenzioso in background. Un fallimento non deve
        // bloccare né produrre segnali visibili; si mostrano i dati reali.
        api.duressTrigger().catch(() => {});
      }
      goInside();
      return;
    }

    // 2) Backup PIN (sblocco normale)
    const hash = hashPin(backupPin.saltHex, pin);
    if (hash === backupPin.hashHex) {
      setPin('');
      await resetLockout();
      // Uscita dalla facciata: lo sblocco col PIN normale la disattiva,
      // registra l'evento in catena e informa l'utente (ora al sicuro).
      if (await isFacadeActive()) {
        const activatedAt = await getFacadeActivatedAt();
        await deactivateFacade();
        api.auditAnchorEvent('DURESS_FACADE_TRIGGERED', { activatedAt }).catch(() => {});
        Alert.alert(
          'PIN di emergenza usato',
          activatedAt
            ? `Hai usato il PIN di emergenza alle ${new Date(activatedAt).toLocaleString('it-IT')}. La modalità facciata è ora disattivata.`
            : 'Hai usato il PIN di emergenza. La modalità facciata è ora disattivata.',
        );
      }
      goInside();
      return;
    }

    // 3) Nessun match
    setPin('');
    const res = await recordFailure();
    if (res.locked) setLockedUntil(res.lockedUntil);
    setError('PIN errato.');
  }

  // ── Creazione (primo avvio senza PIN) ──────────────────────────────────────
  async function handleCreate() {
    setError(null);
    if (newPin !== newPinConfirm) { setError('I PIN non corrispondono.'); return; }
    const formatErr = validatePinFormat(newPin);
    if (formatErr) { setError(formatErr); return; }

    setBusy(true);
    try {
      // Collisione col PIN di emergenza (se impostato): rifiuta senza rivelarne
      // l'esistenza — il messaggio resta generico.
      const duress = await loadDuressPin();
      if (duress && hashPin(duress.saltHex, newPin) === duress.hashHex) {
        setError('PIN non utilizzabile. Scegli una sequenza diversa.');
        return;
      }
      const salt = bytesToHex(randomBytes(16));
      await saveBackupPin(hashPin(salt, newPin), salt);
      setNewPin('');
      setNewPinConfirm('');
      goInside();
    } finally {
      setBusy(false);
    }
  }

  if (mode === 'loading') return <Screen><Text style={T.dim}> </Text></Screen>;

  if (mode === 'create') {
    return (
      <Screen>
        <Text style={[T.display, { marginBottom: space(2) }]}>Crea il tuo PIN</Text>
        <Text style={[T.dim, { marginBottom: space(4) }]}>
          Servirà per sbloccare l'app a ogni avvio. Almeno {PIN_MIN_LENGTH} cifre, nessuna sequenza banale.
        </Text>
        <Card>
          <TextInput
            value={newPin}
            onChangeText={setNewPin}
            placeholder={`PIN (min. ${PIN_MIN_LENGTH} cifre)`}
            secureTextEntry
            keyboardType="number-pad"
            maxLength={8}
            autoFocus
            style={inputStyle}
          />
          <TextInput
            value={newPinConfirm}
            onChangeText={setNewPinConfirm}
            placeholder="Conferma PIN"
            secureTextEntry
            keyboardType="number-pad"
            maxLength={8}
            style={[inputStyle, { marginTop: space(3) }]}
          />
          {error && <Text style={[T.dim, { color: colors.danger }]}>{error}</Text>}
          <Button
            label="Crea PIN e continua"
            onPress={handleCreate}
            disabled={newPin.length < PIN_MIN_LENGTH || newPinConfirm.length < PIN_MIN_LENGTH || busy}
          />
        </Card>
      </Screen>
    );
  }

  // ── unlock ──────────────────────────────────────────────────────────────────
  return (
    <Screen>
      <Text style={[T.display, { marginBottom: space(2) }]}>Sentinella</Text>
      <Text style={[T.dim, { marginBottom: space(4) }]}>Inserisci il PIN per continuare.</Text>
      <Card>
        <TextInput
          value={pin}
          onChangeText={setPin}
          placeholder="PIN"
          secureTextEntry
          keyboardType="number-pad"
          maxLength={8}
          autoFocus
          editable={!isLocked}
          style={inputStyle}
        />
        {isLocked ? (
          <Text style={[T.dim, { color: colors.danger }]}>
            Troppi tentativi. Riprova tra {formatLockoutMs(lockedUntil - now)}.
          </Text>
        ) : (
          error && <Text style={[T.dim, { color: colors.danger }]}>{error}</Text>
        )}
        {/* min 4 (non PIN_MIN_LENGTH): i backup PIN esistenti potevano avere 4 cifre */}
        <Button
          label="Sblocca"
          onPress={handleUnlock}
          disabled={pin.length < 4 || isLocked}
        />
      </Card>
    </Screen>
  );
}
