// INVARIANTE DI SICUREZZA: il social recovery può SOLO ruotare la chiave pubblica.
// NON disarma, NON rilascia contenuto, NON modifica le quote Shamir né la DEK.
// Lo switch continua a girare; i contatti mantengono le proprie quote intatte.
// Qualsiasi modifica a questo flusso deve preservare questa invariante.

import { useState } from 'react';
import { View, Text, TextInput, Pressable } from 'react-native';
import { Screen, Card, Button, T } from '../components/ui';
import { colors, space } from '../theme';
import { identityFromSeed, bytesToHex, signChallenge } from '../lib/crypto';
import { loadSeed, loadOwnerId, loadIdentity } from '../lib/keystore';
import { api } from '../lib/api';

type Section = 'initiate' | 'approve' | 'cancel';

function formatTimeLeft(unlockAt: number): string {
  const ms = unlockAt - Date.now();
  if (ms <= 0) return 'scaduto';
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (days > 0) return `${days}g ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes} minuti`;
}

// ── Sezione 1: Avvia recovery (nuova identità sull'attuale device) ──────────
function InitiateSection() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ recoveryId: string; unlockAt: number } | null>(null);
  const [finalizeResult, setFinalizeResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleInitiate() {
    setError(null);
    setBusy(true);
    try {
      const [seed, ownerId] = await Promise.all([loadSeed(), loadOwnerId()]);
      if (!seed || !ownerId) { setError('Nessun account trovato su questo dispositivo.'); return; }
      const identity = identityFromSeed(seed);
      const newPubHex = bytesToHex(identity.pub);
      const res = await api.recoveryInitiate(ownerId, newPubHex);
      if (!res.ok || !res.recoveryId || !res.unlockAt) {
        setError(res.reason ?? 'Impossibile avviare il recovery.');
        return;
      }
      setResult({ recoveryId: res.recoveryId, unlockAt: res.unlockAt });
    } catch (e: any) {
      setError(e?.message ?? 'Errore di rete.');
    } finally {
      setBusy(false);
    }
  }

  async function handleFinalize() {
    if (!result) return;
    setBusy(true);
    setFinalizeResult(null);
    try {
      const res = await api.recoveryFinalize(result.recoveryId);
      if (res.ok) {
        setFinalizeResult('Rotazione completata. La tua nuova chiave è ora attiva.');
      } else {
        setFinalizeResult(res.reason ?? 'Impossibile finalizzare: controlla il numero di approvazioni e il ritardo.');
      }
    } catch (e: any) {
      setFinalizeResult(e?.message ?? 'Errore di rete.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <Text style={T.heading}>Avvia recovery (nuova identità)</Text>
      <Text style={T.dim}>
        Usa questa sezione se hai perso il telefono e hai accesso alla seed phrase su un nuovo
        dispositivo. Richiede l'approvazione di un quorum di contatti fidati e un ritardo obbligatorio
        di 7 giorni.
      </Text>

      {!result ? (
        <>
          {error && (
            <View style={{ backgroundColor: colors.dangerSoft, borderRadius: 8, padding: space(3) }}>
              <Text style={[T.dim, { color: colors.danger }]}>{error}</Text>
            </View>
          )}
          <Button
            label={busy ? 'Avvio in corso…' : 'Avvia richiesta di rotazione'}
            onPress={handleInitiate}
            disabled={busy}
          />
        </>
      ) : (
        <View style={{ gap: space(3) }}>
          <View style={{ backgroundColor: colors.safeSoft, borderRadius: 8, padding: space(3) }}>
            <Text style={[T.label, { marginBottom: space(1) }]}>RECOVERY ID</Text>
            <Text style={[T.mono, { fontSize: 13 }]}>{result.recoveryId}</Text>
            <Text style={[T.dim, { marginTop: space(2) }]}>
              Condividi questo codice con i tuoi contatti fidati. Potranno approvare la
              rotazione dall'app nella sezione «Approva recovery».
            </Text>
          </View>
          <Text style={T.dim}>
            Sblocco disponibile tra: <Text style={{ fontWeight: '600', color: colors.heartbeat }}>{formatTimeLeft(result.unlockAt)}</Text>
          </Text>
          {finalizeResult && (
            <View style={{ backgroundColor: colors.safeSoft, borderRadius: 8, padding: space(3) }}>
              <Text style={[T.dim, { color: colors.safe }]}>{finalizeResult}</Text>
            </View>
          )}
          <Button
            label={busy ? 'Attendi…' : 'Finalizza (dopo il ritardo)'}
            onPress={handleFinalize}
            disabled={busy}
            variant="safe"
          />
        </View>
      )}
    </Card>
  );
}

// ── Sezione 2: Approva recovery (come contatto) ─────────────────────────────
function ApproveSection() {
  const [busy, setBusy] = useState(false);
  const [recoveries, setRecoveries] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, string>>({});

  async function loadPending() {
    setError(null);
    setBusy(true);
    try {
      const identity = await loadIdentity();
      if (!identity) { setError('Nessun account trovato su questo dispositivo.'); return; }
      const pubHex = bytesToHex(identity.pub);
      const ts = Date.now();
      const challenge = 'sentinella:recovery-pending:' + pubHex + ':' + ts;
      const sig = signChallenge(identity.priv, challenge);
      const res = await api.recoveryPendingForContact(pubHex, ts, sig);
      setRecoveries(res.recoveries ?? []);
    } catch (e: any) {
      setError(e?.message ?? 'Errore di rete.');
    } finally {
      setBusy(false);
    }
  }

  async function handleApprove(recoveryId: string) {
    setBusy(true);
    try {
      const res = await api.recoveryApprove(recoveryId);
      setResults((r) => ({
        ...r,
        [recoveryId]: res.ok
          ? `Approvato. Approvazioni totali: ${res.approvals}`
          : (res.reason ?? 'Errore'),
      }));
      // Aggiorna la lista
      setRecoveries((prev) =>
        prev?.map((r) =>
          r.recoveryId === recoveryId ? { ...r, alreadyApproved: true, approvalCount: (r.approvalCount ?? 0) + 1 } : r
        ) ?? null
      );
    } catch (e: any) {
      setResults((r) => ({ ...r, [recoveryId]: e?.message ?? 'Errore di rete.' }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <Text style={T.heading}>Approva recovery (come contatto)</Text>
      <Text style={T.dim}>
        Se un tuo contatto fidato ti ha inviato un recovery ID, carica le richieste pendenti
        e approva firmando con la tua identità.
      </Text>

      {error && (
        <View style={{ backgroundColor: colors.dangerSoft, borderRadius: 8, padding: space(3) }}>
          <Text style={[T.dim, { color: colors.danger }]}>{error}</Text>
        </View>
      )}

      <Button
        label={busy ? 'Caricamento…' : 'Carica richieste pendenti'}
        onPress={loadPending}
        disabled={busy}
        variant="ghost"
      />

      {recoveries !== null && recoveries.length === 0 && (
        <Text style={T.dim}>Nessuna richiesta di recovery pendente per il tuo account.</Text>
      )}

      {recoveries?.map((rec) => (
        <View
          key={rec.recoveryId}
          style={{ backgroundColor: colors.surfaceAlt, borderRadius: 8, padding: space(3), gap: space(2) }}
        >
          <Text style={T.heading}>{rec.ownerName}</Text>
          <Text style={[T.mono, { fontSize: 12 }]}>{rec.recoveryId}</Text>
          <Text style={T.dim}>
            Sblocco tra: <Text style={{ fontWeight: '600' }}>{formatTimeLeft(rec.unlockAt)}</Text>
            {'  '}Approvazioni: <Text style={{ fontWeight: '600' }}>{rec.approvalCount}</Text>
          </Text>
          {results[rec.recoveryId] && (
            <Text style={[T.dim, { color: colors.safe }]}>{results[rec.recoveryId]}</Text>
          )}
          {!rec.alreadyApproved ? (
            <Button
              label={busy ? 'Firma in corso…' : 'Approva'}
              onPress={() => handleApprove(rec.recoveryId)}
              disabled={busy}
              variant="safe"
            />
          ) : (
            <Text style={[T.dim, { color: colors.safe, fontWeight: '600' }]}>
              Già approvato da te.
            </Text>
          )}
        </View>
      ))}
    </Card>
  );
}

// ── Sezione 3: Cancella recovery sospetta (identità attuale) ────────────────
function CancelSection() {
  const [recoveryId, setRecoveryId] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleCancel() {
    setError(null);
    setResult(null);
    const trimmed = recoveryId.trim();
    if (!trimmed) { setError('Inserisci il recovery ID.'); return; }
    setBusy(true);
    try {
      const identity = await loadIdentity();
      if (!identity) { setError('Nessun account trovato su questo dispositivo.'); return; }
      // Firma il recoveryId con la chiave ATTUALE — il server verifica contro la chiave in DB
      const sig = signChallenge(identity.priv, trimmed);
      const res = await api.recoveryCancel(trimmed, sig);
      if (res.ok) {
        setResult('Recovery annullato con successo.');
        setRecoveryId('');
      } else {
        setError(res.reason ?? 'Impossibile annullare.');
      }
    } catch (e: any) {
      setError(e?.message ?? 'Errore di rete.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card tone="danger">
      <Text style={T.heading}>Cancella recovery sospetta</Text>
      <Text style={T.dim}>
        Se noti una richiesta di rotazione che non hai avviato tu, annullala con la tua
        identità attuale. Funziona finché possiedi ancora la chiave privata originale.
      </Text>
      <TextInput
        value={recoveryId}
        onChangeText={setRecoveryId}
        placeholder="rec_xxxxxxxxxxxx"
        autoCapitalize="none"
        autoCorrect={false}
        style={{
          borderWidth: 1,
          borderColor: colors.line,
          borderRadius: 8,
          padding: space(3),
          fontSize: 14,
          color: colors.ink,
          fontFamily: 'Courier',
        }}
      />
      {error && (
        <Text style={[T.dim, { color: colors.danger }]}>{error}</Text>
      )}
      {result && (
        <Text style={[T.dim, { color: colors.safe, fontWeight: '600' }]}>{result}</Text>
      )}
      <Button
        label={busy ? 'Attendi…' : 'Cancella recovery'}
        onPress={handleCancel}
        disabled={busy || recoveryId.trim().length === 0}
        variant="danger"
      />
    </Card>
  );
}

// ── Schermata principale ─────────────────────────────────────────────────────
export default function SocialRecovery() {
  const [expanded, setExpanded] = useState<Section | null>(null);

  function toggle(s: Section) {
    setExpanded((prev) => (prev === s ? null : s));
  }

  return (
    <Screen>
      <Text style={T.display}>Recovery identità</Text>

      {/* Banner invariante di sicurezza */}
      <View style={{ backgroundColor: colors.safeSoft, borderRadius: 8, padding: space(4) }}>
        <Text style={[T.label, { color: colors.safe, marginBottom: space(1) }]}>
          SOLO ROTAZIONE CHIAVE
        </Text>
        <Text style={[T.dim, { color: colors.safe }]}>
          Questo processo non accede né rilascia il contenuto del pacchetto. Ruota soltanto
          la chiave pubblica del proprietario sotto quorum di contatti fidati + ritardo di 7 giorni.
          Lo switch resta armato e le quote dei contatti rimangono intatte.
        </Text>
      </View>

      {/* Sezione 1 */}
      <Pressable
        onPress={() => toggle('initiate')}
        style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: space(2) }}
      >
        <Text style={T.heading}>Avvia recovery (nuova identità)</Text>
        <Text style={{ color: colors.inkDim, fontSize: 18 }}>{expanded === 'initiate' ? '▲' : '▼'}</Text>
      </Pressable>
      {expanded === 'initiate' && <InitiateSection />}

      {/* Sezione 2 */}
      <Pressable
        onPress={() => toggle('approve')}
        style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: space(2) }}
      >
        <Text style={T.heading}>Approva recovery (come contatto)</Text>
        <Text style={{ color: colors.inkDim, fontSize: 18 }}>{expanded === 'approve' ? '▲' : '▼'}</Text>
      </Pressable>
      {expanded === 'approve' && <ApproveSection />}

      {/* Sezione 3 */}
      <Pressable
        onPress={() => toggle('cancel')}
        style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: space(2) }}
      >
        <Text style={T.heading}>Cancella recovery sospetta</Text>
        <Text style={{ color: colors.inkDim, fontSize: 18 }}>{expanded === 'cancel' ? '▲' : '▼'}</Text>
      </Pressable>
      {expanded === 'cancel' && <CancelSection />}
    </Screen>
  );
}
