import { useEffect, useRef, useState } from 'react';
import { Text, Image, View } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Screen, Card, Button, Pill, T } from '../components/ui';
import { colors, space } from '../theme';
import { api } from '../lib/api';
import {
  findMyShare, bytesToHex, hexToBytes, shareFromWire, combineSecret,
  decryptContent, signChallenge,
} from '../lib/crypto';
import { loadIdentity, loadVerifiedOwnerKey } from '../lib/keystore';
import { downloadEncrypted } from '../lib/drive';
import { decryptAttachment, type AttachmentMeta } from '../lib/attachments';

// Converte Uint8Array in base64 in chunk per evitare stack overflow su file grandi.
function uint8ToBase64(bytes: Uint8Array): string {
  let out = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(out);
}

// Aperta dal CONTATTO alla push (o direttamente).
// INVARIANTE: non usa mai la chiave owner dal payload push o dal server;
// usa loadVerifiedOwnerKey() (chiave verificata di persona al pairing).
export default function Approve() {
  const { switchId: paramSwitchId, ownerName: paramOwnerName } =
    useLocalSearchParams<{ switchId?: string; ownerName?: string }>();

  const [switchId, setSwitchId]     = useState<string | null>(paramSwitchId ?? null);
  const [ownerName, setOwnerName]   = useState<string>(paramOwnerName ?? 'Questa persona');
  const [req, setReq]               = useState<any>(null);
  const [status, setStatus]         = useState<string>('');
  const [content, setContent]       = useState<string | null>(null);
  const [attachments, setAttachments] = useState<AttachmentMeta[]>([]);
  const [viewingImage, setViewingImage] = useState<{ uri: string; name: string } | null>(null);
  const [attLoading, setAttLoading] = useState<string | null>(null); // nome allegato in carico
  const [err, setErr]               = useState<string | null>(null);
  const [loading, setLoading]       = useState(true);

  // DEK ricombinata in tryReconstruct; tenuta in ref per i tap sugli allegati.
  const dekRef = useRef<Uint8Array | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        let sid = paramSwitchId ?? null;

        if (!sid) {
          const id = await loadIdentity();
          if (!id) { setErr('Identità non trovata — configura prima l\'app.'); return; }
          const ts = Date.now();
          const pub = bytesToHex(id.pub);
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
  async function tryReconstruct(collected: { x: number; y: string }[]) {
    if (collected.length < 2) return false;
    try {
      const dek = combineSecret(collected.map(shareFromWire));

      try { await api.releaseConfirm(switchId!); } catch { /* già RELEASED o rete */ }

      const released = await api.approvalRequest(switchId!);
      if (!released.drivePointer) return false;

      const ctHex = await downloadEncrypted(released.drivePointer);
      const plain = decryptContent(dek, released.contentIv, ctHex);
      const manifest = JSON.parse(new TextDecoder().decode(plain));
      dekRef.current = dek;
      setContent(manifest.text ?? '(nessun messaggio)');
      setAttachments(manifest.attachments ?? []);
      setStatus('Soglia raggiunta — documentazione rilasciata');
      return true;
    } catch { return false; }
  }

  async function approve() {
    const id = await loadIdentity();
    if (!id || !switchId) return;

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

  async function viewAttachment(meta: AttachmentMeta) {
    if (!dekRef.current) return;
    setAttLoading(meta.name);
    try {
      const bytes = await decryptAttachment(meta, dekRef.current);
      if (meta.mimeType.startsWith('image/')) {
        const b64 = uint8ToBase64(bytes);
        setViewingImage({ uri: `data:${meta.mimeType};base64,${b64}`, name: meta.name });
      } else {
        alert(`File: ${meta.name}\nTipo: ${meta.mimeType}\nDimensione: ${(meta.size / 1024).toFixed(0)} KB\n\nPer aprire questo tipo di file installa expo-file-system e expo-sharing.`);
      }
    } catch (e: any) {
      alert('Errore decifrazione allegato: ' + (e?.message ?? e));
    } finally { setAttLoading(null); }
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

          {attachments.length > 0 && (
            <View style={{ marginTop: space(3), gap: space(2) }}>
              <Text style={T.label}>ALLEGATI ({attachments.length})</Text>
              {attachments.map((att, i) => (
                <View key={i} style={{ gap: space(1) }}>
                  <Text style={T.dim} numberOfLines={1}>
                    {att.name} · {att.size > 1024 * 1024 ? (att.size / 1024 / 1024).toFixed(1) + ' MB' : (att.size / 1024).toFixed(0) + ' KB'}
                  </Text>
                  <Button
                    label={attLoading === att.name ? 'Decifrazione…' : att.mimeType.startsWith('image/') ? 'Visualizza' : 'Apri'}
                    onPress={() => viewAttachment(att)}
                    variant="ghost"
                    disabled={attLoading !== null}
                  />
                </View>
              ))}
            </View>
          )}

          <Text style={[T.dim, { marginTop: space(2) }]}>Eventuali allegati: scaricabili dalla versione completa.</Text>
        </Card>
      )}

      {viewingImage && (
        <Card>
          <Text style={T.label} numberOfLines={1}>{viewingImage.name}</Text>
          <Image
            source={{ uri: viewingImage.uri }}
            style={{ width: '100%', height: 300, borderRadius: 8, marginTop: space(2) }}
            resizeMode="contain"
          />
          <Button label="Chiudi" onPress={() => setViewingImage(null)} variant="ghost" />
        </Card>
      )}
    </Screen>
  );
}
