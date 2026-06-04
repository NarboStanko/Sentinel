// Client-side audit chain helper.
// Verifica locale dell'integrità della catena di hash; fetch degli endpoint del server.
// Nessuna dipendenza da Node.js — usa @noble/hashes per SHA-256 (compatibile RN).

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { canonicalize } from './canonicalize';
import { signChallenge } from './crypto';
import type { Identity } from './crypto';

const BASE =
  (typeof (globalThis as any).__EXPO_SERVER_URL__ === 'string'
    ? (globalThis as any).__EXPO_SERVER_URL__
    : 'http://localhost:4000');

const GENESIS = '0'.repeat(64);

// Tipo dati degli eventi come restituiti dal server
export interface AuditEvent {
  chain_index:  number;
  event_type:   string;
  actor_id:     string | null;
  payload:      Record<string, unknown>;
  timestamp_ms: number;
  signature:    string | null;
  prev_hash:    string;
  hash:         string;
}

export interface AuditAnchor {
  ownerId:      string;
  chainIndex:   number;
  hash:         string;
  timestamp_ms: number | null;
}

// Recomputa l'hash di un singolo evento (identico al server).
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = sortDeep((value as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return value;
}

function canonicalJson(obj: Record<string, unknown>): string {
  return JSON.stringify(sortDeep(obj));
}

export function computeEventHash(fields: {
  chain_owner_id: string;
  chain_index:    number;
  event_type:     string;
  actor_id:       string | null;
  payload:        Record<string, unknown>;
  timestamp_ms:   number;
  signature:      string | null;
  prev_hash:      string;
}): string {
  const raw = [
    fields.chain_owner_id,
    String(fields.chain_index),
    fields.event_type,
    fields.actor_id ?? '',
    canonicalJson(fields.payload),
    String(fields.timestamp_ms),
    fields.signature ?? '',
    fields.prev_hash,
  ].join('|');
  return bytesToHex(sha256(new TextEncoder().encode(raw)));
}

// Verifica la catena localmente. Ritorna { ok, firstBadIndex }.
export function verifyChain(
  ownerId: string,
  events: AuditEvent[],
): { ok: boolean; firstBadIndex: number } {
  let expectedPrev = GENESIS;
  for (const ev of events) {
    const recomputed = computeEventHash({
      chain_owner_id: ownerId,
      chain_index:    ev.chain_index,
      event_type:     ev.event_type,
      actor_id:       ev.actor_id,
      payload:        ev.payload,
      timestamp_ms:   ev.timestamp_ms,
      signature:      ev.signature,
      prev_hash:      ev.prev_hash,
    });
    if (recomputed !== ev.hash || ev.prev_hash !== expectedPrev) {
      return { ok: false, firstBadIndex: ev.chain_index };
    }
    expectedPrev = ev.hash;
  }
  return { ok: true, firstBadIndex: -1 };
}

// Verifica che l'evento all'indice savedAnchor.chainIndex abbia ancora l'hash atteso.
// Se la verifica fallisce, il server ha manomesso o eliminato eventi.
export function verifyFromAnchor(
  savedAnchor: { chainIndex: number; hash: string },
  events: AuditEvent[],
): { ok: boolean } {
  if (savedAnchor.chainIndex < 0) return { ok: true }; // catena vuota al momento del salvataggio
  const anchorEvent = events.find(e => e.chain_index === savedAnchor.chainIndex);
  if (!anchorEvent) return { ok: false }; // evento eliminato
  return { ok: anchorEvent.hash === savedAnchor.hash };
}

// Costruisce la firma per query-param auth (stessa logica di /pending)
function makeQuerySig(urlPath: string, id: Identity): { pub: string; ts: number; sig: string } {
  const pub = bytesToHex(id.pub);
  const ts = Date.now();
  const sig = signChallenge(id.priv, canonicalize('GET', urlPath, ts, pub, {}));
  return { pub, ts, sig };
}

// Fetch dell'ultimo evento (ancoraggio) per un owner
export async function fetchAnchor(ownerId: string, id: Identity): Promise<AuditAnchor> {
  const { pub, ts, sig } = makeQuerySig('/audit/anchor', id);
  const url = `${BASE}/audit/anchor?ownerId=${encodeURIComponent(ownerId)}&pub=${encodeURIComponent(pub)}&ts=${ts}&sig=${encodeURIComponent(sig)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetchAnchor failed: ${res.status}`);
  return res.json() as Promise<AuditAnchor>;
}

// Fetch di un range di eventi
export async function fetchEvents(
  ownerId: string,
  fromIndex: number,
  toIndex: number,
  id: Identity,
): Promise<AuditEvent[]> {
  const { pub, ts, sig } = makeQuerySig('/audit/events', id);
  const url = `${BASE}/audit/events?ownerId=${encodeURIComponent(ownerId)}&fromIndex=${fromIndex}&toIndex=${toIndex}&pub=${encodeURIComponent(pub)}&ts=${ts}&sig=${encodeURIComponent(sig)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetchEvents failed: ${res.status}`);
  const body = await res.json() as { events: AuditEvent[] };
  return body.events;
}

// Registra ANCHOR_SAVED o VERIFICATION_FAILED nella catena server-side
export async function postAnchorEvent(
  eventType: 'ANCHOR_SAVED' | 'VERIFICATION_FAILED' | 'RECOVERY_CONFIRMED_AFTER_VERIFICATION_FAIL',
  metadata: Record<string, unknown>,
  id: Identity,
): Promise<void> {
  const pub = bytesToHex(id.pub);
  const ts = Date.now();
  const body = { eventType, metadata, pub, ts, sig: '' };
  body.sig = signChallenge(id.priv, canonicalize('POST', '/audit/anchor-event', ts, pub, body));
  const res = await fetch(`${BASE}/audit/anchor-event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`postAnchorEvent failed: ${res.status}`);
}
