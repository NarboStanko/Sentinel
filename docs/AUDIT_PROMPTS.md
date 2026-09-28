# Sentinella — Audit prompts for language models

> 🇬🇧 English · [🇮🇹 Italiano](AUDIT_PROMPTS.it.md)

## How to use them

**One prompt per session, in separate sessions.** A model that has already "absolved" the system in one response tends to stay consistent with itself. Independent sessions yield independent judgments.

**What to hand over at the start:** the code, `THREAT_MODEL.md`, `CRYPTO_INVENTORY.md`.

**What NOT to hand over right away:** `DESIGN_DECISIONS.md`. It contains the rationale behind the choices, and a model that reads it tends to accept them rather than challenge them. Hand it over only in the second phase, when you compare the findings you received against the rationale: the ones that remain valid even after reading the motivations are the findings that matter.

**Log everything.** Even false positives: how often different models flag the same thing is a signal, even when the finding is wrong.

---

## Prompt 1 — Attacker with the database

> You have obtained read and write access to this server's SQLite database. You do not have the private keys of any user. Your goal is to alter the history of events without the user being able to notice by verifying the audit chain.
>
> List every action you can perform and, for each, state whether it is detectable, by whom, and under what conditions. Where you find undetectable actions, explain the exact sequence.
>
> Also consider: events the system does not write at all, events it may lose, and time windows in which the chain is incomplete.

## Prompt 2 — Distinguishing duress

> This system has a duress PIN that, if entered instead of the normal one, activates invisible countermeasures. There are two modes: one shows fake data without contacting the server, the other starts a release procedure in the background while showing the real data.
>
> You are an adversary observing the device while the victim unlocks it, and you can also examine it afterward. Find every way to distinguish a duress-PIN unlock from a normal unlock.
>
> Consider: response times, network traffic, power consumption, on-disk artifacts, APK contents, UI state, behavior after a reboot, differences in system logs.

## Prompt 3 — Canonicalization and signatures

> Analyze the canonicalization function used to sign requests, present in two implementations that must produce identical output (client and server).
>
> Questions: do two semantically different payloads exist that produce the same canonical string? Is the separator-based concatenation injectable through field contents? Is the ordering deterministic for all JSON types, including null values, nested arrays, keys with special characters, numbers in different notation?
>
> Construct a concrete collision case if you find one.

## Prompt 4 — Key lifecycle

> Trace the path of every secret in this React Native application: seed phrase, identity private key, content encryption key, Shamir shares, PIN.
>
> For each: where it is generated, with what entropy, where it resides in memory, for how long, where it is persisted, whether it is zeroed after use, and who can read it along that path.
>
> Point out where the JavaScript runtime makes it impossible to guarantee zeroing and what the practical consequences are.

## Prompt 5 — Shamir threshold

> Examine the implementation of threshold secret sharing and reconstruction.
>
> Verify: does coefficient generation use a cryptographically secure source? Is the arithmetic over a correct finite field? Does reconstruction have data-dependent behavior that could constitute a side channel? Is it possible for k-1 shares to reveal partial information about the secret?
>
> Also check the degenerate case: what happens with malformed shares, duplicates, or out-of-range indices.

## Prompt 6 — Route escalation

> This server uses an authentication middleware with four actor types. Every write route declares which type it requires.
>
> Build a matrix of all routes with the required actor type, and look for: routes where the type is more permissive than necessary, routes where the relationship between actor and resource is not verified, paths where a contact can act on a different owner's resources, or where an owner can act on switches that are not theirs.
>
> Also check the deliberately anonymous routes: what guarantees they give up and whether any abuse is possible.

## Prompt 7 — The wrong designer

> Assume that whoever designed this system made at least three significant conceptual errors — not implementation bugs, but architectural choices that do not hold up against the declared threat model.
>
> Find them. For each, explain why the choice seems reasonable, why it is not, and what should be done instead.
>
> Do not list generic best practices: look for what is wrong in this specific system.

## Prompt 8 — The real case

> A journalist in an authoritarian country uses this tool. She has material that would compromise government officials. She has configured three trusted contacts in three different countries, threshold 2, and a daily check-in interval.
>
> She is arrested. Her phone is seized and analyzed by a forensic lab. The investigators have state resources, time, and can obtain cooperation from the server provider and the storage provider.
>
> Describe what they can reconstruct, what they can prevent, what they can never do under any circumstances. Be specific about which material they obtain from each source.

---

## What to do next

Collect the findings in a table: description, which model raised it, estimated severity, and whether it remains valid after reading `DESIGN_DECISIONS.md`.

The findings that survive the comparison with the rationale are the ones to bring to the professional audit: they save the reviewer time and show that the project has already done a job of self-criticism.
