# Sentinella

Un *dead man's switch* civico, end-to-end encrypted. Ogni X la Sentinella chiede «tutto ok?».
Se smetti di rispondere (arresto, sparizione), parte una richiesta di rilascio verso i tuoi
contatti fidati: quando almeno **k** di loro approvano, la documentazione preparata a freddo
viene decifrata e consegnata.

Questo repo è uno **scaffold** completo e coerente, pensato per essere aperto e completato in
**Claude Code**. Le parti critiche (crittografia, scheduler, pairing, push) sono implementate;
alcune schermate sono intenzionalmente minime e marcate `TODO` per essere rifinite.

---

## Principi non negoziabili

1. **Zero-knowledge.** Il server non vede mai i contenuti né le chiavi per decifrarli. Conserva
   solo: chiavi pubbliche, push token, puntatori al drive, **quote cifrate** della chiave, e stato.
2. **Soglia k-su-N.** La chiave del pacchetto (DEK) è spezzata con Shamir. Nessun singolo
   contatto — e nessun server sequestrato — può rilasciare da solo. Consigliato: 2-su-5 o 3-su-7.
3. **Identità da seed phrase.** Le chiavi nascono da 12 parole BIP39, derivate in modo
   deterministico. Stesse parole → stessa chiave su qualunque OS. Migrazione Android↔iPhone gratis.
4. **Pairing di persona.** I contatti si aggiungono scansionando un QR faccia a faccia
   (verifica out-of-band): nessun man-in-the-middle possibile.
5. **Il battito sta sul server.** Su mobile i timer in background non sono affidabili: è il
   backend a tenere il "visto l'ultima volta", a mandare la push «tutto ok?» e a scatenare
   l'escalation. L'app deve solo *reagire alle push*.
6. **Le push non contengono segreti.** Apple/Google vedono passare le notifiche → nel payload
   ci va solo «apri l'app». La quota cifrata da approvare si scarica su TLS e si decifra sul device.
7. **I file cifrati vivono su un drive esterno** scelto dall'utente; il server tiene solo il link.

---

## Mi serve un Mac per fare l'app iPhone?

**No, non per forza.** Con Expo EAS Build le build iOS girano nel cloud macOS di Expo e si
lanciano da Windows/Linux; EAS Submit carica le build iOS allo store anche da non-Mac.

Però:
- Serve un **account Apple Developer a pagamento** (99 $/anno) per ogni build che gira su un
  iPhone fisico e per TestFlight/App Store. Non aggirabile.
- L'unico percorso che *richiede* un Mac è la build locale senza account a pagamento.
- Android non richiede nulla di Apple.
- Un Mac resta comodo (simulatore iOS, debug nativo) ma non è un prerequisito.

---

## Struttura

```
sentinella/
  server/   API "postino" + scheduler (Node + TypeScript + Fastify + SQLite)
  app/      App mobile (Expo / React Native, un solo codice per iOS e Android)
```

### server/
| File | Ruolo |
|------|------|
| `src/index.ts` | bootstrap Fastify, registra le route |
| `src/db.ts` | schema SQLite + helper (zero plaintext) |
| `src/routes/pairing.ts` | invito + accoppiamento di persona |
| `src/routes/switch.ts` | crea / arma / disarma / configura lo switch |
| `src/routes/checkin.ts` | heartbeat: «tutto ok» |
| `src/routes/vault.ts` | salva puntatore drive + quote cifrate (mai contenuto) |
| `src/routes/approvals.ts` | raccolta approvazioni a soglia |
| `src/services/scheduler.ts` | **il battito**: tick periodico, escalation, trigger |
| `src/services/pushSender.ts` | invio push via Expo (nessun segreto nel payload) |

### app/
| File | Ruolo |
|------|------|
| `lib/crypto.ts` | **il cuore**: identità da BIP39, ECDH seal/open, Shamir k-su-N |
| `lib/keystore.ts` | custodia chiave privata (Keychain/Keystore via expo-secure-store) |
| `lib/api.ts` | client REST verso il server |
| `theme.ts` | design tokens (palette calma, superfici pulite) |
| `app/index.tsx` | onboarding: crea identità + mostra seed |
| `app/home.tsx` | dashboard battito: stato + «tutto ok» |
| `app/contacts.tsx` | lista contatti + aggiungi amico |
| `app/add-friend.tsx` | mostra QR / scansiona QR (pairing di persona) |
| `app/compose.tsx` | messaggio + allegati + soglia, cifra e arma |
| `app/approve.tsx` | schermata di approvazione per i contatti |

---

## Setup rapido

### Server
```bash
cd server
npm install
npm run dev          # http://localhost:4000  (SQLite, zero config)
```

### App
```bash
cd app
npm install
npx expo start       # apri con Expo Go (Android/iOS) per sviluppare
```
Imposta l'URL del server in `app/lib/api.ts` (default `http://localhost:4000`; su device fisico
usa l'IP del tuo computer, non `localhost`).

---

## Da fare con Claude Code (playbook)

Apri il repo in Claude Code e procedi così, una fetta per volta:

1. **Crypto prima di tutto.** Chiedi a Claude Code di scrivere test per `app/lib/crypto.ts`:
   round-trip seal/open, split/combine Shamir con k quote, derivazione deterministica
   (stesse 12 parole → stessa chiave pubblica). Non procedere finché i test non passano.
2. **Pairing.** Completa `add-friend.tsx`: generazione QR (libreria `react-native-qrcode-svg`)
   e scanner (`expo-camera`). Verifica che dopo lo scan entrambi abbiano la chiave dell'altro.
3. **Push reali.** Crea il progetto Firebase (FCM), configura `expo-notifications`, registra il
   token in `/push/register`. Testa con `pushSender.ts` (parte in modalità log finché non metti le credenziali).
4. **Scheduler.** Verifica il ciclo in `scheduler.ts`: check-in → grace → APPROVAL_PENDING →
   raccolta quote → RELEASED. Abbassa gli intervalli a pochi secondi per testare.
5. **Drive esterno.** Implementa l'upload OAuth verso Google Drive (o S3) in un modulo `lib/drive.ts`;
   il server deve ricevere **solo il puntatore**.
6. **Rifinitura UI.** Completa `compose.tsx` (file picker via `expo-document-picker` /
   `expo-image-picker`) e lo stile delle schermate seguendo `theme.ts`.
7. **Hardening.** Sposta la chiave privata nel Secure Enclave/StrongBox dove possibile, tieni il
   seed come solo percorso di recupero; aggiungi rate-limiting e audit log firmato lato server.

> ⚠️ Questo scaffold dimostra l'architettura corretta. Prima di affidargli vite reali serve un
> audit di sicurezza indipendente, librerie crypto auditate, e un threat model formale
> (coercizione, sequestro del device, occultamento completo dei metadata).

---

## Aggiornamento: recovery via browser + occultamento metadata

### web/ — console di recupero
`web/recovery-console.html` è una pagina autonoma: la apri da qualsiasi browser, inserisci la
**seed phrase**, e riprendi il controllo dello switch (tutto ok / blocca / disarma). Funziona
perché l'identità è ri-derivata dalle 12 parole: nessun account da recuperare.

Autenticazione **passwordless a firma** (niente password sul server):
1. il client deriva la chiave dalla seed (in locale, le parole non lasciano la pagina);
2. chiede una sfida (`/auth/challenge`) e la firma (ECDSA P-256);
3. il server verifica la firma contro la chiave pubblica nota (`/auth/verify`) e apre una sessione.

> Verificato in test: la console deriva **la stessa chiave** dell'app, e la firma del browser
> è validata lato server con `@noble`.

Caso peggiore (persa anche la seed) → **recovery sociale**, ancora da progettare con cura:
deve poter solo mettere in pausa/proteggere (direzione *fail-safe*), mai ricreare contenuti, e
restare separato dalle quote di rilascio, perché un recovery che disarma è anche un'arma di coercizione.

### Occultamento dei metadata
Il server **non** sa più quale quota appartenga a quale contatto, né quante quote reali esistano:
- le quote sono **blob opachi**; tra quelle reali sono mescolate delle **esche** indistinguibili,
  fino a un totale fisso (default 8) → il server non conosce N reale né, di fatto, k;
- al rilascio il contatto scarica **tutti** i blob (`/shares`) e trova il proprio per
  **trial decryption** (prova ad aprirli con la sua chiave privata) → il server non vede la mappa
  contatto↔quota;
- la tabella `shares` non contiene più `contact_id`.

Resta da fare per l'occultamento completo: scorrelare i push token dall'appartenenza alle quote,
nascondere anche `k`, attenuare il pattern temporale dei check-in, e (per i casi estremi) consegna
anonima via Tor/onion.

### Test crypto inclusi
`app/lib/crypto.test.ts` copre: derivazione deterministica (migrazione OS), seal/open ECDH,
Shamir k-su-N, trial decryption con esche. Esegui con `cd app && npm run test:crypto`.

---

## Aggiornamento 2: recovery sociale + occultamento (ultimo miglio)

**Soglia k nascosta al server.** Il server non riceve più `k`: resta solo lato client (serve a
`splitSecret`). Il contatto che approva ricombina le quote raccolte e prova a decifrare il contenuto;
se decifra, la soglia è raggiunta e conferma il rilascio (`/release/confirm`). Il server non sa quante
quote servano.

**Jitter sui check-in.** `next_check_at` ha un jitter ±15% (`withJitter`), così il ritmo dei
controlli non è un orologio leggibile dal server. (Mitigazione parziale: l'occultamento temporale
completo richiede logica client-side / cover traffic.)

**Recovery sociale fail-safe** (`server/src/routes/recovery.ts`): un quorum di contatti, dopo un
ritardo obbligatorio, può solo **ruotare la chiave pubblica** del proprietario (nuova seed su nuovo
device). Non disarma, non rilascia; lo switch continua a girare; bloccato se un rilascio è in corso;
annullabile da chi possiede ancora la chiave attuale (`/recovery/cancel`). Quorum `recovery_k` sul record utente.

Vedi `PROMPT-CLAUDE-CODE.md` per il brief operativo completo.
