import { useCallback, useEffect, useRef, useState } from 'react';
import { Text, Image, View, AppState } from 'react-native';
import { useLocalSearchParams, router, useFocusEffect } from 'expo-router';
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
import { savePackage } from '../lib/vault';

// Converte Uint8Array in base64 in chunk per evitare stack overflow su file grandi.
function uint8ToBase64(bytes: Uint8Array): string {
  let out = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(out);
}

type ContentItem = { label: string; text: string; attachments: AttachmentMeta[] };

// Aperta dal CONTATTO alla push (o direttamente).
// INVARIANTE: non usa mai la chiave owner dal payload push o dal server;
// usa loadVerifiedOwnerKey() (chiave verificata di persona al pairing).
//
// Lo stato viene ri-letto a ogni focus e ritorno in foreground: se nel frattempo
// il quorum ha rilasciato (RELEASED), il contatto rifà il percorso di decifratura
// invece di restare su un "in attesa" stantio.
export default function Approve() {
  const { switchId: paramSwitchId, ownerName: paramOwnerName } =
    useLocalSearchParams<{ switchId?: string; ownerName?: string }>();

  const [switchId, setSwitchId]     = useState<string | null>(paramSwitchId ?? null);
  const [ownerName, setOwnerName]   = useState<string>(paramOwnerName ?? 'Questa persona');
  const [req, setReq]               = useState<any>(null);
  const [status, setStatus]         = useState<string>('');
  const [contentItems, setContentItems] = useState<ContentItem[]>([]);
  const [viewingImage, setViewingImage] = useState<{ uri: string; name: string } | null>(null);
  const [attLoading, setAttLoading] = useState<string | null>(null);
  const [err, setErr]               = useState<string | null>(null);
  const [loading, setLoading]       = useState(true);

  // DEK ricombinata in tryReconstruct; tenuta in ref per i tap sugli allegati.
  const dekRef = useRef<Uint8Array | null>(null);
  // switchId risolto (param o /pending): ref per evitare closure stantie nei refresh.
  const switchIdRef = useRef<string | null>(paramSwitchId ?? null);
  const ownerNameRef = useRef<string>(paramOwnerName ?? 'Questa persona');
  // true dopo una decifratura riuscita: i refresh successivi non rifanno nulla.
  const decryptedRef = useRef(false);
  // evita loadState concorrenti (focus + AppState possono scattare vicini).
  const inFlightRef = useRef(false);

  // Ri-legge lo stato dello switch dal server. Se il contatto non ha uno
  // switchId (aperta dalla push generica), lo risolve via /pending — che ora
  // include anche gli switch RELEASED, così un contatto che apre l'app dopo il
  // rilascio trova comunque il pacchetto.
  const loadState = useCallback(async () => {
    if (inFlightRef.current || decryptedRef.current) return;
    inFlightRef.current = true;
    try {
      let sid = switchIdRef.current ?? paramSwitchId ?? null;

      if (!sid) {
        const id = await loadIdentity();
        if (!id) { setErr('Identità non trovata — configura prima l\'app.'); return; }
        const ts = Date.now();
        const pub = bytesToHex(id.pub);
        const sig = signChallenge(id.priv, 'sentinella:pending:' + pub + ':' + ts);
        const { switches } = await api.pendingApprovals(pub, ts, sig);
        if (switches.length === 0) return;
        // Preferisce una richiesta ancora in corso; altrimenti uno switch già rilasciato.
        const pick = switches.find((s) => s.state !== 'RELEASED') ?? switches[0];
        sid = pick.switchId;
        setOwnerName(pick.ownerName);
        ownerNameRef.current = pick.ownerName;
      }
      switchIdRef.current = sid;
      setSwitchId(sid);

      const r = await api.approvalRequest(sid);
      setReq(r);
      if (r.released) {
        await accessReleased(sid);
      }
    } catch (e: any) {
      setErr('Errore nel caricare la richiesta: ' + (e?.message ?? e));
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramSwitchId]);

  // Refresh a ogni focus della schermata e a ogni ritorno in foreground.
  useFocusEffect(useCallback(() => { loadState(); }, [loadState]));
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') loadState(); });
    return () => sub.remove();
  }, [loadState]);

  // Accesso autonomo a uno switch già RELEASED: trova la propria quota (trial
  // decryption), la sottomette (idempotente se già inviata in una sessione
  // precedente), riceve le raccolte e ricombina la DEK in locale.
  // Il server continua a non vedere né DEK né plaintext: riceve solo la quota,
  // come nel flusso di approvazione normale.
  async function accessReleased(sid: string) {
    try {
      const id = await loadIdentity();
      if (!id) { setErr('Identità non trovata — configura prima l\'app.'); return; }
      setStatus('Pacchetto rilasciato — recupero delle quote in corso…');

      const { blobs } = await api.shares(sid);
      const mine = findMyShare(blobs, id.priv);
      if (!mine) {
        setStatus('');
        setErr(
          'Il pacchetto è stato rilasciato, ma su questo dispositivo non c\'è nessuna quota '
          + 'intestata a te. Senza contribuire la tua quota il contenuto non è decifrabile.'
        );
        return;
      }

      let collected: { x: number; y: string }[];
      try {
        ({ collected } = await api.approvalSubmit(sid, { x: mine.x, y: bytesToHex(mine.y) }));
      } catch (e: any) {
        setStatus('');
        setErr(
          'Per accedere al contenuto devi contribuire la tua quota, ma l\'invio non è riuscito: '
          + (e?.message ?? e) + ' — riprova.'
        );
        return;
      }

      const done = await tryReconstruct(collected, sid);
      if (!done) {
        setStatus('Rilascio avvenuto, ma le quote raccolte non bastano ancora a decifrare. Riprova più tardi.');
      }
    } catch (e: any) {
      setErr('Errore nell\'accesso al contenuto rilasciato: ' + (e?.message ?? e));
    }
  }

  // Prova a ricostruire dalle quote raccolte; se decifra, la soglia è raggiunta.
  // L'ordine confirm→download è OBBLIGATO: il server non conosce k, quindi espone
  // i puntatori solo dopo che un client conferma il rilascio (RELEASED).
  // Ritorna false SOLO quando ha senso il messaggio "in attesa di altre approvazioni";
  // gli errori dopo il rilascio vengono mostrati, mai mascherati da attesa.
  async function tryReconstruct(collected: { x: number; y: string }[], sid: string) {
    if (collected.length < 2) return false;

    let dek: Uint8Array;
    try {
      dek = combineSecret(collected.map(shareFromWire));
    } catch (e) {
      console.log('[approve] ricombinazione non riuscita, quote insufficienti o incoerenti', e);
      return false;
    }

    try { await api.releaseConfirm(sid); } catch { /* già RELEASED o rete: fa fede la lettura sotto */ }

    let released: Awaited<ReturnType<typeof api.approvalRequest>>;
    try {
      released = await api.approvalRequest(sid);
    } catch (e) {
      console.error('[approve] stato del rilascio non leggibile (rete?)', e);
      return false; // stato ignoto: l'attesa resta il messaggio meno fuorviante
    }
    if (!released.contents || released.contents.length === 0) return false;

    // Da qui il rilascio È avvenuto: distinguere download fallito da decifratura fallita.
    try {
      const items: ContentItem[] = [];
      for (const c of released.contents) {
        let ctHex: string;
        try {
          ctHex = await downloadEncrypted(c.drivePointer);
        } catch (e: any) {
          console.error('[approve] rilascio avvenuto ma download fallito', c.drivePointer, e);
          setErr(
            'Soglia raggiunta, ma non è stato possibile scaricare il contenuto: '
            + (e?.message ?? String(e)) + ' La tua approvazione è registrata — riprova più tardi.'
          );
          return true;
        }
        const plain = decryptContent(dek, c.contentIv, ctHex);
        const manifest = JSON.parse(new TextDecoder().decode(plain));
        items.push({
          label: c.label || '',
          text: manifest.text ?? '(nessun messaggio)',
          attachments: manifest.attachments ?? [],
        });
      }

      dekRef.current = dek;
      decryptedRef.current = true;
      setErr(null);
      setContentItems(items);
      setStatus('Soglia raggiunta — documentazione rilasciata');

      // Persistenza cifrata a riposo nel vault locale ("Pacchetti ricevuti"):
      // best-effort, non deve mai far fallire il flusso di rilascio.
      try {
        await savePackage({
          switchId: sid,
          ownerName: ownerNameRef.current,
          savedAt: Date.now(),
          dekHex: bytesToHex(dek),
          items: items.map((it) => ({
            label: it.label,
            text: it.text,
            attachments: it.attachments.map((meta) => ({ meta })),
          })),
        });
      } catch (e) {
        console.log('[approve] salvataggio nel vault non riuscito', e);
      }
      return true;
    } catch (e) {
      // Decifratura fallita: con k>2 può semplicemente mancare qualche quota
      // (la DEK ricombinata da meno di k quote è spazzatura) — non è detto che
      // sia un errore. Se persiste con tutte le quote, il contenuto è danneggiato.
      console.error('[approve] contenuto scaricato ma non decifrabile', e);
      setStatus(
        `Contenuto scaricato ma non ancora decifrabile con ${collected.length} quote raccolte: `
        + 'probabilmente servono altre approvazioni.'
      );
      return true;
    }
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
    const done = await tryReconstruct(collected, switchId);
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
      {!req?.pending && !req?.released && contentItems.length === 0 && !status && !err && (
        <Text style={T.dim}>Nessuna richiesta di approvazione in sospeso.</Text>
      )}
      {req?.pending && contentItems.length === 0 && (
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
      {req?.released && contentItems.length === 0 && (
        <Card tone="danger">
          <Pill label="PACCHETTO RILASCIATO" tone="danger" />
          <Text style={[T.body, { marginTop: space(2) }]}>
            Il quorum ha rilasciato la documentazione di {ownerName}. Per leggerla
            devi contribuire la tua quota: la decifratura avviene solo sul tuo
            dispositivo, il server non vede mai il contenuto.
          </Text>
          {!!status && <Text style={T.dim}>{status}</Text>}
          <Button
            label="Contribuisci la mia quota e decifra"
            onPress={() => { const sid = switchIdRef.current; if (sid) accessReleased(sid); }}
            variant="danger"
          />
        </Card>
      )}
      {contentItems.length > 0 && (
        <Card tone="safe">
          <Text style={T.heading}>{status}</Text>
          {contentItems.map((item, idx) => (
            <View key={idx} style={{ marginTop: idx > 0 ? space(5) : space(2) }}>
              {!!item.label && (
                <Text style={[T.label, { marginBottom: space(1) }]}>{item.label.toUpperCase()}</Text>
              )}
              <Text style={T.body}>{item.text}</Text>
              {item.attachments.length > 0 && (
                <View style={{ marginTop: space(3), gap: space(2) }}>
                  <Text style={T.label}>ALLEGATI ({item.attachments.length})</Text>
                  {item.attachments.map((att, i) => (
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
            </View>
          ))}
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
