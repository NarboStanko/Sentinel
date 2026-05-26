import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Screen, Card, Button, Pill, T } from '../components/ui';
import { space } from '../theme';
import { api } from '../lib/api';
import {
  findMyShare, bytesToHex, hexToBytes, shareFromWire, combineSecret,
  decryptContent, signChallenge,
} from '../lib/crypto';
import { loadIdentity, loadVerifiedOwnerKey } from '../lib/keystore';
import { downloadEncrypted } from '../lib/drive';

// Aperta dal CONTATTO alla push (o direttamente).
// INVARIANTE: non usa mai la chiave owner dal payload push o dal server;
// usa loadVerifiedOwnerKey() (chiave verificata di persona al pairing).
// Il server NON conosce la soglia k: è il client che, ricombinando le quote
// raccolte e provando a decifrare il contenuto, scopre se la soglia è raggiunta.
export default function Approve() {
  const { switchId: paramSwitchId, ownerName: paramOwnerName } =
    useLocalSearchParams<{ switchId?: string; ownerName?: string }>();

  const [switchId, setSwitchId]   = useState<string | null>(paramSwitchId ?? null);
  const [ownerName, setOwnerName] = useState<string>(paramOwnerName ?? 'Questa persona');
  const [req, setReq]             = useState<any>(null);
  const [status, setStatus]       = useState<string>('');
  const [content, setContent]     = useState<string | null>(null);
  const [err, setErr]             = useState<string | null>(null);
  const [loading, setLoading]     = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        let sid = paramSwitchId ?? null;

        // Se non c'è switchId nel param (tap da push senza deep-link diretto),
        // risolvi tramite /pending autenticato a firma.
        if (!sid) {
          const id = await loadIdentity();
          if (!id) { setErr('Identità non trovata — configura prima l\'app.'); return; }
          const ts = Date.now();
          const pub = bytesToHex(id.pub);
          // pub dentro il messaggio: lega crittograficamente identità e timestamp,
          // così una firma intercettata non è riutilizzabile con una chiave diversa.
          const sig = signChallenge(id.priv, 'sentinella:pending:' + pub + ':' + ts);
          const { switches } = await api.pendingApprovals(bytesToHex(id.pub), ts, sig);
          if (switches.length === 0) { setLoading(false); return; }
          sid = switches[0].switchId;
          setOwnerName(switches[0].ownerName);
          setSwitchId(sid);
        }

        setReq(await api.approvalRequest(sid));
      } catch (e: any) {
        setErr('Errore nel caricare la richiesta: ' + (e?.message ?? e));
      } finally {
        setLoading(false);
      }
    })();
  }, [paramSwitchId]);

  // prova a ricostruire dalle quote raccolte; se decifra, la soglia è raggiunta.
  // FLUSSO: ricostruisce DEK → segnala rilascio → recupera puntatore (ora disponibile) → decifra.
  // Il server non conosce k; la verifica reale è nella cifratura (AEAD fallisce con DEK errata).
  async function tryReconstruct(collected: { x: number; y: string }[]) {
    if (collected.length < 2) return false;
    try {
      const dek = combineSecret(collected.map(shareFromWire));

      // Segnala il rilascio: il server transisce a RELEASED e sblocca il drivePointer.
      // Se la soglia non è ancora raggiunta la decifratura fallirà nel catch.
      try { await api.releaseConfirm(switchId!); } catch { /* già RELEASED o rete */ }

      // Il drivePointer è ora accessibile (stato RELEASED)
      const released = await api.approvalRequest(switchId!);
      if (!released.drivePointer) return false;

      const ctHex = await downloadEncrypted(released.drivePointer);
      const plain = decryptContent(dek, released.contentIv, ctHex);
      const manifest = JSON.parse(new TextDecoder().decode(plain));
      setContent(manifest.text ?? '(nessun messaggio)');
      setStatus('Soglia raggiunta — documentazione rilasciata');
      return true;
    } catch { return false; }
  }

  async function approve() {
    const id = await loadIdentity();
    if (!id || !switchId) return;

    // Verifica che la chiave owner usata per decifrare sia quella verificata
    // di persona al pairing, non un dato arrivato dal server o dalla push.
    const verifiedOwnerKey = await loadVerifiedOwnerKey();
    if (!verifiedOwnerKey) {
      setErr('Chiave owner non verificata. Ripeti il pairing di persona prima di approvare.');
      return;
    }

    const { blobs } = await api.shares(switchId);
    const mine = findMyShare(blobs, id.priv);
    if (!mine) { setErr('Nessuna quota intestata a te in questo switch.'); return; }
    const { collected } = await api.approvalSubmit(
      switchId,
      { x: mine.x, y: bytesToHex(mine.y) }
    );
    const done = await tryReconstruct(collected);
    if (!done) {
      setStatus(`Quota registrata. In attesa di altre approvazioni (raccolte: ${collected.length}).`);
    }
  }

  if (loading) {
    return (
      <Screen>
        <Text style={T.dim}>Caricamento richiesta in corso…</Text>
      </Screen>
    );
  }

  return (
    <Screen>
      {err && <Text style={[T.dim, { color: '#C0492F' }]}>{err}</Text>}
      {!req?.pending && !status && !err && (
        <Text style={T.dim}>Nessuna richiesta di approvazione in sospeso.</Text>
      )}
      {req?.pending && !content && (
        <Card tone="danger">
          <Pill label="RICHIESTA DI RILASCIO" tone="danger" />
          <Text style={[T.body, { marginTop: space(2) }]}>
            {ownerName} non risponde da troppo tempo. Vuoi rilasciare le chiavi e
            permettere l'accesso alla documentazione?
          </Text>
          {!!status && <Text style={T.dim}>{status}</Text>}
          <Button label="Approva e contribuisci la mia quota" onPress={approve} variant="danger" />
          <Button label="Non ora" onPress={() => router.back()} variant="ghost" />
        </Card>
      )}
      {content && (
        <Card tone="safe">
          <Text style={T.heading}>{status}</Text>
          <Text style={[T.body, { marginTop: space(2) }]}>{content}</Text>
          <Text style={T.dim}>Eventuali allegati: scaricabili dalla versione completa.</Text>
        </Card>
      )}
    </Screen>
  );
}
