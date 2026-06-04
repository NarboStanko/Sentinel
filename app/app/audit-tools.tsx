import { useState } from 'react';
import { View, Text, Alert, Pressable, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { Screen, Card, Button, T } from '../components/ui';
import { colors, space } from '../theme';
import * as SecureStore from 'expo-secure-store';
import { loadIdentity, loadOwnerId } from '../lib/keystore';
import {
  fetchAnchor,
  fetchEvents,
  verifyChain,
  verifyFromAnchor,
  postAnchorEvent,
  type AuditEvent,
  type AuditAnchor,
} from '../lib/auditChain';

const ANCHOR_KEY = (ownerId: string) => `sentinella.audit_anchor.${ownerId}`;

async function loadSavedAnchor(ownerId: string): Promise<{ chainIndex: number; hash: string; savedAt: number } | null> {
  const raw = await SecureStore.getItemAsync(ANCHOR_KEY(ownerId));
  return raw ? JSON.parse(raw) : null;
}

async function saveAnchor(ownerId: string, anchor: AuditAnchor): Promise<void> {
  await SecureStore.setItemAsync(ANCHOR_KEY(ownerId), JSON.stringify({
    chainIndex: anchor.chainIndex,
    hash:       anchor.hash,
    savedAt:    Date.now(),
  }));
}

function formatTs(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
}

export default function AuditTools() {
  const [loading, setLoading]       = useState(false);
  const [statusMsg, setStatusMsg]   = useState<string | null>(null);
  const [statusOk, setStatusOk]     = useState<boolean | null>(null);
  const [savedAnchor, setSavedAnchor] = useState<{ chainIndex: number; hash: string; savedAt: number } | null>(null);
  const [events, setEvents]         = useState<AuditEvent[]>([]);
  const [showEvents, setShowEvents] = useState(false);
  const [lastFailureParams, setLastFailureParams] = useState<{ firstBadIndex: number; chainIndexAnchor: number; reason: string } | null>(null);

  // ── Sezione 1: Salva ancoraggio ────────────────────────────────────────────

  async function handleSaveAnchor() {
    setLoading(true);
    setStatusMsg(null);
    try {
      const [id, ownerId] = await Promise.all([loadIdentity(), loadOwnerId()]);
      if (!id || !ownerId) { Alert.alert('Errore', 'Identità non disponibile.'); return; }

      const anchor = await fetchAnchor(ownerId, id);
      await saveAnchor(ownerId, anchor);
      setSavedAnchor({ chainIndex: anchor.chainIndex, hash: anchor.hash, savedAt: Date.now() });

      await postAnchorEvent('ANCHOR_SAVED', { chainIndex: anchor.chainIndex }, id).catch(() => {});
      setStatusMsg(`Ancoraggio salvato — indice ${anchor.chainIndex}`);
      setStatusOk(true);
    } catch (e: any) {
      Alert.alert('Errore', e?.message ?? 'Impossibile salvare l\'ancoraggio.');
    } finally {
      setLoading(false);
    }
  }

  // ── Sezione 2: Verifica integrità ──────────────────────────────────────────

  async function handleVerify() {
    setLoading(true);
    setStatusMsg(null);
    try {
      const [id, ownerId] = await Promise.all([loadIdentity(), loadOwnerId()]);
      if (!id || !ownerId) { Alert.alert('Errore', 'Identità non disponibile.'); return; }

      const saved = await loadSavedAnchor(ownerId);
      if (!saved) {
        Alert.alert('Nessun ancoraggio', 'Salva prima un ancoraggio per poter verificare le modifiche successive.');
        return;
      }
      setSavedAnchor(saved);

      // Scarica tutti gli eventi dall'indice 0 fino all'ultimo
      const anchor = await fetchAnchor(ownerId, id);
      const allEvents = anchor.chainIndex >= 0
        ? await fetchEvents(ownerId, 0, anchor.chainIndex, id)
        : [];

      // 1) verifica catena hash completa
      const chainResult = verifyChain(ownerId, allEvents);
      // 2) verifica ancoraggio salvato
      const anchorResult = verifyFromAnchor(saved, allEvents);

      if (chainResult.ok && anchorResult.ok) {
        setStatusMsg(`Integrità verificata — ${allEvents.length} eventi, catena integra`);
        setStatusOk(true);
      } else {
        const reason = !chainResult.ok
          ? `catena corrotta all'indice ${chainResult.firstBadIndex}`
          : 'ancoraggio non corrisponde (eventi modificati o eliminati)';
        setStatusMsg(`Ultima verifica: fallita`);
        setStatusOk(false);

        const failureParams = {
          firstBadIndex:    chainResult.firstBadIndex,
          chainIndexAnchor: saved.chainIndex,
          reason,
        };
        setLastFailureParams(failureParams);

        await postAnchorEvent('VERIFICATION_FAILED', {
          chainIndex:    anchor.chainIndex,
          firstBadIndex: chainResult.firstBadIndex,
        }, id).catch(() => {});

        router.push({ pathname: '/verify-failed', params: failureParams });
      }
    } catch (e: any) {
      Alert.alert('Errore', e?.message ?? 'Verifica non riuscita.');
    } finally {
      setLoading(false);
    }
  }

  // ── Sezione 3: Cronologia firmata ──────────────────────────────────────────

  async function handleLoadHistory() {
    setLoading(true);
    try {
      const [id, ownerId] = await Promise.all([loadIdentity(), loadOwnerId()]);
      if (!id || !ownerId) { Alert.alert('Errore', 'Identità non disponibile.'); return; }

      const anchor = await fetchAnchor(ownerId, id);
      if (anchor.chainIndex < 0) { setEvents([]); setShowEvents(true); return; }
      const loaded = await fetchEvents(ownerId, Math.max(0, anchor.chainIndex - 49), anchor.chainIndex, id);
      setEvents(loaded.reverse()); // più recenti in cima
      setShowEvents(true);
    } catch (e: any) {
      Alert.alert('Errore', e?.message ?? 'Impossibile caricare la cronologia.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Screen>
      <Text style={[T.heading, { marginBottom: space(2) }]}>Strumenti di verifica</Text>
      <Text style={[T.body, { color: colors.inkDim, marginBottom: space(4) }]}>
        Salva un ancoraggio crittografico e verifica che il server non abbia alterato il registro degli eventi.
      </Text>

      {/* ── Ancoraggio ──────────────────────────────────────────────────────── */}
      <Card>
        <Text style={T.label}>Ancoraggio locale</Text>
        {savedAnchor ? (
          <View style={{ gap: space(1) }}>
            <Text style={T.body}>Indice: {savedAnchor.chainIndex}</Text>
            <Text style={[T.mono, { fontSize: 11, color: colors.inkDim }]}>{savedAnchor.hash.slice(0, 24)}…</Text>
            <Text style={[T.body, { color: colors.inkDim }]}>Salvato: {formatTs(savedAnchor.savedAt)}</Text>
          </View>
        ) : (
          <Text style={[T.body, { color: colors.inkDim }]}>Nessun ancoraggio salvato</Text>
        )}
        <Button label="Salva ancoraggio ora" onPress={handleSaveAnchor} disabled={loading} />
      </Card>

      {/* ── Verifica ────────────────────────────────────────────────────────── */}
      <Card tone={statusOk === false ? 'danger' : statusOk === true ? 'safe' : 'surface'}>
        <Text style={T.label}>Verifica integrità</Text>
        <Text style={[T.body, { color: colors.inkDim }]}>
          Confronta il registro server con l'ancoraggio salvato. Se non corrispondono, il server potrebbe essere stato compromesso.
        </Text>
        {statusMsg && (
          <View style={{ gap: space(1) }}>
            <Text style={[T.body, { color: statusOk ? colors.safe : colors.danger, fontWeight: '600' }]}>
              {statusMsg}
            </Text>
            {statusOk === false && lastFailureParams && (
              <Pressable onPress={() => router.push({ pathname: '/verify-failed', params: lastFailureParams })}>
                <Text style={[T.dim, { color: colors.accent }]}>Vedi dettagli →</Text>
              </Pressable>
            )}
          </View>
        )}
        <Button label="Verifica ora" onPress={handleVerify} disabled={loading} variant={statusOk === false ? 'danger' : 'primary'} />
      </Card>

      {/* ── Cronologia ──────────────────────────────────────────────────────── */}
      <Card>
        <Text style={T.label}>Cronologia firmata</Text>
        <Text style={[T.body, { color: colors.inkDim }]}>Ultimi 50 eventi registrati nella catena.</Text>
        <Button label={showEvents ? 'Aggiorna' : 'Carica cronologia'} onPress={handleLoadHistory} disabled={loading} variant="ghost" />
        {showEvents && events.length === 0 && (
          <Text style={[T.body, { color: colors.inkDim }]}>Nessun evento registrato.</Text>
        )}
        {showEvents && events.map((ev) => (
          <View key={ev.chain_index} style={{ borderTopWidth: 1, borderTopColor: colors.line, paddingTop: space(3), gap: space(1) }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={[T.body, { fontWeight: '700', flex: 1 }]}>{ev.event_type}</Text>
              <Text style={[T.body, { color: colors.inkDim }]}>#{ev.chain_index}</Text>
            </View>
            <Text style={[T.body, { color: colors.inkDim }]}>{formatTs(ev.timestamp_ms)}</Text>
            {ev.actor_id && <Text style={[T.body, { color: colors.inkDim }]}>Actor: {ev.actor_id.slice(0, 16)}…</Text>}
            <Text style={[T.mono, { fontSize: 10, color: colors.inkDim }]}>{ev.hash.slice(0, 20)}…</Text>
          </View>
        ))}
      </Card>

      {loading && <ActivityIndicator style={{ marginTop: space(4) }} color={colors.ink} />}
    </Screen>
  );
}
