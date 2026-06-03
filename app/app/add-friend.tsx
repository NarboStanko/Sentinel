import { useState, useRef } from 'react';
import { View, Text } from 'react-native';
import { router } from 'expo-router';
import QRCode from 'react-native-qrcode-svg';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Screen, Card, Button, T } from '../components/ui';
import { colors, space } from '../theme';
import { api } from '../lib/api';
import {
  loadOwnerId, loadIdentity, saveSeed,
  saveVerifiedContactKey, saveVerifiedOwnerKey,
} from '../lib/keystore';
import { registerPushToken } from '../lib/notifications';
import { newSeedPhrase, identityFromSeed, safetyNumber, bytesToHex, hexToBytes } from '../lib/crypto';

// ── Macchina a stati del flusso ───────────────────────────────────────────────
// Owner:   choose → owner_show_a → owner_scan_b → both_confirm → done
// Contatto: choose → contact_scan_a → contact_show_b → both_confirm → done
type Step =
  | 'choose'
  | 'owner_show_a'     // owner mostra QR_A = {token, ownerPublicKey}
  | 'owner_scan_b'     // owner scansiona QR_B del contatto
  | 'contact_scan_a'   // contatto scansiona QR_A dell'owner
  | 'contact_show_b'   // contatto mostra QR_B = {token, contactPublicKey}
  | 'both_confirm'     // entrambi vedono safety number e confermano
  | 'rejected'         // owner ha rifiutato — stato incoerente spiegato
  | 'done';

type Role = 'owner' | 'contact';

// ── Payload QR ────────────────────────────────────────────────────────────────
type QrA = { token: string; ownerPublicKey: string };
type QrB = { token: string; contactPublicKey: string };

export default function AddFriend() {
  const [step, setStep]     = useState<Step>('choose');
  const [role, setRole]     = useState<Role | null>(null);
  const [qrA, setQrA]       = useState<QrA | null>(null);
  const [qrB, setQrB]       = useState<QrB | null>(null);
  const [sn, setSn]         = useState<string | null>(null);

  // Camera permission (hook must be at top level)
  const [permission, requestPermission] = useCameraPermissions();

  // Guard against onBarcodeScanned firing multiple times per frame
  const alreadyScanned = useRef(false);

  function enterScanStep(s: Step) {
    alreadyScanned.current = false;
    setStep(s);
  }

  function handleScan(raw: string, handler: (parsed: any) => void) {
    if (alreadyScanned.current) return;
    alreadyScanned.current = true;
    try {
      handler(JSON.parse(raw));
    } catch {
      alreadyScanned.current = false;
      alert('QR non riconosciuto. Assicurati di scansionare il QR di Sentinella.');
    }
  }

  // ── OWNER passo 1: genera invito e mostra QR_A ─────────────────────────────
  async function startAsOwner() {
    const ownerId = await loadOwnerId();
    if (!ownerId) { alert('Registra prima il tuo account.'); return; }
    const invite = await api.createInvite(ownerId); // {token, ownerPublicKey}
    setQrA(invite);
    setRole('owner');
    setStep('owner_show_a');
  }

  // ── OWNER passo 2: ha scansionato QR_B del contatto ───────────────────────
  async function ownerScannedB(payload: QrB) {
    if (!qrA) return;
    const safeNum = safetyNumber(hexToBytes(qrA.ownerPublicKey), hexToBytes(payload.contactPublicKey));
    setQrB(payload);
    setSn(safeNum);
    setStep('both_confirm');
  }

  // ── OWNER passo 3: conferma → salva chiave verificata ────────────────────
  async function ownerConfirm() {
    if (!qrB) return;
    await saveVerifiedContactKey(qrB.contactPublicKey);
    setStep('done');
  }

  // ── CONTATTO passo 1: ha scansionato QR_A dell'owner ─────────────────────
  async function contactScannedA(payload: QrA) {
    let id = await loadIdentity();
    if (!id) { const m = newSeedPhrase(); await saveSeed(m); id = identityFromSeed(m); }
    const myPub = bytesToHex(id.pub);
    // salva la chiave dell'owner verificata di persona prima di procedere
    await saveVerifiedOwnerKey(payload.ownerPublicKey);
    setQrA(payload);
    setQrB({ token: payload.token, contactPublicKey: myPub });
    setRole('contact');
    setStep('contact_show_b');
  }

  // ── CONTATTO passo 2: owner ha scansionato → calcola safety number ─────────
  function contactReadyToConfirm() {
    if (!qrA || !qrB) return;
    const safeNum = safetyNumber(hexToBytes(qrA.ownerPublicKey), hexToBytes(qrB.contactPublicKey));
    setSn(safeNum);
    setStep('both_confirm');
  }

  // ── CONTATTO passo 3: conferma → chiama /pair → registra push token ───────
  async function contactConfirm() {
    if (!qrB) return;
    try {
      const { contactId } = await api.pair(qrB.token, qrB.contactPublicKey);
      // Registra il push token subito dopo il pairing: il server potrà notificare
      // questo contatto quando scatta una richiesta di approvazione.
      registerPushToken('contact', contactId).catch(() => {});
      setStep('done');
    } catch (e: any) {
      if (e?.status === 404) {
        alert('Invito non valido o già usato. Chiedi all\'owner un nuovo QR.');
      } else {
        alert('Errore durante il pairing: ' + (e?.message ?? 'Errore sconosciuto'));
      }
    }
  }

  // ── Blocco fotocamera condiviso ───────────────────────────────────────────
  // Inline per evitare re-mount inattesi; riusato nelle due fasi di scan.
  function renderCamera(onScan: (raw: string) => void) {
    if (!permission) {
      return <Text style={T.dim}>Verifica permessi fotocamera…</Text>;
    }
    if (!permission.granted) {
      return (
        <View style={{ gap: space(3) }}>
          <Text style={T.dim}>
            L'app ha bisogno di accedere alla fotocamera per scansionare il QR.
          </Text>
          <Button label="Richiedi accesso fotocamera" onPress={requestPermission} />
        </View>
      );
    }
    return (
      <CameraView
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={(e) => onScan(e.data)}
        style={{ height: 280, borderRadius: 12, overflow: 'hidden' }}
      />
    );
  }

  // ── RENDER ────────────────────────────────────────────────────────────────
  return (
    <Screen>

      {/* ── Scelta del ruolo ─────────────────────────────────────────────── */}
      {step === 'choose' && (
        <>
          <Text style={T.dim}>
            Il pairing è reciproco: ogni lato scansiona la chiave dell'altro di persona.
            Nessuna chiave passa solo dal server.
          </Text>
          <Button label="Sono io (owner): mostra il mio QR" onPress={startAsOwner} variant="safe" />
          <Button label="Sono il contatto: scansiona il suo QR" onPress={() => enterScanStep('contact_scan_a')} variant="ghost" />
        </>
      )}

      {/* ── OWNER 1: mostra QR_A ─────────────────────────────────────────── */}
      {step === 'owner_show_a' && qrA && (
        <Card>
          <Text style={T.heading}>Fallo scansionare dal contatto</Text>
          <View style={{ alignItems: 'center', backgroundColor: colors.surface, padding: space(5), borderRadius: 14 }}>
            <QRCode value={JSON.stringify(qrA)} size={240} />
          </View>
          <Text style={T.dim}>
            Contiene il tuo token monouso e la tua chiave pubblica. Dopo che il contatto lo ha
            scansionato, lui ti mostrerà il suo QR.
          </Text>
          <Button label="Il contatto ha mostrato il suo QR → scansionalo" onPress={() => enterScanStep('owner_scan_b')} />
        </Card>
      )}

      {/* ── OWNER 2: scansiona QR_B ──────────────────────────────────────── */}
      {step === 'owner_scan_b' && qrA && (
        <Card>
          <Text style={T.heading}>Scansiona il QR del contatto</Text>
          {renderCamera((raw) => handleScan(raw, ownerScannedB))}
        </Card>
      )}

      {/* ── CONTATTO 1: scansiona QR_A ───────────────────────────────────── */}
      {step === 'contact_scan_a' && (
        <Card>
          <Text style={T.heading}>Scansiona il QR dell'owner</Text>
          {renderCamera((raw) => handleScan(raw, contactScannedA))}
          {__DEV__ && (
            <Button
              label="[DEV] simula scan owner"
              variant="ghost"
              onPress={() => contactScannedA({
                token: 'DEMO_TOKEN_0000',
                ownerPublicKey: '024ed395825486a3628176b579749981dca9927c319f6f7ad136d324931da0f661',
              })}
            />
          )}
        </Card>
      )}

      {/* ── CONTATTO 2: mostra QR_B ──────────────────────────────────────── */}
      {step === 'contact_show_b' && qrB && (
        <Card>
          <Text style={T.heading}>Ora mostra questo QR all'owner</Text>
          <View style={{ alignItems: 'center', backgroundColor: colors.surface, padding: space(5), borderRadius: 14 }}>
            <QRCode value={JSON.stringify(qrB)} size={240} />
          </View>
          <Text style={T.dim}>
            L'owner deve scansionare questo QR per verificare la tua chiave di persona.
          </Text>
          <Button label="L'owner ha scansionato → avanti" onPress={contactReadyToConfirm} />
        </Card>
      )}

      {/* ── ENTRAMBI: conferma safety number ─────────────────────────────── */}
      {step === 'both_confirm' && sn && (
        <Card tone="safe">
          <Text style={T.heading}>Leggete queste parole ad alta voce</Text>
          <View style={{ backgroundColor: colors.bg, borderRadius: 10, padding: space(5),
            alignItems: 'center' }}>
            <Text style={{ ...T.mono, fontSize: 20, letterSpacing: 1.5, textAlign: 'center',
              color: colors.ink, lineHeight: 34 }}>
              {sn}
            </Text>
          </View>
          <Text style={T.dim}>
            Se le sei parole coincidono su entrambi i telefoni, nessuno ha alterato le chiavi.
            Confermate insieme, poi toccate il pulsante solo se coincidono.
          </Text>
          <Button
            label="Le impronte coincidono ✓ — salva contatto"
            variant="safe"
            onPress={role === 'owner' ? ownerConfirm : contactConfirm}
          />
          <Button
            label="Non coincidono — annulla"
            variant="ghost"
            onPress={() => setStep('rejected')}
          />
        </Card>
      )}

      {/* ── Rifiuto owner: spiega lo stato incoerente ───────────────────── */}
      {step === 'rejected' && (
        <Card tone="danger">
          <Text style={T.heading}>Pairing annullato</Text>
          <Text style={T.dim}>
            Possibile attacco intermediario. Riprova fisicamente con il contatto, non a distanza.
          </Text>
          <Text style={T.dim}>
            Nessuna chiave è stata salvata come verificata.
          </Text>
          <Text style={T.dim}>
            Se il contatto ha già confermato dal suo lato, il server potrebbe aver già
            registrato la sua chiave. Quella chiave comparirà nella tua lista con il
            segnale ⚠ «non verificata di persona» e non potrai cifrare quote per lui
            finché non ripetete il pairing di persona dall'inizio.
          </Text>
          <Text style={T.dim}>
            Avvisa il contatto che il pairing è da ripetere.
          </Text>
          <Button label="Chiudi" onPress={() => router.back()} variant="ghost" />
        </Card>
      )}

      {/* ── Completato ───────────────────────────────────────────────────── */}
      {step === 'done' && (
        <Card tone="safe">
          <Text style={T.heading}>Pairing completato</Text>
          <Text style={T.dim}>
            La chiave del contatto è stata verificata di persona e salvata localmente.
            Se il server dovesse restituire una chiave diversa, l'app lo segnalerà.
          </Text>
          <Button label="Torna ai contatti" onPress={() => router.back()} />
        </Card>
      )}

    </Screen>
  );
}
