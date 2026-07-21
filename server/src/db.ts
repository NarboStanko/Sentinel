// SQLite store. PRINCIPIO: nessun plaintext, nessuna DEK, nessun contenuto.
// Il server conserva solo: utenti, contatti (chiavi pubbliche + push token),
// switch + stato, puntatori al drive e QUOTE CIFRATE della chiave.
import Database from 'better-sqlite3';

export const db = new Database(process.env.DB_PATH ?? 'sentinella.db');
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  public_key TEXT NOT NULL,        -- chiave pubblica del proprietario (JWK/hex)
  push_token TEXT,
  recovery_k INTEGER DEFAULT 2,        -- quorum per il recovery sociale
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  token TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  owner_public_key TEXT NOT NULL,
  used INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Un contatto fidato di un owner. 'to_hash' offusca l'identità lato server.
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  public_key TEXT NOT NULL,         -- chiave pubblica del contatto
  push_token TEXT,
  to_hash TEXT NOT NULL,            -- hash opaco per i log (no nomi/ruoli sul server)
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS switches (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  state TEXT NOT NULL,              -- DISARMED|ACTIVE|GRACE|APPROVAL_PENDING|RELEASED
  interval_sec INTEGER NOT NULL,
  grace_sec INTEGER NOT NULL,
  last_checkin INTEGER,
  next_check_at INTEGER,
  armed_at INTEGER
);

-- Ogni riga è un contenuto cifrato del pacchetto (append-only durante ACTIVE).
-- Tutti i contenuti di uno switch condividono la stessa DEK (persistita sul client).
-- Il server conserva solo il puntatore opaco e l'IV; mai il ciphertext né la chiave.
-- label: etichetta non-sensibile scelta dall'utente (mostrata in lista, mai contenuto reale).
CREATE TABLE IF NOT EXISTS switch_contents (
  id TEXT PRIMARY KEY,
  switch_id TEXT NOT NULL,
  drive_pointer TEXT NOT NULL,
  content_iv TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

-- Quote Shamir CIFRATE e OPACHE. Nessun contact_id: il server non sa a chi
-- appartenga ciascuna quota. Tra le reali sono mescolate delle ESCHE (decoy)
-- indistinguibili, cosi' il server non conosce neppure N reale ne' k.
-- Il contatto trova la propria per trial decryption (prova ad aprirle tutte).
CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  switch_id TEXT NOT NULL,
  x INTEGER,                       -- legacy, sempre NULL all'arm: l'indice Shamir vive DENTRO il blob cifrato
  blob TEXT NOT NULL,              -- blob opaco (quota reale o esca, identici a vista)
  submitted_share TEXT             -- quota decifrata reinviata dal contatto al rilascio
);

-- RECOVERY SOCIALE (fail-safe): rotazione identita' sotto quorum + ritardo.
-- Non disarma, non rilascia: cambia solo la chiave pubblica del proprietario.
CREATE TABLE IF NOT EXISTS recoveries (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  new_public_key TEXT NOT NULL,
  unlock_at INTEGER NOT NULL,          -- finalizzabile solo dopo questo istante
  finalized INTEGER DEFAULT 0,
  cancelled INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS recovery_approvals (
  recovery_id TEXT NOT NULL,
  contact_public_key TEXT NOT NULL,    -- contatto che approva (firma verificata)
  created_at INTEGER NOT NULL,
  PRIMARY KEY (recovery_id, contact_public_key)
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  switch_id TEXT,
  event TEXT NOT NULL,
  at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_chain (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_owner_id TEXT    NOT NULL,
  chain_index    INTEGER NOT NULL,
  event_type     TEXT    NOT NULL,
  actor_id       TEXT,
  payload        TEXT    NOT NULL DEFAULT '{}',
  timestamp_ms   INTEGER NOT NULL,
  signature      TEXT,
  prev_hash      TEXT    NOT NULL,
  hash           TEXT    NOT NULL,
  UNIQUE(chain_owner_id, chain_index)
);
CREATE INDEX IF NOT EXISTS idx_audit_chain_owner ON audit_chain(chain_owner_id, chain_index);

-- Contatori per il rate limiting. Chiavi: ip:{ip}, submit:{switchId}:{ip},
-- cumul:{switchId}:{ip} (cumulativo lifetme), lockout:{switchId}:{ip},
-- lockout_window:{switchId}:{ip}.
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);
`);

// Migrazione idempotente: rimuove le colonne legacy da switches se ancora presenti
// (database creati prima dell'introduzione di switch_contents). Silenziosa su DB freschi.
try { db.exec('ALTER TABLE switches DROP COLUMN drive_pointer'); } catch {}
try { db.exec('ALTER TABLE switches DROP COLUMN content_iv');   } catch {}

export function audit(switchId: string | null, event: string) {
  db.prepare('INSERT INTO audit (switch_id, event, at) VALUES (?,?,?)')
    .run(switchId, event, Date.now());
}
