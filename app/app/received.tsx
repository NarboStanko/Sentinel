import { useCallback, useState } from 'react';
import { Text, View, Alert } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Screen, Card, Button, Pill, T } from '../components/ui';
import { space } from '../theme';
import { listPackages, deletePackage, type ReceivedPackage } from '../lib/vault';
import { isFacadeActive } from '../lib/facadeStore';

// Elenco dei pacchetti rilasciati e salvati nel vault locale cifrato.
// Funziona offline e dopo riavvio: legge solo dal disco (cifrato a riposo),
// nessuna chiamata al server. Protetta dal lock globale come tutte le schermate.
export default function Received() {
  const [packages, setPackages] = useState<ReceivedPackage[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    (async () => {
      // Modalità facciata (duress): il vault non deve rivelare nulla.
      if (await isFacadeActive()) { setPackages([]); setLoading(false); return; }
      try {
        setPackages(await listPackages());
      } catch (e) {
        console.log('[received] lettura vault non riuscita', e);
        setPackages([]);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useFocusEffect(load);

  function confirmDelete(pkg: ReceivedPackage) {
    Alert.alert(
      'Eliminare questo pacchetto?',
      `Il pacchetto di ${pkg.ownerName} verrà rimosso da questo dispositivo, `
      + 'inclusi gli allegati salvati offline. L\'operazione non è reversibile.',
      [
        { text: 'Annulla', style: 'cancel' },
        {
          text: 'Elimina', style: 'destructive',
          onPress: async () => {
            await deletePackage(pkg.switchId).catch(() => {});
            load();
          },
        },
      ],
    );
  }

  const fmtDate = (ts: number) => new Date(ts).toLocaleString();

  return (
    <Screen>
      {loading && <Text style={T.dim}>Lettura del vault…</Text>}
      {!loading && packages.length === 0 && (
        <Text style={T.dim}>
          Nessun pacchetto ricevuto. Quando contribuisci la tua quota al rilascio
          di una persona che ti ha scelto come contatto, la sua documentazione
          viene salvata qui, cifrata, e resta leggibile anche offline.
        </Text>
      )}
      {packages.map((pkg) => {
        const attCount = pkg.items.reduce((n, it) => n + it.attachments.length, 0);
        const labels = pkg.items.map((it) => it.label).filter(Boolean).join(' · ');
        return (
          <Card key={pkg.switchId}>
            <Pill label="RILASCIATO" tone="danger" />
            <Text style={[T.heading, { marginTop: space(2) }]}>{pkg.ownerName}</Text>
            <Text style={T.dim}>Salvato il {fmtDate(pkg.savedAt)}</Text>
            {!!labels && <Text style={T.dim} numberOfLines={1}>{labels}</Text>}
            <Text style={T.dim}>
              {pkg.items.length} {pkg.items.length === 1 ? 'contenuto' : 'contenuti'}
              {attCount > 0 ? ` · ${attCount} allegat${attCount === 1 ? 'o' : 'i'}` : ''}
            </Text>
            <View style={{ marginTop: space(2), gap: space(2) }}>
              <Button
                label="Apri"
                onPress={() => router.push({ pathname: '/received-package', params: { switchId: pkg.switchId } })}
              />
              <Button label="Elimina da questo dispositivo" onPress={() => confirmDelete(pkg)} variant="ghost" />
            </View>
          </Card>
        );
      })}
    </Screen>
  );
}
