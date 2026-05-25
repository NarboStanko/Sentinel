import { useState, useCallback } from 'react';
import { View, Text, TextInput, Pressable } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Screen, Card, Button, T } from '../components/ui';
import { colors, space, radius } from '../theme';
import { api } from '../lib/api';
import { loadOwnerId, loadSwitchId, saveSwitchId, loadVerifiedContactKeys } from '../lib/keystore';
import { encryptContent, splitSecret, sealShare, makeDecoy, hexToBytes } from '../lib/crypto';
import { uploadEncrypted } from '../lib/drive';

export default function Compose() {
  const [text, setText] = useState('');
  const [contacts, setContacts] = useState<any[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [k, setK] = useState('2');
  const [interval, setIntervalSec] = useState('60');
  const [grace, setGrace] = useState('30');
  const [busy, setBusy] = useState(false);
  const [verifiedKeys, setVerifiedKeys] = useState<Set<string>>(new Set());

  useFocusEffect(useCallback(() => {
    (async () => {
      const ownerId = await loadOwnerId();
      if (ownerId) {
        const [{ contacts: cs }, vk] = await Promise.all([
          api.contacts(ownerId),
          loadVerifiedContactKeys(),
        ]);
        setContacts(cs);
        setChosen(new Set(cs.map((c: any) => c.id)));
        setVerifiedKeys(vk);
      }
    })();
  }, []));

  function toggle(id: string) {
    const next = new Set(chosen);
    next.has(id) ? next.delete(id) : next.add(id);
    setChosen(next);
  }

  const kNum = parseInt(k) || 0;
  const N = chosen.size;
  const unverifiedChosen = contacts.filter(c => chosen.has(c.id) && !verifiedKeys.has(c.public_key));
  const kError: string | null =
    unverifiedChosen.length > 0
      ? `${unverifiedChosen.length} destinatario${unverifiedChosen.length > 1 ? 'i' : ''} selezionato${unverifiedChosen.length > 1 ? 'i' : ''} ${unverifiedChosen.length > 1 ? 'hanno chiave' : 'ha la chiave'} non verificata di persona. Ripeti il pairing prima di armare.`
      : kNum < 2
        ? 'Un solo approvatore può rilasciare da solo: scegli almeno 2.'
        : kNum > N
          ? `Soglia ${kNum} impossibile con ${N} destinatari scelti.`
          : null;
  const kWarning: string | null =
    kError === null && N > 0 && kNum === N
      ? `Con k=${kNum} su N=${N}, perdere anche un solo contatto rende il rilascio impossibile. Idealmente N ≥ k+2 (aggiungi almeno 2 contatti di scorta).`
      : null;

  async function armSwitch() {
    const ownerId = await loadOwnerId();
    if (!ownerId) return;
    if (kError) { alert(kError); return; }
    const recipients = contacts.filter((c) => chosen.has(c.id));
    const threshold = kNum;
    if (recipients.length < threshold) { alert(`Servono almeno ${threshold} contatti selezionati.`); return; }
    setBusy(true);
    try {
      // 1) contenuto -> JSON -> cifrato una volta con DEK
      const manifest = JSON.stringify({ text, files: [] }); // TODO: allegati (expo-document-picker/image-picker)
      const { dek, nonce, ct } = encryptContent(new TextEncoder().encode(manifest));
      // 2) ciphertext sul drive esterno (server riceve solo il puntatore)
      const drivePointer = await uploadEncrypted(ct);
      // 3) DEK spezzata k-su-N, ogni quota cifrata per la chiave pubblica del contatto
      const shares = splitSecret(dek, recipients.length, threshold);
      // quote reali, una sigillata per ogni contatto
      const real = recipients.map((c, i) => ({ x: shares[i].x, blob: sealShare(hexToBytes(c.public_key), shares[i]) }));
      // OCCULTAMENTO: aggiungi esche fino a un totale fisso, poi mescola.
      // Il server vede sempre lo stesso numero di blob opachi (non sa N ne' k).
      const TOTAL = 8;
      const decoys = Array.from({ length: Math.max(0, TOTAL - real.length) }, (_, j) => ({ x: 100 + j, blob: makeDecoy(32) }));
      const wire = [...real, ...decoys].sort(() => Math.random() - 0.5);
      // 4) crea/arma lo switch
      let switchId = await loadSwitchId();
      if (!switchId) {
        const r = await api.createSwitch(ownerId, parseInt(interval) || 60, parseInt(grace) || 30);
        switchId = r.switchId; await saveSwitchId(switchId);
      }
      await api.arm({ switchId, drivePointer, contentIv: nonce, shares: wire });
      router.replace('/home');
    } finally { setBusy(false); }
  }

  const field = { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: radius.md, padding: space(3), color: colors.ink, fontSize: 16 };

  return (
    <Screen>
      <Text style={T.dim}>Cosa rilasciare, a chi, e con quante approvazioni. Tutto viene cifrato sul telefono.</Text>

      <Card>
        <Text style={T.label}>MESSAGGIO DI RILASCIO</Text>
        <TextInput value={text} onChangeText={setText} multiline placeholder="Se leggete questo, non rispondo da troppo tempo…"
          placeholderTextColor={colors.inkFaint} style={[field, { minHeight: 110, textAlignVertical: 'top' }]} />
        <Button label="+ Allega file (pdf, foto)" variant="ghost" onPress={() => alert('TODO: expo-document-picker / expo-image-picker')} />
      </Card>

      <Card>
        <Text style={T.label}>DESTINATARI ({chosen.size})</Text>
        {contacts.length === 0 && <Text style={T.dim}>Aggiungi prima dei contatti fidati.</Text>}
        {contacts.map((c) => {
          const on = chosen.has(c.id);
          const verified = verifiedKeys.has(c.public_key);
          return (
            <Pressable key={c.id} onPress={() => toggle(c.id)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: space(3), paddingVertical: space(2) }}>
              <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: on ? colors.safe : colors.line, backgroundColor: on ? colors.safe : 'transparent' }} />
              <View style={{ flex: 1 }}>
                <Text style={T.body}>{c.public_key.slice(0, 18)}…</Text>
                {!verified && (
                  <Text style={{ fontSize: 11, color: colors.danger }}>⚠ chiave non verificata di persona</Text>
                )}
              </View>
            </Pressable>
          );
        })}
      </Card>

      <Card>
        <Text style={T.label}>SOGLIA E TEMPI</Text>
        <View style={{ flexDirection: 'row', gap: space(3) }}>
          <View style={{ flex: 1 }}><Text style={T.dim}>Approvazioni (k)</Text><TextInput value={k} onChangeText={setK} keyboardType="number-pad" style={field} /></View>
          <View style={{ flex: 1 }}><Text style={T.dim}>Intervallo (s)</Text><TextInput value={interval} onChangeText={setIntervalSec} keyboardType="number-pad" style={field} /></View>
          <View style={{ flex: 1 }}><Text style={T.dim}>Grazia (s)</Text><TextInput value={grace} onChangeText={setGrace} keyboardType="number-pad" style={field} /></View>
        </View>
        {kError   && <Text style={{ ...T.dim, color: colors.danger    }}>{kError}</Text>}
        {kWarning && <Text style={{ ...T.dim, color: colors.heartbeat }}>{kWarning}</Text>}
      </Card>

      <Button label={busy ? 'Cifratura…' : 'Cifra e arma lo switch'} onPress={armSwitch} variant="safe" disabled={busy || !!kError} />
    </Screen>
  );
}
