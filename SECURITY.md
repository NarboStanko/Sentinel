# Security Policy

Sentinella is a security tool intended for people at real risk. We take vulnerability reports seriously and appreciate responsible disclosure.

## Current status — please read

**Sentinella has NOT yet undergone an independent security audit and MUST NOT be relied upon to protect people in situations of real risk.** The project is an advanced prototype under active development. See the README for the current status.

If you are a security researcher or auditor: we actively welcome review. The documentation in `docs/` (threat model, cryptographic inventory, internal audit findings) is written to help you get oriented quickly — start with `docs/REVIEWER_README.md`.

## Reporting a vulnerability

**Please do NOT open a public issue for security vulnerabilities.**

Report privately via **GitHub's Private Vulnerability Reporting**: go to the *Security* tab of this repository and click *Report a vulnerability*. This keeps the report confidential until a fix is available.

When reporting, it helps to include:
- A description of the issue and its potential impact
- Steps to reproduce, or a proof of concept
- The component involved (app, server, web console, cryptography)
- Whether it relates to a known open finding (see `docs/FINDINGS_TRIAGE.md`)

## What to expect

- Acknowledgement of your report as soon as possible (this is a volunteer-maintained project; please allow some days).
- We will work with you to understand and address the issue.
- Credit in the release notes if you wish (or anonymity if you prefer).

## Scope

In scope: the app (`app/`), the server (`server/`), the web recovery console (`web/`), and the cryptographic design described in `docs/`.

Known open findings deferred to the professional audit (e.g. the PIN KDF, C1) are documented in `docs/FINDINGS_TRIAGE.md` — reports confirming or extending those are still welcome.

## Out of scope

- Vulnerabilities requiring physical access to an unlocked device
- Issues in third-party dependencies already publicly known (please report those upstream), unless Sentinella uses them in an unsafe way
- Social engineering of the maintainer
