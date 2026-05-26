import { useState, useCallback } from 'react';
import { View, Text, TextInput, Pressable } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Screen, Card, Button, T } from '../components/ui';
import { colors, space, radius } from '../theme';
import { api } from '../lib/api';
import { loadOwnerId, loadSwitchId, saveSwitchId, loadVerifiedContactKeys, saveVerifiedContactKey } from '../lib/keystore';
import { encryptContent, splitSecret, sealShare, makeDecoy, hexToBytes } from '../lib/crypto';
import { uploadEncrypted } from '../lib/drive';
import { toSeconds, formatDuration, INTERVAL_PRESETS, PROD_LIMITS, DEV_LIMITS, type TimeUnit, type Preset } from '../lib/timing';

type PresetId = Preset['id'];

export default function Compose() {
  const [text, setText] = useState('');
  const [contacts, setContacts] = useState<any[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [k, setK] = useState('2');
  const [intervalPreset, setIntervalPreset] = useState<PresetId>('daily');
  const [customINum, setCustomINum] = useState('1');
  const [customIUnit, setCustomIUnit] = useState<TimeUnit>('hours');
  const [graceNum, setGraceNum] = useState('6');
  const [graceUnit, setGraceUnit] = useState<TimeUnit>('hours');
  const [busy, setBusy] = useState(false);
  const [verifiedKeys, setVerifiedKeys] = useState<Set<string>>(new Set());

  const loadContacts = useCallback(async () => {
    const ownerId = await loadOwnerId();
    if (!ownerId) return;
    const [{ contacts: cs }, vk] = await Promise.all([
      api.contacts(ownerId),
      loadVerifiedContactKeys(),
    ]);
    setContacts(cs);
    setChosen(new Set(cs.map((c: any) => c.id)));
    setVerifiedKeys(vk);
  }, []);

  useFocusEffect(useCallback(() => { loadContacts(); }, [loadContacts]));

  // ── DEV ONLY ───────────────────────────────────────────────────────────────
  // Crea 2 contatti fittizi sul server e li salva come "verificati" sul client
  // così l'armo con k=2 è possibile senza un pairing reale con due dispositivi.
  // ATTENZIONE: le quote cifrate verso questi contatti non sono decifrabili.
  // Serve SOLO per testare il ciclo armo → scheduler → push check-in.
  async function devSeedContacts() {
    const ownerId = await loadOwnerId();
    if (!ownerId) { alert('Nessun ownerId — completa prima l\'onboarding.'); return; }
    try {
      const { contacts: seeded } = await api.seedContacts(ownerId);
      for (const c of seeded) {
        await saveVerifiedContactKey(c.publicKey);
      }
      await loadContacts();
      alert(`[DEV] ${seeded.length} contatti test creati.\nNon verificati di persona — solo per testare la push check-in.`);
    } catch (e: any) {
      alert('[DEV] Errore seed: ' + (e?.message ?? e));
    }
  }

  function toggle(id: string) {
    const next = new Set(chosen);
    next.has(id) ? next.delete(id) : next.add(id);
    setChosen(next);
  }

  const limits = __DEV__ ? DEV_LIMITS : PROD_LIMITS;

  const intervalSec = intervalPreset !== 'custom'
    ? INTERVAL_PRESETS.find(p => p.id === intervalPreset)!.seconds
    : toSeconds(parseInt(customINum) || 0, customIUnit);
  const graceSec = toSeconds(parseInt(graceNum) || 0, graceUnit);

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

  const timeError: string | null =
    intervalSec < limits.intervalMin
      ? `Intervallo minimo: ${formatDuration(limits.intervalMin)}.`
      : intervalSec > limits.intervalMax
        ? `Intervallo massimo: ${formatDuration(limits.intervalMax)}.`
        : graceSec < limits.graceMin
          ? `Grazia minima: ${formatDuration(limits.graceMin)}.`
          : null;

  async function armSwitch() {
    const ownerId = await loadOwnerId();
    if (!ownerId) return;
    if (kError)    { alert(kError);    return; }
    if (timeError) { alert(timeError); return; }
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
        const r = await api.createSwitch(ownerId, intervalSec, graceSec);
        switchId = r.switchId; await saveSwitchId(switchId);
      }
      await api.arm({ switchId, drivePointer, contentIv: nonce, shares: wire });
      router.replace('/home');
    } catch (e: any) {
      alert('Errore durante l\'armo: ' + (e?.message ?? 'Errore sconosciuto'));
    } finally { setBusy(false); }
  }

  const field = { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: radius.md, padding: space(3), color: colors.ink, fontSize: 16 };
  const chip = { paddingHorizontal: space(3), paddingVertical: space(2), borderRadius: radius.pill as number, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface };
  const chipSel = { borderColor: colors.safe, backgroundColor: colors.safeSoft };
  const chipTxt = { fontSize: 14, color: colors.inkDim };
  const chipTxtSel = { color: colors.safe, fontWeight: '600' as const };

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
          const isDevContact = c.id?.startsWith('c_dev_');
          return (
            <Pressable key={c.id} onPress={() => toggle(c.id)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: space(3), paddingVertical: space(2) }}>
              <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: on ? colors.safe : colors.line, backgroundColor: on ? colors.safe : 'transparent' }} />
              <View style={{ flex: 1 }}>
                <Text style={T.body}>{c.public_key.slice(0, 18)}…{isDevContact && ' [DEV]'}</Text>
                {!verified && (
                  <Text style={{ fontSize: 11, color: colors.danger }}>⚠ chiave non verificata di persona</Text>
                )}
              </View>
            </Pressable>
          );
        })}
        {__DEV__ && (
          <Button
            label="[DEV] Genera 2 contatti test"
            variant="ghost"
            onPress={devSeedContacts}
          />
        )}
      </Card>

      <Card>
        <Text style={T.label}>SOGLIA E TEMPI</Text>

        <View>
          <Text style={T.dim}>Approvazioni minime per rilasciare (k)</Text>
          <TextInput value={k} onChangeText={setK} keyboardType="number-pad"
            style={[field, { width: 80, marginTop: space(2) }]} />
        </View>

        <View style={{ gap: space(2) }}>
          <Text style={T.dim}>Ogni quanto ti chiedo «tutto ok?»</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2) }}>
            {INTERVAL_PRESETS.map(p => (
              <Pressable key={p.id} onPress={() => setIntervalPreset(p.id)}
                style={[chip, intervalPreset === p.id && chipSel]}>
                <Text style={[chipTxt, intervalPreset === p.id && chipTxtSel]}>{p.label}</Text>
              </Pressable>
            ))}
          </View>
          {intervalPreset === 'custom' && (
            <View style={{ flexDirection: 'row', gap: space(2), alignItems: 'center' }}>
              <TextInput value={customINum} onChangeText={setCustomINum} keyboardType="number-pad"
                style={[field, { width: 70 }]} />
              <View style={{ flexDirection: 'row', gap: space(1) }}>
                {(['hours', 'days'] as TimeUnit[]).concat(__DEV__ ? ['seconds' as TimeUnit] : []).map(u => (
                  <Pressable key={u} onPress={() => setCustomIUnit(u)}
                    style={[chip, customIUnit === u && chipSel]}>
                    <Text style={[chipTxt, customIUnit === u && chipTxtSel]}>
                      {u === 'hours' ? 'Ore' : u === 'days' ? 'Giorni' : 'Sec'}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}
          {intervalPreset !== 'custom' && (
            <Text style={{ fontSize: 12, color: colors.inkFaint }}>
              Il server ti contatta ogni {formatDuration(intervalSec)} se non rispondi
            </Text>
          )}
        </View>

        <View style={{ gap: space(2) }}>
          <Text style={T.dim}>Tempo di grazia prima dell'allerta ai contatti</Text>
          <View style={{ flexDirection: 'row', gap: space(2), alignItems: 'center' }}>
            <TextInput value={graceNum} onChangeText={setGraceNum} keyboardType="number-pad"
              style={[field, { width: 70 }]} />
            <View style={{ flexDirection: 'row', gap: space(1) }}>
              {(['hours', 'days'] as TimeUnit[]).concat(__DEV__ ? ['seconds' as TimeUnit] : []).map(u => (
                <Pressable key={u} onPress={() => setGraceUnit(u)}
                  style={[chip, graceUnit === u && chipSel]}>
                  <Text style={[chipTxt, graceUnit === u && chipTxtSel]}>
                    {u === 'hours' ? 'Ore' : u === 'days' ? 'Giorni' : 'Sec'}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
          <Text style={{ fontSize: 12, color: colors.inkFaint }}>
            Hai {formatDuration(graceSec)} per rispondere prima che i contatti ricevano l'allerta
          </Text>
        </View>

        {kError    && <Text style={{ ...T.dim, color: colors.danger    }}>{kError}</Text>}
        {kWarning  && <Text style={{ ...T.dim, color: colors.heartbeat }}>{kWarning}</Text>}
        {timeError && <Text style={{ ...T.dim, color: colors.danger    }}>{timeError}</Text>}
      </Card>

      <Button label={busy ? 'Cifratura…' : 'Cifra e arma lo switch'} onPress={armSwitch} variant="safe" disabled={busy || !!kError || !!timeError} />
    </Screen>
  );
}
