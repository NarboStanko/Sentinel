# Sentinella — Design del sottosistema Attuatori

> [🇬🇧 English](ACTUATOR_DESIGN.md) · 🇮🇹 Italiano

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

---

## 9. Sistema di pagamento — licenza firmata manuale

### Modello scelto
Pagamento **completamente disaccoppiato** dallo sblocco della feature (massima privacy, zero commissioni store, zero infrastruttura di billing):
1. L'utente paga **fuori dall'app**, come preferisce/può: Monero, voucher/codici acquistabili altrove (anche in contanti o tramite un'organizzazione), bonifico, ecc.
2. L'utente **contatta** (es. via mail) per ottenere lo sblocco.
3. Si emette manualmente una **licenza firmata** (codice) che l'utente inserisce in un campo "riscatta codice" nell'app.
4. L'app **verifica la firma** con la chiave pubblica dell'emittente (embedded nell'app). Nessun server di billing, nessun legame automatico tracciabile tra account app e pagamento.

### Durata
Codice **a tempo**, a scaglioni: **1 / 2 / 3 / 5 anni**. Riduce la frequenza di rinnovi manuali. Coerente con "il pagamento non è single-point-of-failure": la licenza abilita la CONFIGURAZIONE di nuovi attuatori; gli switch già armati funzionano per sempre anche a licenza scaduta.

### Forma crittografica della licenza (sicurezza)
La licenza NON è un codice indovinabile o condivisibile a piacere: è una **licenza firmata**.
- L'emittente ha una coppia di chiavi dedicata (privata custodita, pubblica embedded nell'app).
- Il codice è una **firma** su un payload tipo: `{ scope: "actuators", validUntil: <data>, ... }` (+ eventuale binding, vedi sotto).
- L'app verifica la firma con la pubblica embedded → codice non falsificabile né generabile da terzi.
- Stesso principio crittografico (firma asimmetrica) già usato ovunque in Sentinella. Riusa `@noble`.

### Nodi aperti sulla licenza [DA DECIDERE]
- **Binding**: la licenza è legata a un'identità/dispositivo (non condivisibile) o è "bearer" (chi ce l'ha la usa)?
  - Bearer = più privacy (nessun dato dell'utente nella licenza) ma condivisibile/rivendibile.
  - Binding all'ownerId/pubkey = non condivisibile ma lega la licenza all'identità (meno privacy).
  - Trade-off privacy vs anti-condivisione da valutare. Per uno strumento pro-privacy, il bearer potrebbe essere accettabile (la feature è di nicchia, la condivisione è limitata).
- **Revoca**: se una licenza viene abusata, come si revoca senza un server? (lista di revoca embedded negli update dell'app? o si accetta che non sia revocabile?)
- **Policy store**: l'app deve avere SOLO un campo "riscatta codice", SENZA indirizzare al pagamento esterno dentro l'app (le policy Apple/Google vietano di linkare a pagamenti esterni per beni digitali). Pagamento e istruzioni vivono FUORI (sito/README). Il campo di riscatto è come riscattare una gift card — generalmente tollerato.

### Perché questo modello per Sentinella
- Massima privacy dell'utente (pagamento e identità-app scollegati).
- Zero commissioni store, zero infrastruttura di billing.
- Coerente con la scala iniziale (pochi utenti premium → gestione manuale fattibile).
- L'utente a rischio ESTREMO non paga comunque: usa il core gratuito/self-hosted. Chi paga è l'utente meno a rischio → la tracciabilità residua è meno critica.
- Contro: non scala automaticamente (bel problema da avere; si automatizza dopo), latenza dello sblocco (accettabile per feature non-urgente).

---

## 10. Modello di attivazione multi-relè (approfondimento)

### Un solo segnale (Scenario A)
In Sentinella il rilascio è **atomico e binario**: lo switch scatta (RELEASED) o no; quando k contatti approvano si sblocca TUTTO il pacchetto. Non esistono rilasci parziali o graduati. Quindi c'è **un solo momento di attivazione** → **un solo segnale** per l'attuatore. Segnali distinti per relè distinti (Scenario B) sarebbero potenza inutilizzabile (non c'è un evento distinto che li generi). La ricchezza sta nella **configurazione per-relè**, non in segnali multipli.

### Numero di relè configurabile
Il numero di relè NON è fisso: l'utente collega da 1 a N relè (l'ESP32 ha molti GPIO). La config è una **lista di definizioni di relè**; aggiungere un relè = aggiungere una voce con il suo pin e la sua config. Il firmware itera sulla lista quando arriva il segnale.

### Parametri per singolo relè
- **Pin GPIO** a cui è collegato (l'utente sa dove attaccare i fili).
- **Modalità**: impulso (scatta per N secondi poi torna) | latch (scatta e resta).
- **Durata** (per impulso).
- **Ritardo** prima di attivarsi → permette di orchestrare una SEQUENZA da un unico segnale (relè 1 a t=0, relè 2 a t=10s, relè 3 a t=60s).
- **NO/NC** (normalmente aperto / normalmente chiuso).
- **Idempotenza (vedi sotto)**: una-volta-sola | mantieni-stato.

### Idempotenza / comportamento al riavvio
Due livelli:
- **Il firmware** ha la CAPACITÀ di entrambi i comportamenti (logica + memoria persistente NVS/flash per ricordare "rilascio già eseguito").
- **La config** (paginetta/file) espone all'utente la SCELTA per-relè.

Comportamenti (il firmware base supporta ENTRAMBI, scelta per-relè):
- **Una-volta-sola**: l'attuatore ricorda in memoria persistente di aver già eseguito quel rilascio e NON ripete ai riavvii successivi. Corretto per azioni-evento (un impulso, apri una serratura una volta). Default consigliato.
- **Mantieni-stato**: il relè riflette lo stato "RELEASED" finché dura (es. tieni un circuito aperto/chiuso finché lo switch è RELEASED). Per usi in cui l'attivazione è uno stato continuo, non un evento.

### Stato al boot (sicurezza/robustezza — CRITICO)
Al boot/riavvio dell'ESP32 i relè NON devono scattare per sbaglio (un black-out momentaneo → riavvio non deve simulare un'attivazione). Il firmware deve:
1. Inizializzare ogni relè nello stato di riposo (secondo NO/NC) PRIMA di entrare in polling.
2. Distinguere "sto ripartendo pulito" da "ho già ricevuto il segnale" (flag persistente).
3. Attivare i relè SOLO se riceve/ha ricevuto il segnale valido, mai per il solo fatto di essersi acceso.

### Configurazione: paginetta web + file JSON
- **Paginetta web** (access point ESP32): user-friendly, percorso base, l'utente non tocca file.
- **File JSON caricato** (es. `relays.json`): per l'avanzato — versionabile, replicabile (configurare 8 relè identici copiando un file invece di cliccare 8 volte).
- Offrire entrambi.

### Note pratiche firmware (per l'implementazione)
- **Pin sicuri**: non tutti i GPIO sono uguali (alcuni solo-input, alcuni strapping-pin che al boot possono impedire l'avvio se pilotati, alcuni assenti su certi moduli). Il percorso base dovrebbe PRE-SUGGERIRE una lista di pin sicuri, non lasciare campo libero (un principiante non sa quali evitare).
- **Alimentazione relè**: più relè = più corrente; i moduli relè si alimentano a parte (i pin ESP32 pilotano solo il segnale). Nota per la documentazione utente.

---

## 11. Registrazione sicura della chiave dell'attuatore

### Modello scelto: fiducia sul possesso fisico
A differenza dei contatti (dove si verifica l'identità di una controparte umana remota con il safety number), l'attuatore è un **oggetto dell'utente**, configurato a freddo in un momento e luogo che l'utente controlla. In quel contesto, il **possesso fisico È la radice di fiducia**: non c'è controparte da verificare, c'è l'utente e il suo dispositivo. Un safety number qui sarebbe teatro, non sicurezza (verificheresti che la chiave dell'oggetto-in-mano corrisponde all'oggetto-in-mano).

Principio: non aggiungere cerimoniale di sicurezza dove non aggiunge sicurezza reale.

### Assunzioni esplicite (da documentare per l'utente)
Il modello si fida del MOMENTO del setup. Assunzioni:
1. **Hardware fidato (supply chain)**: l'ESP32 non è compromesso a monte. Mitigazione: hardware da fonti fidate, l'utente flasha lui stesso il firmware (sa cosa gira), possibilità di verificare il firmware.
2. **Ambiente di setup sicuro**: nessun osservatore/interferenza durante la configurazione (no malware sul telefono che registra, no ripresa). Setup in ambiente controllato.
3. **RNG hardware**: il firmware DEVE generare la chiave con l'RNG hardware dell'ESP32 (che ne ha uno), non un seed prevedibile. Requisito firmware — una chiave da RNG debole è indovinabile a prescindere dalla registrazione.

### Igiene del canale (anche fidandosi del possesso)
La chiave pubblica dell'ESP32 va trasmessa all'app via **canale locale diretto** (QR mostrato/letto dal dispositivo, oppure USB), **mai wifi in chiaro sulla rete**. Non per verificare (ci si fida del possesso), ma per non introdurre gratuitamente un punto di intercettazione. È igiene, non cerimoniale.

### Limiti (onesti)
- NON copre un avversario che manomette la supply chain del dispositivo (ESP32 taroccato prima del setup).
- NON copre un ambiente di setup compromesso.
- Per threat model estremi (avversario statale con capacità supply-chain), l'utente avanzato può fare verifiche aggiuntive (build riproducibili del firmware, attestazione), ma NON è il caso base.
- Per il caso d'uso normale (utente configura il proprio dispositivo in un ambiente che controlla), il modello è adeguato.

---

## 11-bis. Registrazione via USB — decisione finale

Aggiornamento/precisazione della §11: il canale di registrazione è l'**USB**, con safety number come conferma.

### Perché USB
- L'USB dell'ESP32 trasporta dati **seriali** (testo), non video. Un safety number è testo → si può mostrare/leggere via seriale.
- È un **canale fisico diretto** (un cavo): niente radio/wifi/rete, il meno intercettabile in assoluto. Un man-in-the-middle richiederebbe accesso fisico al cavo durante il setup.
- **L'USB è già collegato durante il flashing del firmware.** Se il percorso base usa un flasher web (es. ESP Web Tools, flasha dal browser via USB), l'utente è già connesso via USB in quel momento. La chiave/safety number appare subito dopo il flash, sullo stesso canale, senza un passaggio in più. Questo rende la registrazione USB accessibile anche nel percorso base, non solo agli avanzati.

### Flusso
1. L'utente flasha il firmware via USB (flasher web o toolchain).
2. Appena flashato, l'ESP32 genera la sua coppia di chiavi (RNG hardware) e mostra la pubblica via seriale (il flasher/app la cattura).
3. L'app deriva e mostra un **safety number** dalle chiavi; l'ESP32 mostra/ha mostrato il proprio. L'utente conferma che coincidono.
4. La pubblica dell'attuatore è registrata in Sentinella.

### Nota sul safety number qui
Tecnicamente **ridondante** (il canale USB fisico è già praticamente non-intercettabile), ma il costo di implementarlo è minimo (stampare testo sul seriale) e dà una conferma esplicita rassicurante. Incluso come conferma, non come difesa necessaria — coerente col principio "non aggiungere cerimoniale dove non serve", ma qui il costo è così basso che il valore-tranquillità lo giustifica.

### Requisito firmware ribadito
La generazione della chiave DEVE usare l'**RNG hardware** dell'ESP32. Una chiave da RNG debole è indovinabile a prescindere dal canale di registrazione.

### Nota UX
La paginetta web dell'access point resta utile per la **configurazione dei relè** (§10), ma la **registrazione della chiave** avviene via USB (più sicuro e già disponibile al flash). Due canali per due scopi: USB per la chiave, paginetta/file per la config relè.

---

## 12. Stato di salute dell'attuatore (il cuore onesto della UX)

Poiché l'attuatore fa polling, il server sa **quando l'ha sentito l'ultima volta**. Questo permette di mostrare lo stato reale invece di promettere un'affidabilità non garantibile — impedisce all'utente la FALSA FIDUCIA ("il mio attuatore mi protegge" mentre è staccato da giorni). È la feature che rende il sottosistema onesto.

### Frequenza di polling
**Ogni 10 minuti.** Compromesso tra reattività (attivazione entro ~10 min dal RELEASED) e carico/consumo contenuti. (Il rilascio ha comunque ritardi di ore/giorni nel suo flusso, quindi 10 min è ampiamente reattivo abbastanza.)

### Soglie dello stato di salute
Il server conosce l'ultimo contatto; l'app deriva uno stato. Le soglie sono tolleranti verso ping saltati isolati (rete instabile, riavvio ESP32, server occupato) ma sensibili ai guasti reali. Taratura indicativa (da affinare con dispositivi veri):
- **Verde (sano)**: ultimo contatto < ~30 min (almeno un paio di ping recenti riusciti).
- **Giallo (attenzione)**: silenzio da ~30 min a qualche ora. "Qualcosa potrebbe non andare, tienilo d'occhio."
- **Rosso (probabilmente offline)**: silenzio da diverse ore (es. 6-12h+). "L'attuatore è quasi certamente offline, intervieni."

Principio: abbastanza tollerante da non gridare al lupo per ogni ping perso, abbastanza sensibile da avvisare prima che sia un problema serio.

### Notifiche
**Push all'allerta (passaggio a rosso), MA SOLO se lo switch è armato.**
Razionale: un attuatore offline conta davvero solo quando lo switch è armato — se è disarmato non c'è rilascio possibile, quindi l'attuatore offline non è un'emergenza. Notificare solo in stato armato:
- avvisa quando conta davvero (c'è qualcosa da attivare, e l'attuatore è morto),
- azzera il rumore quando non serve (switch disarmato).

Esempio notifica: "⚠ Il tuo attuatore non risponde da 8 ore. Lo switch è armato: controlla alimentazione e connettività."

### Visualizzazione in app
Nella lista attuatori, ogni attuatore mostra il suo stato (verde/giallo/rosso) e "ultimo contatto: X fa". Passivo (sempre visibile aprendo l'app) + push attivo all'allerta con switch armato.

### Nota
Questo meccanismo mitiga (non elimina) il limite strutturale dell'attuatore fisico (§3): può ancora cadere silenziosamente, ma ora l'utente lo VEDE e viene avvisato quando conta, e può intervenire (riavviare, controllare alimentazione, ecc.) invece di scoprire troppo tardi che non ha funzionato.
