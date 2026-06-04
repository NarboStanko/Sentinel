import { createHash } from 'node:crypto';
import { db } from '../db.js';
import { canonicalJson } from '../lib/canonical.js';

const GENESIS = '0'.repeat(64);

export interface AuditChainEvent {
  id:             number;
  chain_owner_id: string;
  chain_index:    number;
  event_type:     string;
  actor_id:       string | null;
  payload:        Record<string, unknown>;
  timestamp_ms:   number;
  signature:      string | null;
  prev_hash:      string;
  hash:           string;
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
  return createHash('sha256').update(raw).digest('hex');
}

const insertEvent = db.prepare(`
  INSERT INTO audit_chain
    (chain_owner_id, chain_index, event_type, actor_id, payload, timestamp_ms, signature, prev_hash, hash)
  VALUES
    (@chain_owner_id, @chain_index, @event_type, @actor_id, @payload, @timestamp_ms, @signature, @prev_hash, @hash)
`);

const getLastEvent = db.prepare(
  'SELECT chain_index, hash FROM audit_chain WHERE chain_owner_id=? ORDER BY chain_index DESC LIMIT 1'
);

export function appendToChain(opts: {
  chain_owner_id: string;
  event_type:     string;
  actor_id?:      string | null;
  payload?:       Record<string, unknown>;
  signature?:     string | null;
  timestamp_ms?:  number;
}): void {
  const doInsert = db.transaction(() => {
    const last        = getLastEvent.get(opts.chain_owner_id) as { chain_index: number; hash: string } | undefined;
    const prev_hash   = last?.hash ?? GENESIS;
    const chain_index = (last?.chain_index ?? -1) + 1;
    const timestamp_ms = opts.timestamp_ms ?? Date.now();
    const payload      = opts.payload ?? {};
    const actor_id     = opts.actor_id ?? null;
    const signature    = opts.signature ?? null;

    const hash = computeEventHash({
      chain_owner_id: opts.chain_owner_id,
      chain_index,
      event_type:     opts.event_type,
      actor_id,
      payload,
      timestamp_ms,
      signature,
      prev_hash,
    });

    insertEvent.run({
      chain_owner_id: opts.chain_owner_id,
      chain_index,
      event_type:     opts.event_type,
      actor_id,
      payload:        JSON.stringify(payload),
      timestamp_ms,
      signature,
      prev_hash,
      hash,
    });
  });
  doInsert();
}
