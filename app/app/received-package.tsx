import { useCallback, useState } from 'react';
import { Text, Image, View, Alert } from 'react-native';
import { useLocalSearchParams, useFocusEffect } from 'expo-router';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Screen, Card, Button, Pill, T } from '../components/ui';
import { space } from '../theme';
import { hexToBytes } from '../lib/crypto';
import { decryptAttachment } from '../lib/attachments';
import {
  getPackage, cacheAttachment, readCachedAttachment, type ReceivedPackage,
} from '../lib/vault';
import { isFacadeActive } from '../lib/facadeStore';

// Converte Uint8Array in base64 in chunk per evitare stack overflow su file grandi.
function uint8ToBase64(bytes: Uint8Array): string {
  let out = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(out);
}

const fmtSize = (size: number) =>
  size > 1024 * 1024 ? (size / 1024 / 1024).toFixed(1) + ' MB' : (size / 1024).toFixed(0) + ' KB';

const sanitizeName = (name: string) => name.replace(/[^\w.\- ]/g, '_') || 'file';

// Directory di appoggio per l'export: il file in chiaro esiste solo qui, per il
// tempo del share sheet. Viene svuotata prima di ogni nuovo export (non si
// cancella subito dopo shareAsync: su Android l'app ricevente potrebbe stare
// ancora leggendo il content URI).
const EXPORT_DIR = () => FileSystem.cacheDirectory + 'exports/';

async function clearExportDir(): Promise<void> {
  await FileSystem.deleteAsync(EXPORT_DIR(), { idempotent: true }).catch(() => {});
  await FileSystem.makeDirectoryAsync(EXPORT_DIR(), { intermediates: true });
}

// Dettaglio di un pacchetto ricevuto: legge SOLO dal vault locale cifrato.
// Il testo e gli allegati in cache si aprono offline; un allegato non ancora
// in cache viene scaricato dallo storage, decifrato con la DEK del pacchetto
// (conservata cifrata nel vault) e salvato cifrato per le prossime volte.
export default function ReceivedPackageScreen() {
  const { switchId } = useLocalSearchParams<{ switchId?: string }>();
  const [pkg, setPkg] = useState<ReceivedPackage | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);   // "item-att" in lavorazione
  const [err, setErr] = useState<string | null>(null);
  const [viewingImage, setViewingImage] = useState<{ uri: string; name: string } | null>(null);

  useFocusEffect(useCallback(() => {
    (async () => {
      if (!switchId || await isFacadeActive()) { setPkg(null); setLoading(false); return; }
      try {
        setPkg(await getPackage(switchId));
      } catch (e) {
        console.log('[received-package] lettura vault non riuscita', e);
        setPkg(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [switchId]));

  // Restituisce i byte in chiaro dell'allegato: dalla cache del vault se c'è,
  // altrimenti download + decifratura con la DEK e salvataggio cifrato in cache.
  async function attachmentBytes(itemIdx: number, attIdx: number): Promise<Uint8Array> {
    const att = pkg!.items[itemIdx].attachments[attIdx];
    if (att.cachedFile) return readCachedAttachment(att.cachedFile);
    const bytes = await decryptAttachment(att.meta, hexToBytes(pkg!.dekHex));
    const updated = await cacheAttachment(pkg!, itemIdx, attIdx, bytes);
    setPkg({ ...updated });
    return bytes;
  }

  // Export esplicito fuori da Sentinella: avviso obbligatorio, poi il file in
  // chiaro viene scritto in una dir di appoggio e consegnato al share sheet di
  // sistema (l'approccio più affidabile su Expo SDK 51, iOS e Android).
  // È l'UNICO punto dell'app in cui del plaintext tocca il disco, per scelta
  // volontaria dell'utente.
  function exportFile(name: string, mimeType: string, getBytes: () => Promise<Uint8Array>) {
    Alert.alert(
      'Esportare fuori da Sentinella?',
      'Il file uscirà dalla protezione di Sentinella. Sarà leggibile da altre app '
      + 'e da chiunque acceda a questo telefono. Vuoi continuare?',
      [
        { text: 'Annulla', style: 'cancel' },
        {
          text: 'Esporta', style: 'destructive',
          onPress: async () => {
            setBusy('export');
            setErr(null);
            try {
              if (!(await Sharing.isAvailableAsync())) {
                setErr('La condivisione di file non è disponibile su questo dispositivo.');
                return;
              }
              const bytes = await getBytes();
              await clearExportDir();
              const uri = EXPORT_DIR() + sanitizeName(name);
              await FileSystem.writeAsStringAsync(uri, uint8ToBase64(bytes), {
                encoding: FileSystem.EncodingType.Base64,
              });
              await Sharing.shareAsync(uri, { mimeType, dialogTitle: name });
            } catch (e: any) {
              setErr('Export non riuscito: ' + (e?.message ?? e));
            } finally {
              setBusy(null);
            }
          },
        },
      ],
    );
  }

  async function openAttachment(itemIdx: number, attIdx: number) {
    if (!pkg) return;
    const att = pkg.items[itemIdx].attachments[attIdx];
    const key = itemIdx + '-' + attIdx;
    setBusy(key);
    setErr(null);
    try {
      const bytes = await attachmentBytes(itemIdx, attIdx);
      if (att.meta.mimeType.startsWith('image/')) {
        setViewingImage({ uri: `data:${att.meta.mimeType};base64,${uint8ToBase64(bytes)}`, name: att.meta.name });
      } else {
        alert(`${att.meta.name} è salvato offline nel vault cifrato. Usa "Esporta" per aprirlo con un'altra app.`);
      }
    } catch (e: any) {
      setErr('Allegato non disponibile: ' + (e?.message ?? e)
        + (att.cachedFile ? '' : ' (il primo accesso richiede la connessione)'));
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return <Screen><Text style={T.dim}>Lettura del vault…</Text></Screen>;
  }
  if (!pkg) {
    return <Screen><Text style={T.dim}>Pacchetto non trovato su questo dispositivo.</Text></Screen>;
  }

  return (
    <Screen>
      <Card tone="safe">
        <Pill label="RILASCIATO" tone="danger" />
        <Text style={[T.heading, { marginTop: space(2) }]}>{pkg.ownerName}</Text>
        <Text style={T.dim}>Salvato il {new Date(pkg.savedAt).toLocaleString()}</Text>
      </Card>

      {err && <Text style={[T.dim, { color: '#C0492F' }]}>{err}</Text>}

      {pkg.items.map((item, idx) => (
        <Card key={idx}>
          {!!item.label && (
            <Text style={[T.label, { marginBottom: space(1) }]}>{item.label.toUpperCase()}</Text>
          )}
          <Text style={T.body}>{item.text}</Text>
          <Button
            label="Esporta messaggio (.txt)"
            onPress={() => exportFile(
              (item.label ? sanitizeName(item.label) : 'messaggio') + '.txt',
              'text/plain',
              async () => new TextEncoder().encode(item.text),
            )}
            variant="ghost"
            disabled={busy !== null}
          />
          {item.attachments.length > 0 && (
            <View style={{ marginTop: space(3), gap: space(2) }}>
              <Text style={T.label}>ALLEGATI ({item.attachments.length})</Text>
              {item.attachments.map((att, i) => {
                const key = idx + '-' + i;
                return (
                  <View key={i} style={{ gap: space(1) }}>
                    <Text style={T.dim} numberOfLines={1}>
                      {att.meta.name} · {fmtSize(att.meta.size)}
                      {att.cachedFile ? ' · offline' : ''}
                    </Text>
                    <Button
                      label={
                        busy === key ? 'Decifrazione…'
                        : att.meta.mimeType.startsWith('image/') ? 'Visualizza'
                        : att.cachedFile ? 'Apri'
                        : 'Scarica e salva offline'
                      }
                      onPress={() => openAttachment(idx, i)}
                      variant="ghost"
                      disabled={busy !== null}
                    />
                    <Button
                      label="Esporta / Salva"
                      onPress={() => exportFile(
                        att.meta.name,
                        att.meta.mimeType,
                        () => attachmentBytes(idx, i),
                      )}
                      variant="ghost"
                      disabled={busy !== null}
                    />
                  </View>
                );
              })}
            </View>
          )}
        </Card>
      ))}

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
