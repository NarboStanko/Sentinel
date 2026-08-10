# Piano C1 — KDF nativa per i PIN

Piano tecnico di implementazione di C1 quando sarà disponibile un modulo nativo Argon2.
Vedi [C1_ESITO.md](C1_ESITO.md) per l'esito dell'indagine e i benchmark.

Punti chiave:

1. Formato hash versionato v1/v2.
2. Migrazione uniforme normale+duress (mai versioni diverse).
3. KDF async → i call site in `lock.tsx`, `backup.tsx`, `duress-setup.tsx` diventano `await`.
4. Ri-test obbligatorio di entrambe le modalità duress + lockout dopo la migrazione.

Call site attuali di `hashPin`:

- `app/app/lock.tsx` (4 usi: verifica duress, verifica backup, collisione in creazione, salvataggio nuovo PIN)
- `app/app/backup.tsx`
- `app/app/duress-setup.tsx`
