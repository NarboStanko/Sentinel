# Sentinella — Threat model

> 🇬🇧 English · [🇮🇹 Italiano](THREAT_MODEL.it.md)

**Version:** 1.0 · **Date:** July 2026 · **Project status:** working prototype, not yet subjected to an independent audit

---

## 1. What Sentinella is

A civic *dead-man's switch*. The user (*owner*) prepares a package of encrypted content and "arms" it with a check-in interval. If the owner fails to answer the check-ins within the interval plus a grace period, the system asks the owner's *trusted contacts* to approve the release. Once the quorum is reached, the contacts recombine the key and access the content.

Reference use case: a person who holds information whose publication is in the public interest, and who wants to guarantee its dissemination should they be rendered unable to act.

**What the system promises:**
- The server cannot read the content (end-to-end encryption).
- The server cannot release the content on its own (the contacts' quorum is required).
- The server cannot alter the event history without it being detectable.
- The owner under coercion has two countermeasures: a decoy facade of fake data and a silent trigger.

---

## 2. Actors

| Actor | Description | Trusted for |
|---|---|---|
| **Owner** | Whoever prepares and arms the package | Themselves |
| **Trusted contact** | Person paired in person with the owner, holds a Shamir share | Approving the release (only as part of a quorum) |
| **Server** | Node/Fastify + SQLite backend | Nothing cryptographic: it coordinates, knows neither keys nor content |
| **Storage provider** | The owner's Google Drive (or DevBlob in development) | Storing opaque bytes |
| **Coercer** | Whoever has physical access to the owner and their device | — (adversary) |

---

## 3. Threats covered

### 3.1 Compromised server — passive (read)

**Scenario:** an attacker gains read access to the server's database and files (exploit, physical access, insider).

**Coverage:** the content neither transits through nor resides on the server. The server stores pointers to encrypted blobs on external storage, Shamir shares encrypted for their recipient, and public keys. No secret material in the clear.

**Residual:** metadata exposed. Who is the owner of whom, how many contacts, when a switch was armed, the check-in timestamps. The social graph is visible. **Not mitigated.**

### 3.2 Compromised server — active (tampering)

**Scenario:** the attacker has write control and wants to alter the history: delete events, fabricate them, reorder them.

**Coverage:** hash-linked chain with signed user events (`audit_chain`). Each event contains the hash of the previous one; the hash covers `chain_owner_id ‖ chain_index ‖ event_type ‖ actor_id ‖ canonical(payload) ‖ timestamp_ms ‖ signature ‖ prev_hash`. User actions carry the actor's P-256 signature, which the server cannot forge since it does not hold the private key.

The user can save an *anchor* (hash of the last event of their own chain) outside the system, and later verify that the chain reconstructed by the server matches.

**Declared limit:** the system **detects**, it does not prevent. An attacker with control of the DB can delete or rewrite; the user only notices by verifying against a previously saved anchor. Without an anchor, an attacker with enough time can rebuild a consistent chain from the genesis.

### 3.3 Server attempting an autonomous release

**Scenario:** the server wants to let the content out without the contacts' consent.

**Coverage:** the content encryption key is split into Shamir shares (threshold k, minimum 2 as a product constraint). The shares are encrypted for each contact's public key: the server transports them without being able to read them. k contacts must submit their own decrypted share.

**Residual:** if k contacts are compromised or collude, the release happens. This is a property of the threshold model, not an implementation flaw.

### 3.4 Unauthenticated requests to the server

**Scenario:** an attacker who knows a `switch_id` attempts to disarm it, arm it, add content, submit shares.

**Coverage:** every write route requires a P-256 signature over a deterministic canonicalization of `(method, path, timestamp, public key, body)`. Four actor types (`owner`, `contact`, `owner-of-switch`, `contact-of-switch`) with a lookup that also verifies the relationship (e.g. that the contact belongs to the owner of that switch). Replay protection via a nonce cache with a ±5 min window and a 6 min TTL.

The rate-limit on submissions is per cryptographic identity (`contact_id`), not per IP: two contacts behind the same network do not block each other.

Shares already submitted cannot be overwritten (`UPDATE ... AND submitted_share IS NULL`, the attempt is recorded as `SHARE_OVERWRITE_ATTEMPTED`).

### 3.5 Physical coercion of the owner

**Scenario:** someone forces the owner to unlock the app.

**Coverage:** emergency PIN (*duress PIN*), with two alternative configurable modes:

- **Mode A — decoy facade.** The app unlocks showing credible fake data (a disarmed switch, fictitious contacts marked as verified). **No call reaches the server**: a central guard intercepts every request and returns a plausible network error. The facade state persists in SecureStore, so it remains consistent even if the coercer restarts the device and forces another unlock. The only way out is unlocking with the normal PIN; at that point the app records `DURESS_FACADE_TRIGGERED` and warns the user.

- **Mode B — silent trigger.** The app unlocks showing the **real** data, indistinguishable from a normal unlock, while in the background it moves the active switches into `APPROVAL_PENDING`, skipping the grace period. The contacts immediately receive the approval requests. The quorum remains necessary: duress **initiates** the release, it does not execute it.

**Indistinguishability:** both modes use the same navigation path as the normal unlock, reset the lock-out counter as a valid PIN would, and produce no messages, delays or visible signals. The unlock screen contains no reference whatsoever to the existence of an emergency PIN.

**Biometrics are excluded from unlocking by deliberate choice:** a fingerprint is coercible (it is enough to take the finger), a PIN in one's head is not. If the app could be unlocked with a fingerprint, duress would never trigger.

**Constraints on the duress PIN:** minimum 6 digits, blacklist of 28 common patterns, different from the unlock PIN. Rate-limit of 3 triggers per day per owner.

### 3.6 Brute force on the device

**Coverage:** persistent exponential lock-out (30s → 2min → 10min → 1h → 4h, cap), which survives closing the app. Reset after 24h without failed attempts.

---

## 4. Threats NOT covered (explicitly declared)

| Threat | Why not covered |
|---|---|
| **Malware on the owner's device** | An attacker with code running on the phone reads SecureStore, memory, and observes PIN entry. No defense is possible at this level. |
| **Server + anchor both compromised** | If the attacker controls the server and the user has never saved an external anchor, they can rebuild a consistent, false audit chain. |
| **Collusion of k contacts** | Property of the threshold model. The choice of k is a trade-off between availability and collusion resistance. |
| **Coercion of the contacts** | An attacker who forces k contacts to approve obtains the release. Contacts have no duress mechanism. |
| **Forensic analysis of the device** | The facade withstands a superficial inspection under stress, not a technical analysis: the APK contains the facade code, and the real data is present in SecureStore. |
| **Metadata on the server** | Contact graph, timings, frequency of use are in the clear in the DB. |
| **Compromise of the storage provider** | Google can delete the blobs (not read them: they are encrypted). A deleted blob makes the package unrecoverable. |
| **Denial of service on the server** | If the server is offline, check-ins do not arrive and the cycle stops. IP rate-limit present as a second layer, but there is no redundancy. |

---

## 5. Planned subsystem: outputs to actuators

**Not implemented.** Documented here because the design has been decided and it introduces its own attack surface, which the auditor may want to consider when evaluating the existing architecture.

**What it is:** a generic output that, upon release, delivers an activation command to a device controlled by the user (Raspberry Pi, ESP32 or similar). The semantics of the action are the user's responsibility: opening a lock, starting a recording, unlocking a container. Sentinella provides the verifiable activation mechanism, it does not decide what gets activated.

**Design principle:** the actuator must trust neither the server nor the network. The activation secret resides **inside the encrypted package**, protected by the same Shamir threshold as the content, and encrypted for the actuator's public key. It therefore becomes available only after k contacts have approved and recombined the key. The server transports a blob it can neither read nor fabricate.

**Resulting properties:**
- A compromised server cannot operate the actuator: it does not hold the secret.
- An intercepted activation is not reusable (see anti-replay).
- No third-party cloud enters the trust perimeter.

**Decisions taken:**

| Aspect | Choice | Rationale |
|---|---|---|
| Anti-replay | Persistent monotonic counter, no time-based expiry | A microcontroller without an RTC takes its time from the network: whoever controls the network controls the expiry. The counter requires no clock. |
| Actuator offline at release | The activation stays pending until the device becomes available again | A release scenario occurs when the owner cannot intervene: losing the activation to a network outage would defeat the feature. |
| Enrollment | In-person verification with safety number comparison, as for contacts | A network-based association is subject to substitution of the actuator's public key. |
| Confirmation | The actuator signs an execution attestation that enters the audit chain | Without it, there is no way to know whether the physical action took place. |
| Test mode | Simulation flag on the device: it logs instead of acting | Makes tests non-destructive. |
| Participation in the duress trigger | User-configurable during setup | If the actuator responds to duress, a coercer who knows the mechanism has an incentive to force its use. The choice is the user's, informed. |

**Known risks of the subsystem:**
- The anti-replay counter must survive power-off: on microcontrollers this requires writing to non-volatile memory, with attention to write cycles.
- The server endpoint delivering the activation blobs must not allow enumerating which owners have actuators.
- A physically compromised actuator can be prevented from acting (denial of service) or operated at a time other than the intended one.
- An activation pending for an indefinite time may fire in a context radically different from the one in which it was authorized.

---

## 6. Cryptographic surface

See `CRYPTO_INVENTORY.md` for the itemized list of primitives, parameters and points of use.

Summary: P-256 curve signatures for authenticating requests and audit events; Shamir threshold sharing for the content key; authenticated symmetric encryption for the content; SHA-256 for the audit chain; salted derivation for the PINs in SecureStore.

---

## 7. Questions expected from the audit

The areas where priority attention is requested:

1. **Shamir recombination** — is the implementation free of timing leaks or side channels? Does share generation use adequate entropy?
2. **Key lifecycle** — are cleartext keys zeroed in memory after use? How long do they persist in the JavaScript runtime?
3. **Canonicalization** — does the recursive ordering produce deterministic and unambiguous serializations? Are there colliding payloads?
4. **Duress indistinguishability** — are there observable side channels (timing, network traffic, power consumption, on-disk artifacts) that distinguish a duress unlock from a normal one?
5. **Audit chain** — is the hash construction free of concatenation ambiguities? Can the `|` separator be injected via payload?
6. **Best-effort audit** — chain writes are not transactional with the main action: which events can be lost and with what consequences?
7. **Authentication model** — do the four actor types cover all routes with the correct granularity? Are there escalation paths?

---

## 8. Status and declared limits

- **242 automated tests** server-side, all green. They cover authentication, rate-limit, audit chain, hardening, server-side duress.
- **Tested end-to-end on physical devices** with production builds: in-person pairing, arming, quorum, release, decryption, both duress modes.
- **Not tested:** quorum with download from Google Drive (requires a third device); real duration (switches armed for weeks); push notification behavior after long inactivity.
- **The server runs over HTTP** on the local network during development. Production deployment requires HTTPS (Let's Encrypt) and the removal of the configuration that allows cleartext traffic to the development IP.
- **No independent audit has been performed.** The system must not be used by people in situations of real risk before that happens.
