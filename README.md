# Sentinella

> 🇬🇧 English · [🇮🇹 Italiano](README.it.md)

A civic *dead man's switch*, end-to-end encrypted. At regular intervals, Sentinella asks "everything OK?". If the user stops responding (arrest, disappearance, incapacitation), a release request goes out to their trusted contacts: once at least **k** of them approve, the documentation prepared in advance is decrypted and delivered.

Designed for journalists, activists, and anyone who needs to ensure that sensitive information surfaces if something happens to them — without entrusting that information to any intermediary in the clear.

---

## ⚠️ Project status — read before using

**Sentinella has NOT yet undergone an independent security audit and MUST NOT be used to protect people in situations of real risk until it has.**

The system is functional end-to-end and has undergone a thorough internal audit (see `docs/`), but an internal audit is no substitute for external expert review. Until that review and a production deployment over HTTPS are in place, treat this software as an **advanced prototype**, not a reliable protection tool.

Status at a glance:
- Core functionality: **complete and tested end-to-end** (on physical devices).
- Internal audit: **critical and high findings resolved**, medium findings resolved or clarified (see `docs/FINDINGS_TRIAGE.md`).
- External professional audit: **not yet done** (planned).
- Production deployment (HTTPS/VPS): **not yet done** (currently runs over HTTP on a LAN for development).

---

## Security model (in brief)

- **End-to-end**: content is encrypted on the user's device. The server holds only opaque blobs and cannot read them.
- **The server does not know the threshold `k`**: the quorum threshold for release is private to the client. The server collects opaque shares (real ones plus indistinguishable decoys) and does not know how many are required.
- **Secret sharing (Shamir)**: the decryption key is split into shares distributed to contacts; at least `k` shares are needed to reconstruct it.
- **In-person verification (safety number)**: pairing between user and contact is confirmed in person (BIP39 words), defending against man-in-the-middle attacks. Verification is local to the device and does not transfer to a new device (intended property).
- **Duress PIN**: an emergency PIN triggers a decoy facade or a silent trigger, indistinguishable from the outside.
- **Identity recovery**: restore from seed phrase (if kept) or social recovery (key rotation under a contact quorum + mandatory delay + ability to cancel).

Full details in the documents under `docs/` (see below).

---

## Architecture

- **App** (`app/`): React Native / Expo. Cryptography via `@noble` (curves, ciphers, hashes), secure storage via SecureStore/Keystore.
- **Server** (`server/`): Node.js / Fastify + SQLite. Passwordless per-request signature authentication (P-256 challenge–response). Holds opaque blobs and coordinates the flow, with no access to content or to the threshold.

Flow: check-in → (no response) → grace → APPROVAL_PENDING → collection of shares from contacts → RELEASED → the contributing contacts decrypt and keep the content.

---

## Documentation (`docs/`)

- `THREAT_MODEL.md` — actors, threats covered and not covered, design choices.
- `DESIGN_DECISIONS.md` — architectural decisions with rationale.
- `CRYPTO_INVENTORY.md` — cryptographic primitives in use.
- `FINDINGS_TRIAGE.md` — internal audit findings and their status.
- `RECOVERY_MODEL.md` — identity recovery model (restore vs. social recovery), analysis and decisions.
- `C1_ESITO.md` / `PIANO_C1.md` — investigation into the PIN KDF (requires a native module; deferred to the audit).
- `AUDIT_PROMPTS.md` — adversarial prompts for review.
- `REVIEWER_README.md` — guide for the external reviewer.

Note: the English versions are authoritative. Italian translations may lag behind.

---

## Development

**Server:**
```
cd server
npm install
npm run dev        # starts on :4000
```
Tests (separate suites): `npm run test:auth`, `test:switch`, `test:scheduler`, `test:duress`, `test:ratelimit`, `test:routes`, `test:contacts`, `test:audit_chain`, `test:push`, etc.

**App:**
```
cd app
npm install
npx expo start --dev-client
```

Secrets (keys, `.env`, DB) are excluded from version control (see `.gitignore`). The DB is created on the server's first run.

---

## What's left

- Independent professional security audit (application planned, e.g. OTF Security Lab).
- PIN KDF with a native module (Argon2id) — see `docs/C1_ESITO.md`.
- Production deployment over HTTPS.
- Minor findings open for the audit: audit-log naming (M4), hand-rolled P-256 in the web console (M5), forward secrecy of Drive blobs (M6).
- Actuator subsystem (next phase, after the audit).

---

## License

Sentinella is released under the GNU Affero General Public License v3.0 (AGPL-3.0). See the LICENSE file.

Copyright is held by the author (NarboStanko). This allows, in the future, versions with additional features or managed services to support the project's sustainability, while keeping the core free and verifiable.
