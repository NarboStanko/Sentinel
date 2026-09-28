# Sentinella — Guide for the external reviewer

> 🇬🇧 English · [🇮🇹 Italiano](REVIEWER_README.it.md)

> Orientation document for a security auditor receiving this repository
> without prior knowledge of the project. Written on 2026-07-21 by reading the actual code
> and configuration files; the commands listed have been executed and verified.

---

## 1. What the system is

Sentinella is an end-to-end encrypted civic *dead man's switch*. The **owner** prepares a
content package, encrypts it on their own device and "arms" it with a check-in interval.
A server (the **postman**) periodically sends an "all good?" push; if the owner
stops responding (arrest, disappearance), the server asks the **trusted contacts** —
paired in person via QR — to approve the release. The package key (DEK) is
split with Shamir k-of-N: only when at least k contacts send back their share can the
client recombine the key and confirm the release. The core guarantee:
**the server never knows contents, keys, the DEK, or the threshold k** — it stores only public
keys, opaque blobs (real shares mixed with decoys), pointers to external storage and
switch state. Countermeasures against coercion: duress PIN (facade of fake data or
silent release trigger) and a hash-linked audit chain to detect tampering.
Actors, adversaries and formal guarantees: see `docs/THREAT_MODEL.md`.

---

## 2. Repository structure

The repo is an npm workspaces monorepo (root `package.json`, **single lockfile**
`package-lock.json` at the root — there are no separate lockfiles for `app/` and `server/`).

| Path | Contents |
|---|---|
| `server/` | Node + TypeScript + Fastify + SQLite backend (`better-sqlite3`). Coordinates switches, pushes, shares, recovery. |
| `app/` | Expo mobile app (React Native, SDK 51, `expo-router`). All content cryptography lives here. |
| `web/` | `recovery-console.html` — browser-based recovery console (derives the key from the seed, signs requests). |
| `docs/` | Audit documentation (see §8). |
| `app/plugins/` | Expo config plugins (`withNetworkSecurityConfig.js`, see §7). |

### Files containing the security logic, in order of relevance

**App side (where the cryptography lives):**

1. `app/lib/crypto.ts` — cryptographic core: identity derivation from BIP39 seed,
   ECDH seal/open (XChaCha20-Poly1305), content encryption, Shamir split/combine,
   sealed shares + decoys (`makeDecoy`), trial decryption (`tryOpenShare`, `findMyShare`).
2. `app/lib/canonicalize.ts` — canonicalization of signed requests; must remain
   bit-identical to its server counterpart (critical invariant, see §6).
3. `app/lib/keystore.ts` — seed custody in `expo-secure-store`
   (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`).
4. `app/lib/pinHash.ts`, `app/lib/pinPolicy.ts`, `app/lib/lockout.ts`,
   `app/lib/lockState.ts`, `app/lib/facadeStore.ts` — normal and duress PIN, exponential
   lockout, unlock state, facade mode.
5. `app/lib/auditChain.ts` — client-side verification of the audit chain.
6. `app/lib/storage.ts`, `app/lib/storage/googleDrive.ts`, `app/lib/storage/devBlob.ts`,
   `app/lib/driveAuth.ts`, `app/lib/attachments.ts` — storage abstraction (blobs reach
   the providers **already encrypted**), Drive OAuth, attachment encryption.
7. `app/lib/api.ts` — HTTP client with request signing.

**Server side (where the state decisions live):**

1. `server/src/middleware/auth.ts` — per-request P-256 signature authentication:
   canonicalization, signature verification, anti-replay (nonce cache, 6 min TTL), actor
   resolution (`owner` / `contact` / `*-of-switch`).
2. `server/src/routes/approvals.ts` — heart of the release: `/approval/request`, `/shares`
   (opaque blobs, real + decoys), `/approval/submit`, `/release/confirm`. Here you can see
   that k stays client-side.
3. `server/src/services/auditChain.ts` + `server/src/routes/audit_chain.ts` — hash-linked
   audit chain (SHA-256, previous hash concatenated) and verification/anchoring.
4. `server/src/services/scheduler.ts` — the "heartbeat": `tick()` moves switches
   ACTIVE → GRACE → APPROVAL_PENDING and sends the pushes.
5. `server/src/routes/duress.ts` — `/duress/trigger`: moves switches to
   APPROVAL_PENDING (never to RELEASED), rate limit 3/day per owner.
6. `server/src/routes/recovery.ts` — social recovery (identity rotation under quorum +
   delay; never disarm nor release).
7. `server/src/routes/auth.ts` — `/auth/challenge` + `/auth/verify` (used by the web console).
8. `server/src/services/rateLimiter.ts` — rate limiting per cryptographic identity (+ IP as
   a second layer), lockout on suspicious submit patterns.
9. `server/src/lib/canonical.ts` — server counterpart of the canonicalization.
10. `server/src/middleware/validate.ts` — body schema validation.
11. `server/src/db.ts` — SQLite schema: what the server stores (and what it does not).
12. `server/src/routes/switch.ts`, `checkin.ts`, `pairing.ts`, `vault.ts`, `push.ts` —
    lifecycle, check-in, pairing, content pointers, push tokens.
13. `server/src/routes/devblob.ts`, `server/src/routes/debug.ts` — **development only**
    (guard `NODE_ENV !== 'production'`): placeholder storage and test routes.

---

## 3. Running the server

**Prerequisites:** Node.js (tested with **v22.22.3** on Windows 11; no OS-specific
dependency — `better-sqlite3` compiles a native module, so a working toolchain
or the prebuilt is needed). No external database: SQLite is embedded.

```bash
# dalla radice del repo (workspaces: installa server e app insieme)
npm install --legacy-peer-deps

cd server
npm run dev        # tsx watch src/index.ts — sviluppo con reload
# oppure:
npm run build && npm start   # tsc → node dist/index.js
```

- **Port:** `4000` by default, override with the `PORT` variable. Listens on `0.0.0.0`.
- **Database:** created/initialized automatically at startup (`CREATE TABLE IF NOT
  EXISTS` in `src/db.ts`). Path: `DB_PATH` variable, default `sentinella.db` in the
  current directory. Tests use `:memory:`.
- **Startup logs:** Fastify JSON logger on stdout; the last relevant line is
  `Sentinella server on :4000`. From that point the scheduler runs with a tick every 2 s.
- **Quick check:** `GET http://localhost:4000/health` →
  `{ ok: true, service: 'sentinella', ts: ... }`.

Notes: `trustProxy: true` is enabled (the client IP is read from `X-Forwarded-For` —
relevant for per-IP rate limiting if the server is not behind a trusted reverse proxy).
Security headers are set on every response; HSTS only over HTTPS.

---

## 4. Running the tests

There is no aggregate script: each suite has its own `npm run`. All run in plain Node
via `tsx`, with no emulator or device; the server suites use in-memory SQLite.
Indicative time: a few seconds per suite, **~1–2 minutes for the whole set**.

**Server** (from `server/`) — 11 suites, **262 tests, all verified passing** on 2026-07-21:

| Command | Tests | Covers |
|---|---|---|
| `npm run test:auth` | 31 | Signature on protected routes: 401 without signature, expired ts, tampering, replay, roles; client/server canonicalization equivalence |
| `npm run test:scheduler` | 33 | ACTIVE→GRACE→APPROVAL_PENDING, idempotency, selective pushes |
| `npm run test:switch` | 69 | Dev/prod limit validation, persistence, multiple contents |
| `npm run test:contacts` | 33 | Contact list, obfuscation (truncated preview of push tokens) |
| `npm run test:push` | 20 | pushSender: payload without secrets, call to the Expo Push API |
| `npm run test:debug` | 22 | Debug routes: seed-contacts, forced expire, state guard |
| `npm run test:errorhandler` | 15 | 4xx to the client, 500 without stack leaks, NODE_ENV guard on dev routes |
| `npm run test:routes` | 14 | Pairing: 4xx client errors, no sensitive data in errors |
| `npm run test:audit_chain` | 11 | Hash chain: append, verification, tamper detection, anchoring |
| `npm run test:ratelimit` | 8 | Per-identity limits, isolation between contacts, lockout |
| `npm run test:duress` | 6 | Duress trigger: transitions, rate limit 3/day |

**App** (from `app/`) — 3 pure-logic suites (no UI):

| Command | Tests | Covers |
|---|---|---|
| `npm run test:crypto` | 37 assertions | Fixed test vectors, threshold properties (<k fails, ≥k succeeds), multiple lengths, mixed pool of shares + decoys |
| `npm run test:storage` | 17 | StorageProvider abstraction: the stored bytes are the ciphertext, never keys |
| `npm run test:attachments` | 19 | Attachment encryption, size limits |

The React Native screens and the flows that require physical devices (QR scan, real
pushes) **have no automated tests** — see §7.

---

## 5. Building and running the app

**Prerequisites:** Expo account (owner `narbo` in `app.json`), EAS CLI `>= 19.0.8`
(`eas.json`), and for cloud builds an `eas login`. The app uses `expo-dev-client`,
so it **does not run in Expo Go**: a development build is required.

Profiles in `app/eas.json`:

| Profile | Use |
|---|---|
| `development` | Development client, internal distribution — this is the profile for daily work and testing |
| `preview` | Internal distribution, Android as a directly installable APK |
| `production` | Store build, version `autoIncrement` |

```bash
cd app
npx expo start                                   # dev server (richiede dev build già installata)
eas build --profile development --platform android   # build del dev client
```

Required configuration in `app/app.json` → `expo.extra`:

- `serverUrl` — backend URL reachable **from the device** (currently
  `http://192.168.0.210:4000`, a development IP: adapt it to your own network).
- `storageProvider` — `"auto"`: Drive in release, DevBlob in development.
- `googleDriveClientIdAndroid` / `googleDriveClientIdWeb` — OAuth clients for Google Drive.
- `eas.projectId` — EAS project id (to be replaced if building on another account).

In addition: `app/google-services.json` (Firebase project for FCM pushes) and
`app/network-security-config.xml`, injected by the plugin `app/plugins/withNetworkSecurityConfig.js`,
which **allows cleartext HTTP only towards the development IP** (see §7). If you change
`serverUrl`, that file must be updated too, and a new prebuild/build is required.

---

## 6. Critical paths to examine

### Request authentication (per-request signature, no sessions)
Client: `app/lib/canonicalize.ts` (`canonicalize()`) + `app/lib/api.ts` (request
construction and signing). Server: `server/src/middleware/auth.ts` — `canonicalize()`,
`verifySig()` (ECDSA P-256 over SHA-256), `checkAndRegisterNonce()` (anti-replay, key
`pub:ts:sig`, 6 min TTL, **in-memory cache**), `lookupActor()` / `requireAuth()`
(authorization by role and by switch membership). The two canonicalizations
must remain bit-identical: `server/src/routes/auth.test.ts` verifies the equivalence.
`server/src/lib/canonical.ts` (`sortDeep`, `canonicalJson`) is shared with the audit chain.
The web console instead uses `/auth/challenge` + `/auth/verify` (`server/src/routes/auth.ts`).

### Audit chain
`server/src/services/auditChain.ts` — `computeEventHash()` (SHA-256 of the fields
concatenated with `|`, including `prev_hash`; genesis = 64 zeros), `appendToChain()`.
Exposure and verification: `server/src/routes/audit_chain.ts` (including anchoring: events
added after an anchor are detected). Client-side verification: `app/lib/auditChain.ts`,
screen `app/app/audit-tools.tsx`. Events are written by the scheduler, the approvals and
the duress route; note the `try/catch` blocks around `appendToChain` (a write failure
does not block the state transition — assess the consequences).

### Switch lifecycle
States in `server/src/db.ts` (`DISARMED|ACTIVE|GRACE|APPROVAL_PENDING|RELEASED`).
Creation/arming: `server/src/routes/switch.ts` (limit validation in
`server/src/config/limits.ts`). Check-in with jitter: `server/src/routes/checkin.ts`.
Time-based transitions: `server/src/services/scheduler.ts` → `tick()` (exported for the
tests; `startScheduler()` invokes it every 2 s). Pushes are sent only once per
transition, not on every tick.

### Shamir threshold and release
Split and sealing: `app/lib/crypto.ts` — `splitSecret()` / `combineSecret()` (Shamir),
`sealShare()` (share encrypted to the contact's pubkey), `makeDecoy()` (decoys),
`tryOpenShare()` / `findMyShare()` (trial decryption: the contact downloads *all* the blobs
from `/shares` and discovers their own by attempting to decrypt). Server side:
`server/src/routes/approvals.ts` — `/approval/submit` collects the decrypted shares
(signed, rate-limited per contact_id, duplicates → 409) and returns all those
collected; it is **the client**, in `app/app/approve.tsx`, that attempts the recombination
and, if the DEK decrypts the content, calls `/release/confirm`. The content pointers are
exposed only in the RELEASED state.

### Duress PIN and lock screen
Setup: `app/app/duress-setup.tsx`; PIN verification: `app/app/lock.tsx` with
`app/lib/pinHash.ts` (⚠ currently a single salted SHA-256 — finding C1 in
`docs/FINDINGS_TRIAGE.md`), policy in `app/lib/pinPolicy.ts`, exponential lockout
(30 s → 4 h) in `app/lib/lockout.ts`, in-memory unlock state in `app/lib/lockState.ts`
(always restarts locked, 3 min background timeout, deferred deep links).
Mode A (facade): `app/lib/facadeStore.ts` — fake data, no calls to the real server.
Mode B (silent trigger): `server/src/routes/duress.ts` — moves switches to
APPROVAL_PENDING skipping the grace period; **never** directly to RELEASED.

### Storage and content encryption
Encryption: `app/lib/crypto.ts` (`encryptContent`/`decryptContent`, XChaCha20-Poly1305;
per-switch DEK, persisted only on the client). Attachments: `app/lib/attachments.ts`.
Provider abstraction: `app/lib/storage.ts` (`StorageProvider` interface;
`isStorageReady()` guard before arming) with implementations `app/lib/storage/googleDrive.ts`
(+ OAuth in `app/lib/driveAuth.ts`) and `app/lib/storage/devBlob.ts` (development, backed
by `server/src/routes/devblob.ts`). The server receives **only the pointer**:
`server/src/routes/vault.ts` and the `switch_contents` table in `db.ts` (pointer + IV +
non-sensitive label, never ciphertext).

---

## 7. Status and limitations

**Automatically tested:** all the logic listed in §4 — pure crypto, state transitions,
signature authentication, audit chain, rate limiting, server-side duress, storage and
attachments as pure modules.

**Not automatically tested:** the React Native screens, pairing with real QR scanning
(requires the cameras of 2 physical devices — `add-friend.tsx` still contains the
"(demo) simula scan" button), the end-to-end push cycle on a device, the real Google
Drive OAuth flow, the web console (verified manually).

**Configured for development, NOT for production:**

- `app.json` → `extra.serverUrl = http://192.168.0.210:4000`: **cleartext HTTP towards a
  local IP**. Production requires HTTPS and removal of the cleartext exception.
- `app/network-security-config.xml`: allows cleartext towards `192.168.0.210` (Android).
  To be removed/emptied in production.
- `server/src/routes/devblob.ts` (`/dev/blob`) and `server/src/routes/debug.ts`
  (`/debug/*`): active when `NODE_ENV !== 'production'`. Verify that the deployment
  really sets `NODE_ENV=production`.
- Test contacts `[DEV] Genera 2 contatti test` in compose: `__DEV__` only.
- The anti-replay cache and part of the rate limiting are **in memory**: they reset on
  server restart and are not shared across multiple instances.
- Known anomaly in `app/package.json`: a spurious dependency with key `"undefined"`
  pointing to the repo's local path (artifact of an npm command; to be removed).

**Findings already known and triaged** (do not rediscover them from scratch):
`docs/FINDINGS_TRIAGE.md` — in particular the critical ones: C1 (PIN with a single
SHA-256), C2 (decoys distinguishable by their indices), C3 (the server learns k via
`recoveryK`, in tension with the declared invariant).

**Before real-world use** the project itself declares as necessary: an independent audit,
a complete formal threat model and a legal review (see the root `README.md`).

---

## 8. The other documents in `docs/`

| Document | Contents |
|---|---|
| `THREAT_MODEL.md` | Threat model: actors, adversaries (including the coercer), promised guarantees and their boundaries. **Read this first.** |
| `CRYPTO_INVENTORY.md` | Cryptographic inventory drawn from the actual code (libraries and versions from the lockfile, primitives, where comments and code diverge). |
| `FINDINGS_TRIAGE.md` | Already-known findings with triage: status (real/false alarm), severity, notes for the fix. |
| `DESIGN_DECISIONS.md` | Rationale for deliberate choices that would look like mistakes without context (per-request signature vs sessions, per-identity rate limiting, anonymous recovery routes, …). |
| `AUDIT_PROMPTS.md` | Ready-made prompts for LLM-assisted auditing, with methodology (separate sessions; hand over `DESIGN_DECISIONS.md` only in a second phase). |

> Methodological note from `AUDIT_PROMPTS.md`, valid for human reviewers too: reading
> `DESIGN_DECISIONS.md` *after* forming an independent judgment reduces the risk of
> accepting the rationales instead of putting them to the test.
