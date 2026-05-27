import { useState, useCallback } from 'react';
import { View, Text, TextInput, Pressable, Alert } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Screen, Card, Button, T } from '../components/ui';
import { colors, space, radius } from '../theme';
import { api } from '../lib/api';
import {
  loadOwnerId, loadSwitchId, saveSwitchId,
  loadVerifiedContactKeys, saveVerifiedContactKey,
  saveDek, loadDek,
  saveContentPointer, loadContentPointers, deleteContentPointer,
} from '../lib/keystore';
import { encryptWithKey, decryptContent, splitSecret, sealShare, makeDecoy, hexToBytes, bytesToHex, randomBytes } from '../lib/crypto';
import { uploadEncrypted, downloadEncrypted, deleteEncrypted } from '../lib/drive';
import { toSeconds, formatDuration, INTERVAL_PRESETS, PROD_LIMITS, DEV_LIMITS, type TimeUnit, type Preset } from '../lib/timing';
import { encryptAndUpload, type PendingAttachment, type AttachmentMeta, MAX_FILE_BYTES, MAX_TOTAL_BYTES } from '../lib/attachments';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';

type PresetId = Preset['id'];
type ExistingContent = { id: string; label: string; created_at: number };

export default function Compose() {
  // mode='add' → aggiorna contenuto di switch già armato (senza ridistribuire quote)
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const isAddMode = mode === 'add';

  const [text, setText]           = useState('');
  const [label, setLabel]         = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [uploadStep, setUploadStep]   = useState<string | null>(null);

  // Add-mode only state
  const [existingContents, setExistingContents] = useState<ExistingContent[]>([]);

  // Arm-mode only state
  const [contacts, setContacts]     = useState<any[]>([]);
  const [chosen, setChosen]         = useState<Set<string>>(new Set());
  const [k, setK]                   = useState('2');
  const [intervalPreset, setIntervalPreset] = useState<PresetId>('daily');
  const [customINum, setCustomINum] = useState('1');
  const [customIUnit, setCustomIUnit] = useState<TimeUnit>('hours');
  const [graceNum, setGraceNum]     = useState('6');
  const [graceUnit, setGraceUnit]   = useState<TimeUnit>('hours');
  const [verifiedKeys, setVerifiedKeys] = useState<Set<string>>(new Set());

  const [busy, setBusy] = useState(false);

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

  const loadExistingContents = useCallback(async () => {
    const switchId = await loadSwitchId();
    if (!switchId) return;
    try {
      const { contents } = await api.listContents(switchId);
      setExistingContents(contents);
    } catch { /* switch non trovato */ }
  }, []);

  useFocusEffect(useCallback(() => {
    if (isAddMode) {
      loadExistingContents();
    } else {
      loadContacts();
    }
  }, [isAddMode, loadContacts, loadExistingContents]));

  // ── DEV ONLY ───────────────────────────────────────────────────────────────
  async function devSeedContacts() {
    const ownerId = await loadOwnerId();
    if (!ownerId) { alert('Nessun ownerId — completa prima l\'onboarding.'); return; }
    try {
      const { contacts: seeded } = await api.seedContacts(ownerId);
      for (const c of seeded) await saveVerifiedContactKey(c.publicKey);
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

  // ── Allegati ───────────────────────────────────────────────────────────────
  function addAttachment(att: PendingAttachment) {
    if (att.size > MAX_FILE_BYTES) {
      alert(`File troppo grande: ${att.name} (${(att.size / 1024 / 1024).toFixed(1)} MB). Limite: 25 MB.`);
      return;
    }
    const total = attachments.reduce((s, a) => s + a.size, 0) + att.size;
    if (total > MAX_TOTAL_BYTES) {
      alert('Totale pacchetto supera 200 MB. Rimuovi qualche file prima.');
      return;
    }
    setAttachments(prev => [...prev, att]);
  }

  async function pickDocument() {
    try {
      const r = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
      if (r.canceled) return;
      const f = r.assets[0];
      addAttachment({ uri: f.uri, name: f.name, mimeType: f.mimeType ?? 'application/octet-stream', size: f.size ?? 0 });
    } catch (e: any) { alert('Errore apertura file: ' + (e?.message ?? e)); }
  }

  async function pickImage() {
    try {
      const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.All, quality: 1 });
      if (r.canceled) return;
      const a = r.assets[0];
      addAttachment({ uri: a.uri, name: a.fileName ?? 'immagine', mimeType: a.mimeType ?? 'image/jpeg', size: a.fileSize ?? 0 });
    } catch (e: any) { alert('Errore apertura galleria: ' + (e?.message ?? e)); }
  }

  async function uploadAllAttachments(dek: Uint8Array): Promise<AttachmentMeta[]> {
    const metas: AttachmentMeta[] = [];
    for (let i = 0; i < attachments.length; i++) {
      setUploadStep(`Caricamento allegato ${i + 1}/${attachments.length}…`);
      metas.push(await encryptAndUpload(attachments[i], dek));
    }
    return metas;
  }

  // ── Rimozione contenuto esistente ──────────────────────────────────────────
  async function confirmRemoveContent(item: ExistingContent) {
    if (existingContents.length <= 1) {
      alert('Un pacchetto armato deve contenere almeno un contenuto. Aggiungi un nuovo contenuto prima di rimuovere questo.');
      return;
    }
    Alert.alert(
      'Rimuovere questo contenuto?',
      `"${item.label || '(senza etichetta)'}" verrà eliminato definitivamente dal pacchetto.`,
      [
        { text: 'Annulla', style: 'cancel' },
        { text: 'Rimuovi', style: 'destructive', onPress: () => removeContentItem(item.id) },
      ],
    );
  }

  async function removeContentItem(contentId: string) {
    const switchId = await loadSwitchId();
    if (!switchId) return;
    setBusy(true);
    try {
      const dekHex = await loadDek(switchId);
      const pointers = await loadContentPointers(switchId);
      const entry = pointers[contentId];

      if (entry && dekHex) {
        const dek = hexToBytes(dekHex);
        try {
          const ctHex = await downloadEncrypted(entry.pointer);
          const plain = decryptContent(dek, entry.iv, ctHex);
          const manifest = JSON.parse(new TextDecoder().decode(plain));
          for (const att of (manifest.attachments ?? [])) {
            try { await deleteEncrypted(att.pointer); } catch { /* best effort */ }
          }
          try { await deleteEncrypted(entry.pointer); } catch { /* best effort */ }
        } catch { /* se il manifest non è decifrabile, pulizia storage saltata */ }
      }

      await api.removeContent(switchId, contentId);
      if (entry) await deleteContentPointer(switchId, contentId);
      await loadExistingContents();
    } catch (e: any) {
      alert('Errore rimozione: ' + (e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  // ── Aggiunge contenuto (switch già ACTIVE, stessa DEK) ────────────────────
  async function updateContent() {
    const switchId = await loadSwitchId();
    if (!switchId) { alert('Nessuno switch trovato.'); return; }
    const dekHex = await loadDek(switchId);
    if (!dekHex) {
      alert('DEK non trovata per questo switch. Riprova l\'armo dal percorso completo.');
      return;
    }
    const dek = hexToBytes(dekHex);
    setBusy(true);
    try {
      const attMetas = await uploadAllAttachments(dek);
      const manifest = JSON.stringify({ v: 1, text, attachments: attMetas });
      setUploadStep('Cifratura manifesto…');
      const { nonce, ct } = encryptWithKey(dek, new TextEncoder().encode(manifest));
      setUploadStep('Caricamento manifesto…');
      const drivePointer = await uploadEncrypted(ct);
      const { contentId } = await api.addContent(switchId, drivePointer, nonce, label || undefined);
      await saveContentPointer(switchId, contentId, drivePointer, nonce);
      router.replace('/home');
    } catch (e: any) {
      alert('Errore aggiornamento: ' + (e?.message ?? 'Errore sconosciuto'));
    } finally { setBusy(false); setUploadStep(null); }
  }

  // ── Arma lo switch (prima armo o ri-armo con nuovi contatti) ───────────────
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
      ? `Con k=${kNum} su N=${N}, perdere anche un solo contatto rende il rilascio impossibile. Idealmente N ≥ k+2.`
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
      // Genera DEK separatamente per poterla salvare e riusare in add-content
      const dek = randomBytes(32);
      const attMetas = await uploadAllAttachments(dek);
      const manifest = JSON.stringify({ v: 1, text, attachments: attMetas });
      setUploadStep('Cifratura manifesto…');
      const { nonce, ct } = encryptWithKey(dek, new TextEncoder().encode(manifest));
      setUploadStep('Caricamento manifesto…');
      const drivePointer = await uploadEncrypted(ct);
      let switchId = await loadSwitchId();
      if (!switchId) {
        const r = await api.createSwitch(ownerId, intervalSec, graceSec);
        switchId = r.switchId; await saveSwitchId(switchId);
      }
      await saveDek(switchId, bytesToHex(dek));
      const shares = splitSecret(dek, recipients.length, threshold);
      const real = recipients.map((c, i) => ({ x: shares[i].x, blob: sealShare(hexToBytes(c.public_key), shares[i]) }));
      const TOTAL = 8;
      const decoys = Array.from({ length: Math.max(0, TOTAL - real.length) }, (_, j) => ({ x: 100 + j, blob: makeDecoy(32) }));
      const wire = [...real, ...decoys].sort(() => Math.random() - 0.5);
      const { contentId } = await api.arm({ switchId, drivePointer, contentIv: nonce, label: label || undefined, shares: wire });
      await saveContentPointer(switchId, contentId, drivePointer, nonce);
      router.replace('/home');
    } catch (e: any) {
      alert('Errore durante l\'armo: ' + (e?.message ?? 'Errore sconosciuto'));
    } finally { setBusy(false); setUploadStep(null); }
  }

  const field = { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: radius.md, padding: space(3), color: colors.ink, fontSize: 16 };
  const chip = { paddingHorizontal: space(3), paddingVertical: space(2), borderRadius: radius.pill as number, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface };
  const chipSel = { borderColor: colors.safe, backgroundColor: colors.safeSoft };
  const chipTxt = { fontSize: 14, color: colors.inkDim };
  const chipTxtSel = { color: colors.safe, fontWeight: '600' as const };

  return (
    <Screen>
      <Text style={T.dim}>
        {isAddMode
          ? 'Aggiunta contenuto. Le quote dei contatti restano valide.'
          : 'Cosa rilasciare, a chi, e con quante approvazioni. Tutto viene cifrato sul telefono.'}
      </Text>

      {isAddMode && existingContents.length > 0 && (
        <Card>
          <Text style={T.label}>CONTENUTI NEL PACCHETTO ({existingContents.length})</Text>
          {existingContents.map((item) => (
            <View key={item.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space(2), paddingVertical: space(2), borderBottomWidth: 1, borderBottomColor: colors.line }}>
              <View style={{ flex: 1 }}>
                <Text style={T.body} numberOfLines={1}>{item.label || '(senza etichetta)'}</Text>
                <Text style={{ fontSize: 12, color: colors.inkFaint }}>
                  {new Date(item.created_at).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' })}
                </Text>
              </View>
              <Pressable
                onPress={() => confirmRemoveContent(item)}
                disabled={busy}
                style={{ paddingHorizontal: space(2), paddingVertical: space(1) }}>
                <Text style={{ color: colors.danger, fontSize: 14 }}>Rimuovi</Text>
              </Pressable>
            </View>
          ))}
        </Card>
      )}

      <Card>
        <Text style={T.label}>ETICHETTA (OPZIONALE)</Text>
        <TextInput value={label} onChangeText={setLabel}
          placeholder="Es. Messaggio principale, Documenti medici…"
          placeholderTextColor={colors.inkFaint}
          style={field} />
        <Text style={{ fontSize: 11, color: colors.inkFaint, marginTop: space(1) }}>
          Visibile nella lista contenuti — non usare informazioni sensibili.
        </Text>
      </Card>

      <Card>
        <Text style={T.label}>MESSAGGIO DI RILASCIO</Text>
        <TextInput value={text} onChangeText={setText} multiline
          placeholder="Se leggete questo, non rispondo da troppo tempo…"
          placeholderTextColor={colors.inkFaint}
          style={[field, { minHeight: 110, textAlignVertical: 'top' }]} />
      </Card>

      <Card>
        <Text style={T.label}>ALLEGATI ({attachments.length})</Text>
        {attachments.map((a, i) => (
          <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: space(2), paddingVertical: space(1) }}>
            <Text style={[T.dim, { flex: 1 }]} numberOfLines={1}>
              {a.name} · {a.size > 1024 * 1024 ? (a.size / 1024 / 1024).toFixed(1) + ' MB' : (a.size / 1024).toFixed(0) + ' KB'}
            </Text>
            <Pressable onPress={() => setAttachments(prev => prev.filter((_, j) => j !== i))}
              style={{ paddingHorizontal: space(2) }}>
              <Text style={{ color: colors.danger, fontSize: 16 }}>✕</Text>
            </Pressable>
          </View>
        ))}
        <View style={{ flexDirection: 'row', gap: space(2), marginTop: space(1) }}>
          <Button label="+ Documento" variant="ghost" onPress={pickDocument} />
          <Button label="+ Foto/Video" variant="ghost" onPress={pickImage} />
        </View>
        {uploadStep && <Text style={[T.dim, { marginTop: space(1) }]}>{uploadStep}</Text>}
      </Card>

      {!isAddMode && (
        <>
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
              <Button label="[DEV] Genera 2 contatti test" variant="ghost" onPress={devSeedContacts} />
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
        </>
      )}

      {isAddMode ? (
        <Button
          label={busy ? uploadStep ?? 'Caricamento…' : 'Aggiungi al pacchetto'}
          onPress={updateContent}
          variant="safe"
          disabled={busy}
        />
      ) : (
        <Button
          label={busy ? uploadStep ?? 'Cifratura…' : 'Cifra e arma lo switch'}
          onPress={armSwitch}
          variant="safe"
          disabled={busy || !!kError || !!timeError}
        />
      )}
    </Screen>
  );
}
