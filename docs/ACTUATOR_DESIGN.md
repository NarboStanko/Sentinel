# Sentinella — Actuator Subsystem Design

> 🇬🇧 English · [🇮🇹 Italiano](ACTUATOR_DESIGN.it.md)

Design document (on paper). To be implemented in phases, after the professional audit (per THREAT_MODEL). It records the decisions made; open points are marked [TO BE DECIDED].

## 1. Guiding principle

Sentinella **delivers a signal**; it does not perform physical actions. What the actuator does with the signal is the user's responsibility. This relieves Sentinella of responsibility for the physical action, maximizes flexibility, and reduces the code/attack surface.

**Core UX principle:** an actuator the user believes is reliable but isn't is worse than no actuator at all. The UX must not sell security: it must communicate honestly what it does and what it doesn't. In particular, the limits (dependence on power and connectivity) must be communicated within the flow, not hidden in a disclaimer.

## 2. Security model (reuses the existing mechanism)

The activation signal is **a package content like any other** (documents/photos), not a separate channel:
- It is a **small blob** (token ~32 bytes), encrypted to the **actuator's public key**.
- Protected by the **same Shamir threshold** as the contents: it unlocks only at quorum (k contacts approve).
- Transported by the server as an opaque blob (the server can neither read it nor forge it).
- Released at `RELEASED` like the other contents.

**Resulting properties:**
- The server cannot activate the actuator (it does not have the shares).
- A single contact cannot activate it (the quorum is required).
- Even contacts who see the released content cannot use the signal (it is encrypted to the actuator's key; only the actuator can decrypt it).
- A forged signal does not contain the valid token → the actuator does not act.
- The security of activation inherits that of content release (already audited).

## 3. Transport

- **Base case: IP polling.** The server has a fixed IP; it is the **actuator that queries the server** ("is my blob there? is the switch RELEASED?"). The server responds with the blob only when the state is `RELEASED` (the same gate as for contacts). The actuator decrypts with its private key, verifies, acts.
- Transport is **pluggable**. Since the signal is small (~32 bytes), it can also be transported over **Meshtastic (LoRa mesh)** for anti-censorship scenarios (internet blackout). IP↔mesh gateway [TO BE DECIDED, later phase].

**Note on polling (honest):** a dedicated ESP32 doing polling is robust in the normal case — automatic wifi reconnection, very low power consumption, single-purpose device. The real weak points: (a) prolonged power blackout → mitigable with a UPS/battery; (b) network restart → not a problem, it reconnects; (c) infrastructure seized/shut down when the user disappears → NOT solvable in firmware; it is the dead man's switch paradox applied to hardware. Here the answer is Meshtastic and/or placing the device elsewhere (e.g. at a contact's). To be documented as a limitation.

## 4. UX — two levels

### Guided base path ("Connect an actuator")
For reasonably capable users (they can use a USB cable and follow instructions), without programming. It must lead to a WORKING actuator, not to a teaser.

Wizard flow:
1. **What you need** — honest: ESP32, cable, ~15 min. "It receives a signal when the switch fires; what it does is up to you." + the limit stated up front ("it only works while it stays powered and connected").
2. **Ready-made firmware** — precompiled relay firmware, flashable without a toolchain (ideally a web flasher over USB, like ESP Web Tools). See §5.
3. **Pairing** — the ESP32 generates its key pair and shows the public key (display / access point with a small web page / QR). The app registers it. Same pattern as contact pairing.
4. **Test** — a "test the actuator" button: it sends a TEST signal (not a real release), the user sees the relay trip and confirms it works. Essential.
5. **Status** — the actuator appears in a list with its health status (§6).

### Advanced level
For those who write their own firmware. We provide:
- Protocol specification (polling endpoint, blob format, how to decrypt/verify the token with the actuator's key).
- Reference library/SDK (signal verification code to integrate).
- Transport options (IP polling now, Meshtastic in the future).
- Full control over what to do after verification.

The base path is a special case (the most common one) of the advanced path.

## 5. Relay firmware (base)

Precompiled firmware provided by us. **Multi-relay, configurable per relay (mode B).**

Parameters per individual relay:
- **Mode**: pulse (trips for N seconds then returns) | latch (trips and stays).
- **Duration** (for pulse mode).
- **Delay** before activating (to stagger actions across relays).
- **Normally open / normally closed** (NO/NC).

**Where it is configured:** on the ESP32 directly, via a **small web page** served from its access point (a proven IoT pattern). The Sentinella app does NOT know the relay details: it registers the key and monitors the status. The firmware is autonomous; the config lives on the ESP32.

Relay activation model: [TO BE DECIDED — probably "one valid signal → all relays execute their own config (mode/duration/delay)". Distinct signals for distinct relays = advanced territory.]

## 6. Health status (the honest heart of the UX)

Since the actuator polls, the server knows **when it last heard from it**. The app shows the status:
- "Last contact: 2 minutes ago ✓"
- "⚠ No contact for 3 days — the actuator may be offline."

This turns a limitation (the actuator can fail silently) into something visible and manageable. It keeps the system honest: it shows the real status instead of promising reliability. [TO BE DEFINED: alert thresholds, whether/how to notify the user when an actuator stays silent too long.]

## 7. Open points
- IP↔Meshtastic gateway (later phase).
- Multi-relay activation model (all together vs addressable).
- Health-status thresholds and notifications.
- Server-side data schema to register actuators and their blob (probably a dedicated `actuator_*` table, separate from switch_contents for targeted polling and efficiency — the ESP32 must not download heavy documents/photos).
- How the ESP32 exposes/registers its public key securely (in-person verification? signed QR?).
- Payments / positioning as a premium feature [next discussion].

---

## 8. Sustainability and payment model

### Core ethical principle
**The basic security of a person at risk cannot sit behind a paywall.** The security core (dead man's switch, check-in, release to contacts, cryptography, Shamir, in-person verification, duress PIN, recovery) is and remains **free and open source** for everyone. Since the code is AGPL, security is always available to anyone willing to self-host/build it themselves: you pay for the CONVENIENCE of not doing so, never for the protection.

### What is free / what is paid
- **Free (essential security):** the entire core. + the open actuator *protocol* (an advanced user builds and runs their own actuator without paying).
- **Paid (convenience/service):** the **actuator service** delivered as a recurring subscription — ready-made relay firmware, guided configuration, and above all the **hosting of the polling/infrastructure**. Model: premium *as a service*, not a one-time purchase (recurring revenue, more sustainable).

### Principle: payment is NEVER a single point of failure in security
**An armed switch with an actuator remains protected even if the subscription expires.** The subscription enables the CONFIGURATION and arming of (new) actuators; once armed, the switch works forever, regardless of payment status.

Technical consequence: subscription verification happens at **arm/configure** time, not at **release** time. The entitlement is "frozen" into the switch at arming; the release path (the critical moment) does NOT re-check payment — it must be as robust and dependency-free as possible. This is also good security: release must not depend on a billing server.

### Open issues to address [TO BE DECIDED]
- **Payment traceability:** an activist under a hostile regime who pays by card leaves a trace ("uses an anti-surveillance tool"). Evaluate privacy-preserving payments (crypto? vouchers? payment by organizations?), or accept that the paid service is for those not in that extreme scenario (free self-hosting for the others).
- **Store fees:** Play/App Store take 15-30% on digital goods and impose their own payment system (traceable). Evaluate billing the hosting outside the app (on the web) where the rules allow it.
- Price, currency, tiers.

### Presentation in the app (principles)
- **Never** a paywall blocking a security function. No "unlock your protection". The protection is already there, for free.
- The premium feature (actuators) is presented as an **optional extension** in an "advanced/extensions" section, with a clear price and the *why* (it supports development and infrastructure).
- **Transparency about the model:** an honest screen — "Sentinella is free and open source. The actuator service is paid to cover infrastructure costs. If you can't pay, you can self-host: here's how."
- **"Support + get" framing, not "buy".** For an honest civic tool, users want to support it; the payment is closer to a donation with a benefit than an extractive transaction.
- [TO BE DEFINED: concrete screens, entry point in the flow, how to show the price.]

---

## 9. Payment system — manual signed license

### Chosen model
Payment **fully decoupled** from unlocking the feature (maximum privacy, zero store fees, zero billing infrastructure):
1. The user pays **outside the app**, however they prefer/can: Monero, vouchers/codes purchasable elsewhere (including with cash or through an organization), bank transfer, etc.
2. The user **makes contact** (e.g. by email) to obtain the unlock.
3. A **signed license** (code) is issued manually, which the user enters in a "redeem code" field in the app.
4. The app **verifies the signature** with the issuer's public key (embedded in the app). No billing server, no automatic traceable link between app account and payment.

### Duration
A **time-limited** code, in tiers: **1 / 2 / 3 / 5 years**. This reduces the frequency of manual renewals. Consistent with "payment is not a single point of failure": the license enables the CONFIGURATION of new actuators; already-armed switches work forever even with an expired license.

### Cryptographic form of the license (security)
The license is NOT a guessable or freely shareable code: it is a **signed license**.
- The issuer has a dedicated key pair (private key kept safe, public key embedded in the app).
- The code is a **signature** over a payload like: `{ scope: "actuators", validUntil: <data>, ... }` (+ optional binding, see below).
- The app verifies the signature with the embedded public key → the code cannot be forged or generated by third parties.
- Same cryptographic principle (asymmetric signature) already used throughout Sentinella. Reuses `@noble`.

### Open issues on the license [TO BE DECIDED]
- **Binding**: is the license tied to an identity/device (non-shareable) or is it a "bearer" license (whoever holds it uses it)?
  - Bearer = more privacy (no user data in the license) but shareable/resellable.
  - Binding to the ownerId/pubkey = non-shareable but ties the license to the identity (less privacy).
  - Privacy vs anti-sharing trade-off to evaluate. For a pro-privacy tool, bearer might be acceptable (the feature is niche, sharing is limited).
- **Revocation**: if a license is abused, how is it revoked without a server? (a revocation list embedded in app updates? or accept that it is not revocable?)
- **Store policy**: the app must have ONLY a "redeem code" field, WITHOUT directing to the external payment inside the app (Apple/Google policies forbid linking to external payments for digital goods). Payment and instructions live OUTSIDE (website/README). The redeem field is like redeeming a gift card — generally tolerated.

### Why this model for Sentinella
- Maximum user privacy (payment and app identity disconnected).
- Zero store fees, zero billing infrastructure.
- Consistent with the initial scale (few premium users → manual handling is feasible).
- The user at EXTREME risk doesn't pay anyway: they use the free/self-hosted core. Those who pay are the lower-risk users → the residual traceability is less critical.
- Cons: it doesn't scale automatically (a nice problem to have; automate later), unlock latency (acceptable for a non-urgent feature).

---

## 10. Multi-relay activation model (deep dive)

### A single signal (Scenario A)
In Sentinella, release is **atomic and binary**: the switch fires (RELEASED) or it doesn't; when k contacts approve, the WHOLE package unlocks. There are no partial or graduated releases. So there is **a single activation moment** → **a single signal** for the actuator. Distinct signals for distinct relays (Scenario B) would be unusable power (there is no distinct event to generate them). The richness lies in **per-relay configuration**, not in multiple signals.

### Configurable number of relays
The number of relays is NOT fixed: the user connects from 1 to N relays (the ESP32 has many GPIOs). The config is a **list of relay definitions**; adding a relay = adding an entry with its pin and its config. The firmware iterates over the list when the signal arrives.

### Parameters per individual relay
- **GPIO pin** it is connected to (the user knows where to attach the wires).
- **Mode**: pulse (trips for N seconds then returns) | latch (trips and stays).
- **Duration** (for pulse).
- **Delay** before activating → allows orchestrating a SEQUENCE from a single signal (relay 1 at t=0, relay 2 at t=10s, relay 3 at t=60s).
- **NO/NC** (normally open / normally closed).
- **Idempotency (see below)**: once-only | maintain-state.

### Idempotency / behavior on restart
Two levels:
- **The firmware** has the CAPABILITY for both behaviors (logic + persistent NVS/flash memory to remember "release already executed").
- **The config** (web page/file) exposes the per-relay CHOICE to the user.

Behaviors (the base firmware supports BOTH, chosen per relay):
- **Once-only**: the actuator remembers in persistent memory that it has already executed that release and does NOT repeat it on subsequent restarts. Correct for event-actions (a pulse, open a lock once). Recommended default.
- **Maintain-state**: the relay reflects the "RELEASED" state for as long as it lasts (e.g. keep a circuit open/closed while the switch is RELEASED). For uses where activation is a continuous state, not an event.

### State at boot (security/robustness — CRITICAL)
On ESP32 boot/restart, the relays must NOT trip by accident (a momentary blackout → restart must not simulate an activation). The firmware must:
1. Initialize every relay to its resting state (according to NO/NC) BEFORE entering polling.
2. Distinguish "I am restarting clean" from "I have already received the signal" (persistent flag).
3. Activate the relays ONLY if it receives/has received the valid signal, never merely because it powered on.

### Configuration: web page + JSON file
- **Small web page** (ESP32 access point): user-friendly, base path, the user doesn't touch files.
- **Uploaded JSON file** (e.g. `relays.json`): for the advanced user — versionable, replicable (configure 8 identical relays by copying a file instead of clicking 8 times).
- Offer both.

### Practical firmware notes (for implementation)
- **Safe pins**: not all GPIOs are equal (some are input-only, some are strapping pins that can prevent boot if driven, some are absent on certain modules). The base path should PRE-SUGGEST a list of safe pins, not leave it open-ended (a beginner doesn't know which to avoid).
- **Relay power**: more relays = more current; relay modules are powered separately (the ESP32 pins only drive the signal). Note for the user documentation.

---

## 11. Secure registration of the actuator's key

### Chosen model: trust based on physical possession
Unlike contacts (where you verify the identity of a remote human counterpart with the safety number), the actuator is an **object owned by the user**, configured offline at a time and place the user controls. In that context, **physical possession IS the root of trust**: there is no counterpart to verify; there is the user and their device. A safety number here would be theater, not security (you would be verifying that the key of the object-in-hand matches the object-in-hand).

Principle: do not add security ceremony where it adds no real security.

### Explicit assumptions (to document for the user)
The model trusts the MOMENT of setup. Assumptions:
1. **Trusted hardware (supply chain)**: the ESP32 is not compromised upstream. Mitigation: hardware from trusted sources, the user flashes the firmware themselves (they know what's running), the option to verify the firmware.
2. **Secure setup environment**: no observer/interference during configuration (no malware on the phone recording, no filming). Setup in a controlled environment.
3. **Hardware RNG**: the firmware MUST generate the key with the ESP32's hardware RNG (it has one), not a predictable seed. Firmware requirement — a key from a weak RNG is guessable regardless of the registration process.

### Channel hygiene (even while trusting possession)
The ESP32's public key must be transmitted to the app via a **direct local channel** (QR shown/read by the device, or USB), **never in cleartext over wifi on the network**. Not for verification (possession is trusted), but to avoid gratuitously introducing an interception point. It's hygiene, not ceremony.

### Limits (honest)
- It does NOT cover an adversary who tampers with the device's supply chain (an ESP32 doctored before setup).
- It does NOT cover a compromised setup environment.
- For extreme threat models (a state adversary with supply-chain capabilities), the advanced user can perform additional checks (reproducible firmware builds, attestation), but that is NOT the base case.
- For the normal use case (a user configuring their own device in an environment they control), the model is adequate.

---

## 11-bis. Registration via USB — final decision

Update/clarification of §11: the registration channel is **USB**, with a safety number as confirmation.

### Why USB
- The ESP32's USB carries **serial** data (text), not video. A safety number is text → it can be shown/read over serial.
- It is a **direct physical channel** (a cable): no radio/wifi/network, the least interceptable channel there is. A man-in-the-middle would require physical access to the cable during setup.
- **USB is already connected during firmware flashing.** If the base path uses a web flasher (e.g. ESP Web Tools, flashing from the browser over USB), the user is already connected over USB at that moment. The key/safety number appears right after the flash, on the same channel, with no extra step. This makes USB registration accessible in the base path too, not only to advanced users.

### Flow
1. The user flashes the firmware via USB (web flasher or toolchain).
2. As soon as it's flashed, the ESP32 generates its key pair (hardware RNG) and shows the public key over serial (the flasher/app captures it).
3. The app derives and shows a **safety number** from the keys; the ESP32 shows/has shown its own. The user confirms they match.
4. The actuator's public key is registered in Sentinella.

### Note on the safety number here
Technically **redundant** (the physical USB channel is already practically non-interceptable), but the cost of implementing it is minimal (printing text to serial) and it provides a reassuring explicit confirmation. Included as confirmation, not as a necessary defense — consistent with the principle "don't add ceremony where it isn't needed", but here the cost is so low that the peace-of-mind value justifies it.

### Firmware requirement restated
Key generation MUST use the ESP32's **hardware RNG**. A key from a weak RNG is guessable regardless of the registration channel.

### UX note
The access point's web page remains useful for **relay configuration** (§10), but **key registration** happens via USB (more secure and already available at flash time). Two channels for two purposes: USB for the key, web page/file for the relay config.

---

## 12. Actuator health status (the honest heart of the UX)

Since the actuator polls, the server knows **when it last heard from it**. This makes it possible to show the real status instead of promising reliability that cannot be guaranteed — it prevents the user's FALSE CONFIDENCE ("my actuator protects me" while it has been disconnected for days). It is the feature that keeps the subsystem honest.

### Polling frequency
**Every 10 minutes.** A compromise between reactivity (activation within ~10 min of RELEASED) and contained load/power consumption. (The release flow involves delays of hours/days anyway, so 10 min is amply reactive enough.)

### Health-status thresholds
The server knows the last contact; the app derives a status. The thresholds are tolerant of isolated missed pings (unstable network, ESP32 restart, busy server) but sensitive to real failures. Indicative calibration (to refine with real devices):
- **Green (healthy)**: last contact < ~30 min (at least a couple of recent successful pings).
- **Yellow (attention)**: silence from ~30 min to a few hours. "Something might be wrong, keep an eye on it."
- **Red (probably offline)**: silence for several hours (e.g. 6-12h+). "The actuator is almost certainly offline, take action."

Principle: tolerant enough not to cry wolf over every lost ping, sensitive enough to warn before it becomes a serious problem.

### Notifications
**Push on alert (transition to red), BUT ONLY if the switch is armed.**
Rationale: an offline actuator really matters only when the switch is armed — if it is disarmed no release is possible, so an offline actuator is not an emergency. Notifying only in the armed state:
- warns when it really matters (there is something to activate, and the actuator is dead),
- eliminates the noise when it isn't needed (switch disarmed).

Example notification: "⚠ Your actuator has not responded for 8 hours. The switch is armed: check power and connectivity."

### In-app display
In the actuator list, each actuator shows its status (green/yellow/red) and "last contact: X ago". Passive (always visible when opening the app) + active push on alert while the switch is armed.

### Note
This mechanism mitigates (does not eliminate) the structural limitation of the physical actuator (§3): it can still fail silently, but now the user SEES it and is warned when it matters, and can intervene (restart, check power, etc.) instead of finding out too late that it didn't work.
