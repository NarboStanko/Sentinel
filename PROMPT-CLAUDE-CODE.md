# Prompt per Claude Code — progetto Sentinella

Copia tutto questo come primo messaggio a Claude Code nella cartella del repo.

---

Stai lavorando a **Sentinella**, un *dead man's switch* civico end-to-end encrypted: un'app che
ogni X chiede all'utente «tutto ok?»; se l'utente smette di rispondere (arresto, sparizione), un
quorum di contatti fidati può rilasciare una documentazione preparata a freddo. È uno strumento
contro la sparizione forzata — le persone che lo useranno sono a rischio reale, quindi la
**sicurezza viene prima di qualsiasi feature**. In caso di dubbio, scegli l'opzione che fa
trapelare meno informazioni e che fallisce in modo sicuro.

## Invarianti di sicurezza — non violabili mai

1. Il server è solo un postino: **mai** contenuti in chiaro, **mai** chiavi di decrypt, **mai** la DEK.
2. L'identità nasce da una **seed phrase BIP39** (12 parole) ed è derivata in modo deterministico.
   Le parole non lasciano mai il dispositivo se non per firmare una sfida.
3. Rilascio a **soglia k-su-N** (Shamir). La soglia **k non è nota al server**: è il client a
   scoprire, ricombinando, se è stata raggiunta. Nessun singolo contatto né il server rilascia da solo.
4. Le quote sono **blob opachi** mescolati a **esche** indistinguibili; il contatto trova la propria
   per **trial decryption**. Il server non sa chi possiede cosa, né N reale.
5. Le **push non contengono segreti** (Apple/Google le vedono): solo «apri l'app».
6. Il **battito è server-side** (i timer in background mobile non sono affidabili); l'app reagisce alle push.
7. Il **recovery sociale è fail-safe**: può solo ruotare l'identità del proprietario sotto quorum +
   ritardo + notifica. **Non disarma e non rilascia mai.** È annullabile da chi ha ancora la chiave attuale.
8. Il contenuto cifrato vive su un **drive esterno** scelto dall'utente; il server tiene solo il puntatore.
9. **Child safety / abuso**: non aggiungere nessun canale che permetta di usare lo strumento per
   sorvegliare, geolocalizzare o ricattare terzi. Il rilascio va solo verso contatti che l'utente ha
   aggiunto di persona.

## Stato attuale (già fatto e verificato)

- `app/lib/crypto.ts` — **testato** (`npm run test:crypto`): derivazione deterministica da seed,
  ECDH seal/open (XChaCha20-Poly1305), Shamir k-su-N, trial decryption con esche. Usa `@noble/*` e `@scure/bip39`.
- `server/` (Fastify + SQLite) **compila pulito**: pairing di persona, switch, check-in con **jitter**,
  quote **opache** (`/shares`), approvazione con **k nascosto** + `/release/confirm`, auth passwordless
  a firma (`/auth/challenge` + `/auth/verify`), recovery sociale (`/recovery/initiate|approve|finalize|cancel`),
  scheduler (battito), `/dev/blob` (storage di sviluppo da sostituire).
- `web/recovery-console.html` — console di recupero via browser, **verificata** (deriva la stessa chiave
  dell'app, firma validata dal server).
- App RN/Expo: schermate onboarding/home/contacts/add-friend/compose/approve con design system
  (`theme.ts`, `components/ui.tsx`). Le parti che richiedono un device fisico sono marcate `TODO`.

## Stack
Expo (React Native) un solo codice iOS+Android · backend Node+TS+Fastify+SQLite · crypto `@noble/curves`,
`@noble/ciphers`, `@noble/hashes`, `@scure/bip39`. iOS: build via EAS (account Apple Developer richiesto;
Mac utile ma non obbligatorio).

## Compiti, in ordine. Per ognuno: scrivi prima i test, poi l'implementazione.

1. **Blindare la crypto.** Estendi `app/lib/crypto.test.ts`: vettori di test fissi (mnemonic→pubkey
   note), proprietà (combinare <k quote fallisce, =k e >k riescono), fuzz su lunghezze contenuto.
   Valuta la sostituzione dello Shamir fatto a mano con una libreria auditata; mantieni l'API.

2. **Pairing reale.** In `app/app/add-friend.tsx`: genera il QR con `react-native-qrcode-svg`
   (payload = `{token, ownerPublicKey}`), e lo scanner con `expo-camera`. Dopo lo scan, il contatto
   salva `ownerPublicKey` (verificata di persona) e chiama `/pair` con la propria pubkey + push token.
   Accettazione: due dispositivi si accoppiano; l'owner vede il contatto in lista.

3. **Push reali, senza segreti.** Progetto Firebase (FCM), `expo-notifications`, registra il token
   con `/push/register`. In `pushSender.ts` collega le credenziali. Verifica che il payload non
   contenga mai dati sensibili. Gestisci il deep-link push→schermata `approve`/`home`.

4. **Storage esterno reale.** Implementa `app/lib/drive.ts` con OAuth verso Google Drive (o S3):
   `uploadEncrypted` carica il ciphertext sul drive dell'utente e restituisce il puntatore; il server
   deve continuare a ricevere **solo** il puntatore. Rimuovi `/dev/blob`.

5. **Allegati.** In `compose.tsx`: `expo-document-picker` + `expo-image-picker`; includi i file nel
   manifest cifrato; in `approve.tsx` ripristina anteprime immagini e download file dopo il rilascio.

6. **Recovery sociale — UI.** Nella console web e/o in una schermata app: l'owner avvia `/recovery/initiate`
   da una nuova identità; i contatti approvano firmando il recoveryId (`/recovery/approve`); mostra il
   ritardo e lo stato; `/recovery/finalize` quando maturo; esponi `/recovery/cancel` per chi ha la chiave attuale.
   Accettazione: rotazione identità sotto quorum+ritardo; bloccata se uno switch è in rilascio; annullabile.

7. **Hardening.** Gate delle mutazioni dietro la sessione di `/auth/verify` (token); rate-limiting;
   audit log firmato; chiave privata nel Secure Enclave/StrongBox con la seed come unico recupero;
   `duress PIN` (un check-in sotto coercizione che simula «tutto ok» ma accelera/segnala). Occultamento
   ulteriore: scorrelare i push token dall'appartenenza alle quote; valutare consegna anonima (Tor/onion).

8. **Affidabilità del battito.** Scheduler resiliente (job queue persistente, retry, idempotenza),
   health-check, e test che simulano: check-in mancato→grace→approval; ripristino dopo riavvio del server.

## Cosa NON fare
- Non mettere mai contenuti/chiavi/DEK nel database del server o nei payload push.
- Non far conoscere al server la soglia k.
- Non dare al recovery (né a un quorum di contatti) il potere di disarmare o rilasciare.
- Non aggiungere account/login con password: l'auth è solo a firma dalla seed.
- Non introdurre funzioni di tracciamento/geolocalizzazione di terzi.

## Come verificare
```
cd server && npm install --legacy-peer-deps && npm run dev
cd app && npm install --legacy-peer-deps && npm run test:crypto && npx expo start
```
Apri `web/recovery-console.html` e prova: seed → accesso → tutto ok / disarma.

## Prima dell'uso reale
Questo è uno scaffold. Prima di affidargli vite umane serve un **audit di sicurezza indipendente**,
librerie crypto auditate, un threat model formale (coercizione, sequestro del device, occultamento
completo dei metadata) e una revisione legale sul contenuto rilasciabile.
