import { useState, useCallback, useRef } from 'react';
import { View, Text, Alert } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Screen, Card, Button, T } from '../components/ui';
import { colors, space, radius } from '../theme';
import { api } from '../lib/api';
import {
  loadOwnerId, loadVerifiedContactKeys, loadIdentity,
  loadMyContactIds, deleteMyContactId, type MyContactEntry,
} from '../lib/keystore';
import { bytesToHex, signChallenge } from '../lib/crypto';
import { isFacadeActive, FACADE_CONTACTS } from '../lib/facadeStore';

export default function Contacts() {
  const [contacts, setContacts]       = useState<any[]>([]);
  const [verifiedKeys, setVerifiedKeys] = useState<Set<string>>(new Set());
  const [myPairings, setMyPairings]   = useState<MyContactEntry[]>([]);
  const [scanForContact, setScanForContact] = useState<string | null>(null);
  const [busy, setBusy]               = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const scannedRef = useRef(false);

  const loadOwnerContacts = useCallback(async () => {
    // Modalità facciata: contatti fittizi (mostrati come verificati per
    // credibilità), nessuna chiamata al server.
    if (await isFacadeActive()) {
      setContacts(FACADE_CONTACTS);
      setVerifiedKeys(new Set(FACADE_CONTACTS.map((c) => c.public_key)));
      return;
    }
    const ownerId = await loadOwnerId();
    if (!ownerId) return;
    const [{ contacts: cs }, vk] = await Promise.all([
      api.contacts(ownerId),
      loadVerifiedContactKeys(),
    ]);
    setContacts(cs);
    setVerifiedKeys(vk);
  }, []);

  const loadMyPairings = useCallback(async () => {
    // In facciata i pairing reali (dove sono contatto di altri) restano nascosti.
    if (await isFacadeActive()) { setMyPairings([]); return; }
    setMyPairings(await loadMyContactIds());
  }, []);

  useFocusEffect(useCallback(() => {
    loadOwnerContacts();
    loadMyPairings();
  }, [loadOwnerContacts, loadMyPairings]));

  // ── Rimozione contatto (owner) ────────────────────────────────────────────────
  function askRemoveContact(contact: any) {
    Alert.alert(
      'Rimuovere questo contatto?',
      `Chiave: ${contact.public_key.slice(0, 22)}…\n\nQuesta operazione è irreversibile.`,
      [
        { text: 'Annulla', style: 'cancel' },
        { text: 'Rimuovi', style: 'destructive', onPress: () => doRemoveContact(contact, false) },
      ],
    );
  }

  async function doRemoveContact(contact: any, force: boolean) {
    const identity = await loadIdentity();
    if (!identity) return;
    setBusy(true);
    try {
      const ts = Date.now();
      const ownerPub = bytesToHex(identity.pub);
      const sig = signChallenge(identity.priv, `sentinella:remove-contact:${contact.id}:${ts}`);
      await api.removeContact(contact.id, ownerPub, ts, sig, force || undefined);
      await loadOwnerContacts();
    } catch (e: any) {
      if (e?.status === 409 && !force) {
        Alert.alert(
          'Switch armato attivo',
          'Rimuovere questo contatto renderà la soglia di rilascio più difficile o irraggiungibile. ' +
          'Il pacchetto potrebbe non aprirsi mai.\n\nVuoi procedere comunque?',
          [
            { text: 'Annulla', style: 'cancel' },
            { text: 'Forza rimozione', style: 'destructive', onPress: () => doRemoveContact(contact, true) },
          ],
        );
      } else {
        alert('Errore rimozione: ' + (e?.message ?? 'Errore sconosciuto'));
      }
    } finally {
      setBusy(false);
    }
  }

  // ── Rotazione chiave (owner scansiona nuovo QR del contatto) ──────────────────
  function startKeyRotation(contactId: string) {
    scannedRef.current = false;
    setScanForContact(contactId);
  }

  async function handleKeyRotationScan(raw: string) {
    if (scannedRef.current) return;
    scannedRef.current = true;
    let payload: any;
    try { payload = JSON.parse(raw); } catch {
      scannedRef.current = false;
      alert('QR non riconosciuto.');
      return;
    }
    if (payload?.type !== 'key_update' || !payload?.contactPublicKey) {
      scannedRef.current = false;
      alert('QR non riconosciuto. Assicurati che il contatto mostri il QR di aggiornamento chiave.');
      return;
    }

    const newKey = payload.contactPublicKey as string;
    const contactId = scanForContact!;
    setScanForContact(null);

    Alert.alert(
      'Aggiornare la chiave?',
      `Nuova chiave: ${newKey.slice(0, 22)}…\n\nVerifica che il contatto mostri questa chiave sul suo telefono.`,
      [
        { text: 'Annulla', style: 'cancel' },
        { text: 'Aggiorna', onPress: () => doRotateKey(contactId, newKey) },
      ],
    );
  }

  async function doRotateKey(contactId: string, newPublicKey: string) {
    const identity = await loadIdentity();
    if (!identity) return;
    setBusy(true);
    try {
      const ts = Date.now();
      const ownerPub = bytesToHex(identity.pub);
      const sig = signChallenge(identity.priv, `sentinella:rotate-contact-key:${contactId}:${newPublicKey}:${ts}`);
      await api.rotateContactKey(contactId, newPublicKey, ownerPub, ts, sig);
      await loadOwnerContacts();
    } catch (e: any) {
      if (e?.status === 409) {
        alert('Disarma lo switch prima di aggiornare la chiave del contatto.');
      } else {
        alert('Errore aggiornamento chiave: ' + (e?.message ?? 'Errore sconosciuto'));
      }
    } finally {
      setBusy(false);
    }
  }

  // ── Rifiuto pairing (contatto) ────────────────────────────────────────────────
  function askRejectPairing(entry: MyContactEntry) {
    Alert.alert(
      'Rifiutare questo pairing?',
      `Owner: ${entry.ownerPublicKey.slice(0, 22)}…\n\nLa tua entry verrà rimossa dalla lista contatti dell'owner.`,
      [
        { text: 'Annulla', style: 'cancel' },
        { text: 'Rifiuta', style: 'destructive', onPress: () => doRejectPairing(entry) },
      ],
    );
  }

  async function doRejectPairing(entry: MyContactEntry) {
    const identity = await loadIdentity();
    if (!identity) return;
    setBusy(true);
    try {
      const ts = Date.now();
      const contactPub = bytesToHex(identity.pub);
      const sig = signChallenge(identity.priv, `sentinella:reject-pairing:${entry.contactId}:${ts}`);
      await api.rejectPairing(entry.contactId, contactPub, ts, sig);
    } catch (e: any) {
      if (e?.status !== 404) {
        alert('Errore rifiuto pairing: ' + (e?.message ?? 'Errore sconosciuto'));
        setBusy(false);
        return;
      }
      // 404: già rimosso server-side, pulisci comunque il registro locale
    }
    await deleteMyContactId(entry.contactId);
    await loadMyPairings();
    setBusy(false);
  }

  // ── Camera overlay per rotazione chiave ──────────────────────────────────────
  if (scanForContact) {
    return (
      <Screen>
        <Text style={T.heading}>Scansiona il QR del contatto</Text>
        <Text style={T.dim}>
          Il contatto deve mostrare il QR «aggiorna chiave» dal suo telefono
          (schermata add-friend dopo un pairing duplicato).
        </Text>
        {!permission?.granted ? (
          <Button label="Richiedi accesso fotocamera" onPress={requestPermission} />
        ) : (
          <CameraView
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={(e) => handleKeyRotationScan(e.data)}
            style={{ height: 280, borderRadius: 12, overflow: 'hidden' }}
          />
        )}
        <Button label="Annulla" variant="ghost" onPress={() => setScanForContact(null)} />
      </Screen>
    );
  }

  // ── Render principale ─────────────────────────────────────────────────────────
  return (
    <Screen>
      <Text style={T.dim}>
        Aggiungi un contatto di persona: scansionate i QR a vicenda così la chiave è verificata
        faccia a faccia — nessuno può sostituirla di nascosto.
      </Text>
      <Button label="+ Aggiungi un amico (di persona)" onPress={() => router.push('/add-friend')} variant="safe" />

      {contacts.length === 0 ? (
        <Text style={[T.dim, { marginTop: space(4) }]}>Ancora nessun contatto fidato.</Text>
      ) : (
        contacts.map((c) => {
          const isVerified = verifiedKeys.has(c.public_key);
          const isDevContact = c.id?.startsWith('c_dev_');
          return (
            <Card key={c.id} tone={isVerified ? 'surface' : 'danger'}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space(3) }}>
                <View style={{
                  width: 40, height: 40, borderRadius: radius.pill,
                  backgroundColor: isVerified ? colors.safeSoft : colors.dangerSoft,
                  alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                  <Text style={{ color: isVerified ? colors.safe : colors.danger, fontWeight: '700' }}>
                    {c.to_hash.slice(0, 2).toUpperCase()}
                  </Text>
                </View>

                <View style={{ flex: 1, gap: space(1) }}>
                  <Text style={T.heading}>{isDevContact ? 'Contatto test [DEV]' : 'Contatto fidato'}</Text>
                  <Text style={{ ...T.mono, color: colors.inkFaint, fontSize: 12 }}>
                    {c.public_key.slice(0, 22)}…
                  </Text>
                  {c.push_token_preview && (
                    <Text style={{ fontSize: 11, color: colors.inkFaint }}>
                      push: {c.push_token_preview}
                    </Text>
                  )}
                  <Text style={{ fontSize: 11, color: colors.inkFaint }}>
                    {new Date(c.created_at).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' })}
                  </Text>
                  {isVerified ? (
                    <Text style={{ fontSize: 12, color: colors.safe, fontWeight: '600' }}>
                      ✓ chiave verificata di persona
                    </Text>
                  ) : (
                    <Text style={{ fontSize: 12, color: colors.danger, fontWeight: '600' }}>
                      ⚠ chiave NON verificata di persona
                    </Text>
                  )}
                </View>
              </View>

              <View style={{ flexDirection: 'row', gap: space(2), justifyContent: 'flex-end' }}>
                <Button
                  label="Aggiorna chiave"
                  variant="ghost"
                  onPress={() => startKeyRotation(c.id)}
                  disabled={busy}
                />
                <Button
                  label="Rimuovi"
                  variant="danger"
                  onPress={() => askRemoveContact(c)}
                  disabled={busy}
                />
              </View>
            </Card>
          );
        })
      )}

      {/* ── Sezione: sono contatto di... ─────────────────────────────────────── */}
      {myPairings.length > 0 && (
        <>
          <Text style={[T.label, { marginTop: space(4) }]}>SONO CONTATTO DI</Text>
          {myPairings.map((entry) => (
            <Card key={entry.contactId} tone="surface">
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(3) }}>
                <View style={{ flex: 1, gap: space(1) }}>
                  <Text style={{ ...T.mono, color: colors.inkFaint, fontSize: 12 }}>
                    {entry.ownerPublicKey.slice(0, 22)}…
                  </Text>
                  <Text style={{ fontSize: 11, color: colors.inkFaint }}>
                    Pairing: {new Date(entry.pairedAt).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' })}
                  </Text>
                </View>
                <Button
                  label="Rifiuta"
                  variant="ghost"
                  onPress={() => askRejectPairing(entry)}
                  disabled={busy}
                />
              </View>
            </Card>
          ))}
        </>
      )}

      <Text style={[T.dim, { marginTop: space(4) }]}>
        Consiglio: per resistere alla coercizione, scegli una soglia bassa su molti contatti (es. 2 su 5).
      </Text>
    </Screen>
  );
}
