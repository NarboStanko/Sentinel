# Sentinella — Design del sottosistema Attuatori

Documento di design (su carta). Da implementare a fasi, dopo l'audit professionale (come da THREAT_MODEL). Raccoglie le decisioni prese; i punti aperti sono marcati [DA DECIDERE].

## 1. Principio guida

Sentinella **consegna un segnale**, non compie azioni fisiche. Cosa fa l'attuatore col segnale è responsabilità dell'utente. Questo scarica Sentinella dalla responsabilità dell'azione fisica, massimizza la flessibilità, e riduce la superficie di codice/attacco.

**Principio UX cardine:** un attuatore che l'utente crede affidabile ma non lo è, è peggio di nessun attuatore. La UX non deve vendere sicurezza: deve comunicare onestamente cosa fa e cosa no. In particolare i limiti (dipendenza da alimentazione e connettività) vanno comunicati nel flusso, non nascosti in un disclaimer.

## 2. Modello di sicurezza (riusa il meccanismo esistente)

Il segnale di attivazione è **un contenuto del pacchetto come gli altri** (documenti/foto), non un canale separato:
- È un **blob piccolo** (token ~32 byte), cifrato per la **chiave pubblica dell'attuatore**.
- Protetto dalla **stessa soglia Shamir** dei contenuti: si sblocca solo al quorum (k contatti approvano).
- Trasportato dal server come blob opaco (il server non lo legge né può fabbricarlo).
- Rilasciato al `RELEASED` come gli altri contenuti.

**Proprietà risultanti:**
- Il server non può attivare l'attuatore (non ha le quote).
- Un singolo contatto non può attivare (serve il quorum).
- Anche i contatti che vedono il contenuto rilasciato non possono usare il segnale (è cifrato per la chiave dell'attuatore; solo l'attuatore lo decifra).
- Un segnale falso non contiene il token valido → l'attuatore non agisce.
- La sicurezza dell'attivazione eredita quella del rilascio contenuti (già auditata).

## 3. Trasporto

- **Caso base: IP polling.** Il server ha IP fisso; è l'**attuatore a interrogare il server** ("c'è il mio blob? lo switch è RELEASED?"). Il server risponde col blob solo a stato `RELEASED` (stesso gate dei contatti). L'attuatore decifra con la sua chiave privata, verifica, agisce.
- Il trasporto è **pluggabile**. Essendo il segnale piccolo (~32 byte), è trasportabile anche su **Meshtastic (LoRa mesh)** per scenari anti-censura (blackout di internet). Gateway IP↔mesh [DA DECIDERE, fase successiva].

**Nota sul polling (onesta):** un ESP32 dedicato in polling è robusto nel caso normale — riconnessione wifi automatica, consumo bassissimo, dispositivo mono-funzione. I punti deboli reali: (a) black-out elettrico prolungato → mitigabile con UPS/batteria; (b) riavvio rete → non è un problema, si riconnette; (c) infrastruttura sequestrata/spenta quando l'utente sparisce → NON risolvibile via firmware, è il paradosso del dead-man's switch sull'hardware; qui la risposta è Meshtastic e/o posizionare il dispositivo altrove (es. da un contatto). Da documentare come limite.

## 4. UX — due livelli

### Percorso base guidato ("Collega un attuatore")
Per utenti ragionevolmente capaci (sanno usare un cavo USB, seguire istruzioni), senza programmare. Deve portare a un attuatore FUNZIONANTE, non a un assaggio.

Flusso wizard:
1. **Cosa serve** — onesto: ESP32, cavo, ~15 min. "Riceve un segnale quando lo switch scatta; cosa fa lo decidi tu." + limite dichiarato subito ("funziona solo se resta alimentato e connesso").
2. **Firmware pronto** — firmware precompilato per relè, flashabile senza toolchain (idealmente flasher web via USB, tipo ESP Web Tools). Vedi §5.
3. **Accoppiamento** — l'ESP32 genera la sua coppia di chiavi e mostra la pubblica (display / access point con paginetta / QR). L'app la registra. Stesso pattern del pairing contatti.
4. **Test** — pulsante "prova l'attuatore": manda un segnale di TEST (non un rilascio vero), l'utente vede il relè scattare e conferma che funziona. Essenziale.
5. **Stato** — l'attuatore appare in lista col suo stato di salute (§6).

### Livello avanzato
Per chi scrive il proprio firmware. Si fornisce:
- Specifica del protocollo (endpoint polling, formato blob, come decifrare/verificare il token con la chiave dell'attuatore).
- Libreria/SDK di riferimento (codice di verifica del segnale da integrare).
- Opzioni di trasporto (IP polling ora, Meshtastic in futuro).
- Controllo totale su cosa fare dopo la verifica.

Il base è un caso particolare (il più comune) dell'avanzato.

## 5. Firmware relè (base)

Firmware precompilato fornito da noi. **Multi-relè, configurabile per-relè (modalità B).**

Parametri per singolo relè:
- **Modalità**: impulso (scatta per N secondi poi torna) | latch (scatta e resta).
- **Durata** (per modalità impulso).
- **Ritardo** prima di attivarsi (per scaglionare le azioni tra relè).
- **Normalmente aperto / normalmente chiuso** (NO/NC).

**Dove si configura:** sull'ESP32 direttamente, via **paginetta web** esposta dal suo access point (pattern IoT collaudato). L'app Sentinella NON conosce i dettagli dei relè: registra la chiave e monitora lo stato. Firmware autonomo, config vive sull'ESP32.

Modello di attivazione dei relè: [DA DECIDERE — probabilmente "un segnale valido → tutti i relè eseguono la propria config (modalità/durata/ritardo)". Segnali distinti per relè distinti = territorio avanzato.]

## 6. Stato di salute (il cuore onesto della UX)

Poiché l'attuatore fa polling, il server sa **quando l'ha sentito l'ultima volta**. L'app mostra lo stato:
- "Ultimo contatto: 2 minuti fa ✓"
- "⚠ Nessun contatto da 3 giorni — l'attuatore potrebbe essere offline."

Trasforma un limite (l'attuatore può cadere silenziosamente) in qualcosa di visibile e gestibile. Rende il sistema onesto: mostra lo stato reale invece di promettere affidabilità. [DA DEFINIRE: soglie di allerta, se/come notificare l'utente quando un attuatore tace troppo a lungo.]

## 7. Punti aperti
- Gateway IP↔Meshtastic (fase successiva).
- Modello di attivazione multi-relè (tutti insieme vs indirizzabili).
- Soglie e notifiche dello stato di salute.
- Schema dati lato server per registrare attuatori e il loro blob (probabilmente tabella dedicata `actuator_*`, separata da switch_contents per polling mirato ed efficienza — l'ESP32 non deve scaricare documenti/foto pesanti).
- Come l'ESP32 espone/registra la pubblica in modo sicuro (verifica di persona? QR firmato?).
- Pagamenti / posizionamento come feature premium [prossima discussione].

---

## 8. Modello di sostenibilità e pagamenti

### Principio etico cardine
**La sicurezza di base di una persona a rischio non può stare dietro un paywall.** Il core di sicurezza (dead-man's switch, check-in, rilascio ai contatti, crittografia, Shamir, verifica di persona, duress PIN, recovery) è e resta **gratuito e open source** per tutti. Poiché il codice è AGPL, la sicurezza è sempre disponibile a chi è disposto a self-hostare/auto-costruire: si paga la COMODITÀ di non farlo, mai la protezione.

### Cosa è gratis / cosa è a pagamento
- **Gratis (sicurezza essenziale):** tutto il core. + il *protocollo* attuatori aperto (un utente avanzato costruisce e gestisce il proprio attuatore senza pagare).
- **A pagamento (comodità/servizio):** il **servizio attuatori** erogato come abbonamento ricorrente — firmware relè pronto, configurazione guidata, e soprattutto l'**hosting del polling/infrastruttura**. Modello: premium *come servizio*, non acquisto una-tantum (reddito ricorrente, più sostenibile).

### Principio: il pagamento non è MAI un single-point-of-failure nella sicurezza
**Uno switch armato con attuatore resta protetto anche se l'abbonamento scade.** L'abbonamento abilita la CONFIGURAZIONE e l'armamento di (nuovi) attuatori; una volta armato, lo switch funziona per sempre, indipendentemente dallo stato del pagamento.

Conseguenza tecnica: la verifica dell'abbonamento avviene al momento di **armare/configurare**, non al momento del **rilascio**. Il diritto viene "congelato" nello switch all'armamento; il percorso di rilascio (il momento critico) NON ricontrolla il pagamento — deve essere il più robusto e con meno dipendenze possibile. Questo è anche buona sicurezza: il rilascio non deve dipendere da un server di billing.

### Nodi aperti da affrontare [DA DECIDERE]
- **Tracciabilità dei pagamenti:** un attivista in regime ostile che paga con carta lascia una traccia ("usa uno strumento anti-sorveglianza"). Valutare pagamenti privacy-preserving (crypto? voucher? pagamento da parte di organizzazioni?), o accettare che il servizio a pagamento è per chi non è in quello scenario estremo (self-hosting gratuito per gli altri).
- **Commissioni store:** Play/App Store prendono 15-30% sui beni digitali e impongono il loro sistema di pagamento (tracciabile). Valutare se fatturare l'hosting fuori dall'app (sul web) dove le regole lo consentono.
- Prezzo, valuta, tier.

### Presentazione nell'app (principi)
- **Mai** un paywall che blocca una funzione di sicurezza. Nessun "sblocca la protezione". La protezione è già lì, gratis.
- La feature premium (attuatori) si presenta come **estensione opzionale** in una sezione "avanzate/estensioni", con prezzo chiaro e il *perché* (sostiene sviluppo e infrastruttura).
- **Trasparenza sul modello:** una schermata onesta — "Sentinella è gratis e open source. Il servizio attuatori è a pagamento per coprire i costi di infrastruttura. Se non puoi pagare, puoi self-hostare: ecco come."
- **Framing "sostieni + ottieni", non "compra".** Per uno strumento civico onesto, gli utenti vogliono sostenere; il pagamento è più simile a una donazione con beneficio che a una transazione estrattiva.
- [DA DEFINIRE: schermate concrete, punto di ingresso nel flusso, come mostrare il prezzo.]
