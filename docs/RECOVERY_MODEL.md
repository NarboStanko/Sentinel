# Sentinella — Modello di recovery dell'identità

**Stato:** analisi completata, decisione presa (Opzione 1), Parte A fatta (commit 6b4851e), flusso server validato in test parziale. Parti C/D/E da fare in sessione dedicata (vedi sezione 6). Prima di riprendere: reset pulito di DB + telefoni.
**Perché documentato:** tocca il flusso di sicurezza più delicato del sistema (recupero dell'identità). Un errore qui = utente perde l'accesso, o attaccante ruba un account. Merita mente fresca e, idealmente, un occhio dell'audit professionale.

---

## 1. Due meccanismi distinti (non confonderli)

Sentinella ha DUE modi di riprendere il controllo dopo la perdita del telefono. Servono a casi diversi.

### Restore da seed (già funzionante, testato E2E)
- **Presupposto:** hai ancora la seed phrase.
- **Come:** su un nuovo device reinserisci la seed → `identityFromSeed` rigenera la STESSA chiave (priv/pub derivano dalla seed). Challenge-response (`/auth/challenge` + `/auth/verify`) prova il possesso. Rientri subito.
- **Nessun quorum, nessun ritardo.** Se hai la seed, sei tu, punto.
- File: `restore.tsx`, `auth.ts`.

### Social recovery (rotazione chiave, DIFETTOSO oggi)
- **Presupposto CORRETTO:** hai perso il telefono E la seed. Hai una NUOVA seed → nuova identità (chiave B, ownerId_B).
- **Scopo:** trasferire il controllo del vecchio account (ownerId_X, controllato dalla chiave A perduta) alla nuova chiave B.
- **Come:** `/recovery/initiate` (fissa la new_public_key = B) → i contatti approvano (`/recovery/approve`, quorum = recovery_k) → ritardo 7gg → `/recovery/finalize` ruota `users.public_key` da A a B.
- **Invariante server (finalize):** ruota SOLO la chiave pubblica. Non tocca DEK, quote Shamir, stato switch. Gli switch continuano a girare, le quote (sigillate ai contatti) restano valide.
- **Freni:** bloccato se uno switch è in GRACE/APPROVAL_PENDING; annullabile (`/recovery/cancel`) da chi possiede ancora la chiave A (firma il recoveryId).
- File: `recovery.ts`, `social-recovery.tsx`.

**Chiarezza fondamentale:** i contatti NON ti ridanno l'identità (la chiave A derivata dalla seed persa è irrecuperabile per sempre). Autorizzano il TRASFERIMENTO dell'account alla nuova chiave B.

---

## 2. I difetti di modello del social recovery attuale

### Difetto 1 — Il device nuovo non conosce il vecchio ownerId
`social-recovery.tsx` InitiateSection fa `loadOwnerId()` + `identityFromSeed(loadSeed())` del device CORRENTE. Ma nello scenario reale (device nuovo, seed nuova), `loadOwnerId()` è il NUOVO ownerId, non il vecchio ownerId_X da recuperare. Il testo UI dice "hai accesso alla seed phrase" — che è il caso del RESTORE, non del recovery. Ambiguità reale.

**Decisione presa:** il vecchio ownerId lo forniscono i contatti. Loro ce l'hanno nei propri contatti fidati.
**Scoperta successiva (semplifica):** il contatto NON deve comunicarlo manualmente. `ApproveSection` usa `recoveryPendingForContact` — il server mostra automaticamente al contatto le richieste di recovery pendenti che lo riguardano (autenticato con la firma del contatto). Quindi il flusso di approvazione è già automatico. Resta da risolvere come il DEVICE CHE AVVIA specifica ownerId_X: la UI initiate deve CHIEDERE il vecchio ownerId (campo input), non usare loadOwnerId().

### Difetto 2 — La fiducia dei contatti punta ancora alla chiave A (IL NODO CRITICO)
Il contatto salta in SecureStore `verified_owner_key = A` (keystore.ts:83, singola stringa), verificata DI PERSONA al pairing. `approve.tsx` confronta la chiave owner con questa copia locale ("Chiave owner non verificata. Ripeti il pairing di persona").

Dopo la rotazione, il server ha B ma ogni contatto ha ancora A localmente → il confronto fallisce → il contatto NON può più operare per il nuovo owner.

**Come il contatto passa da A a B?** Questa è LA decisione di sicurezza del recovery.

---

## 3. Decisione: Opzione 1 (social trust)

**Scelta:** l'approvazione del recovery È la nuova verifica. Quando il contatto approva (atto esplicito, firmato col suo device) e il recovery viene finalizzato, l'app del contatto aggiorna localmente `verified_owner_key` da A a B.

**Sicurezza affidata a:** quorum (k contatti devono approvare) + ritardo 7gg + cancel firmato con la chiave A.

**Trade-off accettato:** il contatto NON confronta di persona il safety number di B. Si fida che chi ha avviato il recovery sia l'owner, basandosi sul fatto che conosce ownerId_X e che il quorum è d'accordo. È il modello dei social recovery wallet (Argent, ecc.).

**Rischio residuo documentato:** se un attaccante (a) scopre ownerId_X, (b) inganna/compromette k contatti, (c) l'owner non annulla entro 7gg (perché ha davvero perso la chiave A, quindi non PUÒ annullare) → furto dell'account. Difesa = quorum + finestra di 7gg. Per k=2 con avversario capace è un rischio reale ma non banale. **Questa è la classe di rischio che l'audit professionale dovrebbe validare.**

**Opzioni scartate:**
- Opzione 2 (ri-verifica di persona di B): sicurissima ma svuota il senso del recovery (se devi reincontrare tutti, tanto vale rifare il pairing).
- Opzione 3 (ripristina accesso ma non fiducia contatti): nel caso Sentinella, dove lo scopo È coinvolgere i contatti, lascia il sistema mezzo funzionante.

---

## 4. Piano di implementazione (per gradi, con gate e commit separati)

Ogni parte va testata e committata prima della successiva. La Parte C è quella pericolosa: testare E2E con cura.

### Parte A — UI initiate chiede il vecchio ownerId (Difetto 1)
- `social-recovery.tsx` InitiateSection: aggiungi un campo input "ownerId da recuperare". Non usare `loadOwnerId()` del device.
- `identityFromSeed(loadSeed())` resta (la nuova chiave B è quella del device nuovo). Ma l'ownerId target viene dall'input.
- `api.recoveryInitiate(ownerIdInput, newPubHex)`.
- Chiarire il testo: "Usa questa sezione se hai perso telefono E seed. Inserisci il tuo vecchio ID account (te lo comunicano i tuoi contatti fidati)."

### Parte B — (già coperta)
Il contatto vede le richieste pendenti automaticamente via `recoveryPendingForContact`. Verificare solo che la lista mostri abbastanza contesto (nome owner, data) per un'approvazione consapevole. Eventuale: mostrare al contatto l'ownerId dell'owner in recovery, così può comunicarlo (utile per la Parte A).

### Parte C — Aggiornamento fiducia post-finalizzazione (Difetto 2, IL CUORE)
- Alla finalizzazione del recovery, l'app di OGNI contatto che ha approvato deve aggiornare `verified_owner_key` da A a B.
- **Problema:** il contatto come sa che il recovery è stato finalizzato e qual è B? Opzioni:
  - Il contatto, quando apre l'app, controlla lo stato dei recovery che ha approvato; se finalizzato, legge la new_public_key (B) dal server e aggiorna la copia locale.
  - **ATTENZIONE sicurezza:** leggere B "dal server" e fidarsi ciecamente reintrodurrebbe il rischio che un server compromesso sostituisca la chiave. MA nel modello Opzione 1 la fiducia viene dall'aver approvato: il contatto aggiorna a B SOLO se ha una `recovery_approvals` sua per quel recovery, e B = la new_public_key che era fissata all'initiate (immutabile). Verificare che new_public_key non sia modificabile dopo l'initiate.
  - Serve un endpoint tipo `/recovery/status` che, per un contatto autenticato che ha approvato, ritorna { finalized, newPublicKey }.
- Dopo l'aggiornamento locale, `approve.tsx` confronterà con B e funzionerà.
- **Test E2E obbligatorio:** dopo il recovery, il contatto deve poter approvare un rilascio del NUOVO owner senza "chiave non verificata".

### Parte D — Test E2E completo
- Ritardo: `initiate` non espone delaySec dal client (usa default 7gg). Per testare, forzare `unlock_at` nel DB dopo l'initiate:
  `UPDATE recoveries SET unlock_at = 0 WHERE id = '<recoveryId>';` (script .cjs)
- Coreografia: T1 = owner (chiave A). Simula perdita: nuovo device/reset con NUOVA seed → chiave B. Initiate verso ownerId_X (vecchio). T2/T3 approvano. Forza unlock_at=0. Finalize. Verifica: B controlla l'account; T2/T3 possono operare per B (Parte C funziona).

### Parte E — UI quorum recovery_k (l'obiettivo ORIGINALE di C3 fase 2)
- Solo DOPO che il recovery funziona E2E col default 2.
- UI dove l'utente sceglie recovery_k (limitato al numero di contatti). Endpoint dedicato che aggiorna users.recovery_k, disaccoppiato dalla soglia contenuto (C3 fase 1 già fatto).
- Spiegare bene la differenza tra "contatti per liberare i documenti" (k contenuto) e "contatti per recuperare l'identità" (recovery_k), o l'utente li confonde.

---

## 5. Note di sicurezza per l'audit

- Validare il modello Opzione 1: il rischio "k contatti ingannati + owner non può annullare" è accettabile per il threat model?
- `/recovery/initiate` è anonimo (chi ha perso la chiave non può firmare). Chiunque conosca un ownerId può avviare un recovery. Difesa: quorum + ritardo + cancel. Validare.
- `/recovery/finalize` è anonimo ma innocuo (ruota comunque verso la new_public_key già fissata; i controlli ritardo+quorum+no-inflight fanno il lavoro).
- Verificare che `new_public_key` sia IMMUTABILE dopo l'initiate (se modificabile, un attaccante potrebbe cambiare il target dopo che i contatti hanno approvato).
- Parte C: l'aggiornamento della fiducia locale deve avvenire SOLO per contatti che hanno effettivamente approvato, e verso la new_public_key immutabile — mai una chiave arbitraria fornita dal server.

---

## 6. Esito test parziale (sessione di analisi)

**Parte A: FATTA e committata (6b4851e).** InitiateSection ora chiede il vecchio ownerId via input invece di usare loadOwnerId() del device. Testo UI chiarito (scenario "telefono E seed persi"). tsc pulito. Fiducia contatti NON toccata.

**Flusso server initiate→approve→finalize: VALIDATO (test parziale, ritardo forzato).**
- Avviato recovery da device con Parte A, inserito ownerId di T1 (usr_mglsq2pN0o).
- Contatti hanno approvato (quorum raggiunto).
- unlock_at forzato a 0 nel DB (bypass ritardo 7gg, trucco dev).
- finalize eseguito: `users.public_key` ruotata correttamente alla new_public_key (verificato: user.public_key === rec.new_public_key, finalized=1).
- CONCLUSIONE: la meccanica server della rotazione funziona.

**Muro della Parte C: CONFERMATO empiricamente.**
- Dopo la rotazione, T1 (che aveva la chiave A) non può più armare: il server riconosce come owner la chiave B, non più A. I device con la vecchia relazione di fiducia sono disallineati.
- Questo conferma il Difetto 2: la rotazione lato server NON aggiorna la fiducia locale dei contatti (verified_owner_key resta A). Serve la Parte C per riallineare.

**Caveat del test:** lo scenario "device nuovo con seed nuova" NON è stato simulato pulito — la new_public_key usata (034abb...) era un'identità già esistente nello scenario, non una chiave vergine. Il DB e i telefoni sono ora in stato "sporco" (identità mescolate, rotazione senza Parte C).

**Per la prossima sessione (Parte C + D):**
1. RIPARTIRE da DB e telefoni PULITI (reset completo: cancella sentinella.db*, ricrea, cancella dati app sui 3 telefoni, rifai onboarding + pairing con verifica di persona).
2. Simulare pulito: un device dedicato (o T1 resettato) con una seed NUOVA = chiave B vergine. Gli altri due = contatti che approvano.
3. Implementare Parte C (vedi sezione 4): endpoint /recovery/status che per un contatto che ha approvato ritorna {finalized, newPublicKey}; l'app del contatto, alla finalizzazione, aggiorna verified_owner_key da A a B SOLO se ha approvato E verso la new_public_key immutabile. Verificare prima che new_public_key sia immutabile dopo l'initiate.
4. Test E2E completo: dopo il recovery, il contatto DEVE poter operare per il nuovo owner (B) senza "chiave non verificata".
5. Poi Parte E (UI quorum recovery_k), l'obiettivo originale di C3 fase 2.
