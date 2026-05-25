import { useState, useCallback } from 'react';
import { View, Text } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Screen, Card, Button, T } from '../components/ui';
import { colors, space, radius } from '../theme';
import { api } from '../lib/api';
import { loadOwnerId, loadVerifiedContactKeys } from '../lib/keystore';

export default function Contacts() {
  const [contacts, setContacts]       = useState<any[]>([]);
  const [verifiedKeys, setVerifiedKeys] = useState<Set<string>>(new Set());

  useFocusEffect(useCallback(() => {
    (async () => {
      const ownerId = await loadOwnerId();
      if (!ownerId) return;
      const [{ contacts: cs }, vk] = await Promise.all([
        api.contacts(ownerId),
        loadVerifiedContactKeys(),
      ]);
      setContacts(cs);
      setVerifiedKeys(vk);
    })();
  }, []));

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
          return (
            <Card key={c.id}
              tone={isVerified ? 'surface' : 'danger'}
              style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space(3) }}>
              {/* avatar */}
              <View style={{ width: 40, height: 40, borderRadius: radius.pill,
                backgroundColor: isVerified ? colors.safeSoft : colors.dangerSoft,
                alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Text style={{ color: isVerified ? colors.safe : colors.danger, fontWeight: '700' }}>
                  {c.to_hash.slice(0, 2).toUpperCase()}
                </Text>
              </View>

              <View style={{ flex: 1, gap: space(1) }}>
                <Text style={T.heading}>Contatto fidato</Text>
                <Text style={{ ...T.mono, color: colors.inkFaint, fontSize: 12 }}>
                  {c.public_key.slice(0, 22)}…
                </Text>

                {isVerified ? (
                  <Text style={{ fontSize: 12, color: colors.safe, fontWeight: '600' }}>
                    ✓ chiave verificata di persona
                  </Text>
                ) : (
                  <Text style={{ fontSize: 12, color: colors.danger, fontWeight: '600' }}>
                    ⚠ chiave NON verificata di persona — possibile manomissione del canale.
                    Ripeti il pairing.
                  </Text>
                )}
              </View>
            </Card>
          );
        })
      )}

      <Text style={[T.dim, { marginTop: space(4) }]}>
        Consiglio: per resistere alla coercizione, scegli una soglia bassa su molti contatti (es. 2 su 5).
      </Text>
    </Screen>
  );
}
