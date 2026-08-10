import {
  newSeedPhrase, isValidSeedPhrase, identityFromSeed,
  safetyNumber, signChallenge,
  sealTo, openWith, encryptContent, decryptContent,
  splitSecret, combineSecret, shareToWire, shareFromWire,
  sealShare, makeDecoy, tryOpenShare, findMyShare,
  bytesToHex, hexToBytes,
} from './crypto';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from '@noble/hashes/utils';

const enc = new TextEncoder(), dec = new TextDecoder();
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => {
  if (c) { pass++; console.log('  ✓', m); }
  else    { fail++; console.log('  ✗ FAIL:', m); }
};

// ══════════════════════════════════════════════════════════════════════
// 1) Seed phrase -> identita DETERMINISTICA
// ══════════════════════════════════════════════════════════════════════
console.log('1) Seed phrase -> identita DETERMINISTICA (migrazione OS)');
const m = newSeedPhrase();
console.log('   seed:', m);
ok(isValidSeedPhrase(m), 'la seed generata e valida (BIP39)');
const a = identityFromSeed(m);
const b = identityFromSeed(m);
ok(bytesToHex(a.pub) === bytesToHex(b.pub), 'stesse 12 parole -> stessa chiave pubblica');
ok(bytesToHex(a.priv) === bytesToHex(b.priv), 'stesse 12 parole -> stessa chiave privata');
const other = identityFromSeed(newSeedPhrase());
ok(bytesToHex(a.pub) !== bytesToHex(other.pub), 'seed diverse -> chiavi pubbliche diverse');

// ══════════════════════════════════════════════════════════════════════
// 2) ECDH seal/open
// ══════════════════════════════════════════════════════════════════════
console.log('2) ECDH seal/open (cifra per la chiave pubblica di un contatto)');
const contact = identityFromSeed(newSeedPhrase());
const secret = enc.encode('quota-segreta-🔑');
const sealed = sealTo(contact.pub, secret);
const opened = openWith(contact.priv, sealed);
ok(dec.decode(opened) === 'quota-segreta-🔑', 'il contatto apre con la SUA chiave privata');
let tampered = false;
try { openWith(a.priv, sealed); } catch { tampered = true; }
ok(tampered, 'una chiave diversa NON puo aprire');

// ══════════════════════════════════════════════════════════════════════
// 3) Contenuto cifrato + Shamir 2-su-3
// ══════════════════════════════════════════════════════════════════════
console.log('3) Contenuto cifrato + Shamir 2-su-3 (rilascio a soglia)');
const manifest = JSON.stringify({ text: 'Se leggete questo...', files: [{ name: 'dossier.pdf' }] });
const { dek, nonce, ct } = encryptContent(enc.encode(manifest));
const shares = splitSecret(dek, 3, 2);
ok(shares.length === 3, '3 quote generate');
const subset = [shares[0], shares[2]].map(shareToWire).map(shareFromWire);
const dek2 = combineSecret(subset);
ok(bytesToHex(dek2) === bytesToHex(dek), '2 quote su 3 ricostruiscono la DEK');
const back = dec.decode(decryptContent(dek2, nonce, ct));
ok(back === manifest, 'contenuto decifrato correttamente dopo la soglia');
const oneDek = combineSecret([shareToWire(shares[0])].map(shareFromWire));
ok(bytesToHex(oneDek) !== bytesToHex(dek), '1 sola quota NON ricostruisce la chiave');

// ══════════════════════════════════════════════════════════════════════
// 4) VETTORI FISSI — mnemonic noto → pubkey registrata
// ══════════════════════════════════════════════════════════════════════
console.log('4) Vettori fissi — derivazione deterministica cross-platform');
// Mnemonic BIP39 standard (abandon×11 + about).
// Valori registrati localmente il 2026-05-24; se cambiano, identityFromSeed e rotta.
const FIXED_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const FIXED_PUB_HEX  = '024ed395825486a3628176b579749981dca9927c319f6f7ad136d324931da0f661';
const fixedId = identityFromSeed(FIXED_MNEMONIC);
ok(bytesToHex(fixedId.pub) === FIXED_PUB_HEX,
  'vettore fisso: mnemonic noto → pubkey registrata (derivazione stabile)');
ok(isValidSeedPhrase(FIXED_MNEMONIC),
  'vettore fisso: mnemonic valido per BIP39');

// ══════════════════════════════════════════════════════════════════════
// 5) PROPRIETÀ SHAMIR — soglia k-su-N
// ══════════════════════════════════════════════════════════════════════
console.log('5) Proprietà Shamir: <k fallisce, =k e >k riescono');

function testShamirThreshold(label: string, n: number, k: number, secretLen = 32) {
  const sec = randomBytes(secretLen);
  const allShares = splitSecret(sec, n, k);
  ok(allShares.length === n, `${label}: generate ${n} quote`);

  // sub-threshold: ogni sottoinsieme size < k deve dare risultato sbagliato
  for (let size = 1; size < k; size++) {
    const bad = combineSecret(allShares.slice(0, size));
    ok(bytesToHex(bad) !== bytesToHex(sec),
      `${label}: ${size}/${k} quote (sub-soglia) non ricostruisce`);
  }

  // >= k: ogni sottoinsieme deve dare risultato corretto
  const tested = new Set<number>();
  for (const size of [k, Math.min(k + 1, n), n]) {
    if (tested.has(size)) continue;
    tested.add(size);
    const good = combineSecret(allShares.slice(0, size));
    ok(bytesToHex(good) === bytesToHex(sec),
      `${label}: ${size}/${k} quote ricostruisce correttamente`);
  }
}

testShamirThreshold('2-su-3', 3, 2);
testShamirThreshold('3-su-5', 5, 3);
testShamirThreshold('4-su-7', 7, 4);
testShamirThreshold('2-su-2', 2, 2);         // soglia = N
testShamirThreshold('1-su-3', 3, 1);         // k degenerativo (k=1)
testShamirThreshold('3-su-5 1B',  5, 3, 1);  // segreto 1 byte
testShamirThreshold('3-su-5 64B', 5, 3, 64); // segreto 64 byte

// ══════════════════════════════════════════════════════════════════════
// 6) FUZZ — lunghezze contenuto per seal/open e encryptContent
// ══════════════════════════════════════════════════════════════════════
console.log('6) Fuzz lunghezze contenuto: 0, 1, 15, 16, 17, 255, 256, 1024 bytes');

const fuzzId = identityFromSeed(newSeedPhrase());
for (const len of [0, 1, 15, 16, 17, 255, 256, 1024]) {
  const plain = len === 0 ? new Uint8Array(0) : randomBytes(len);

  // ECDH seal/open
  const blob = sealTo(fuzzId.pub, plain);
  const reopened = openWith(fuzzId.priv, blob);
  ok(bytesToHex(reopened) === bytesToHex(plain), `seal/open round-trip ${len}B`);

  // XChaCha20-Poly1305 diretto
  const { dek: dk, nonce: nc, ct: c } = encryptContent(plain);
  const decrypted = decryptContent(dk, nc, c);
  ok(bytesToHex(decrypted) === bytesToHex(plain), `encryptContent round-trip ${len}B`);
}

// ciphertext manomesso deve lanciare eccezione (AEAD authentication check)
{
  const plain = randomBytes(64);
  const { dek: dk, nonce: nc, ct: c } = encryptContent(plain);
  const badCt = c.slice(0, -4) + '0000';
  let threw = false;
  try { decryptContent(dk, nc, badCt); } catch { threw = true; }
  ok(threw, 'ciphertext manomesso → eccezione AEAD');
}

// nonce errato deve far fallire l'autenticazione
{
  const plain = randomBytes(32);
  const { dek: dk, nonce: nc, ct: c } = encryptContent(plain);
  const badNonce = bytesToHex(randomBytes(24));
  let threw = false;
  try { decryptContent(dk, badNonce, c); } catch { threw = true; }
  ok(threw, 'nonce errato → eccezione AEAD');
}

// ══════════════════════════════════════════════════════════════════════
// 7) OCCULTAMENTO — sealShare, makeDecoy, trial decryption
// ══════════════════════════════════════════════════════════════════════
console.log('7) Occultamento: trial decryption e indistinguibilità esche');

const ownerSecret = randomBytes(32);
const trio = [
  identityFromSeed(newSeedPhrase()),
  identityFromSeed(newSeedPhrase()),
  identityFromSeed(newSeedPhrase()),
];
const rawShares = splitSecret(ownerSecret, 3, 2);
const sealedShares = rawShares.map((s, i) => sealShare(trio[i].pub, s));
const decoys = Array.from({ length: 4 }, () => makeDecoy());

// pool mescolato: 3 quote reali + 4 esche in ordine casuale
const pool = [...sealedShares, ...decoys].sort(() => Math.random() - 0.5);
ok(pool.length === 7, 'pool: 7 blob opachi (3 reali + 4 esche)');

// ogni contatto trova la propria quota per trial decryption
for (let i = 0; i < trio.length; i++) {
  const found = findMyShare(pool, trio[i].priv);
  ok(found !== null, `contatto ${i}: trova la propria quota per trial decryption`);
  ok(
    found !== null &&
    found.x === rawShares[i].x &&
    bytesToHex(found.y) === bytesToHex(rawShares[i].y),
    `contatto ${i}: quota trovata corrisponde all'originale`
  );
}

// estraneo senza quota non trova nulla nel pool
ok(findMyShare(pool, identityFromSeed(newSeedPhrase()).priv) === null,
  'estraneo senza quota non trova nulla nel pool');

// le esche da sole non aprono per nessun contatto
for (let i = 0; i < trio.length; i++) {
  ok(findMyShare(decoys, trio[i].priv) === null,
    `contatto ${i}: le esche da sole non aprono`);
}

// ricombinazione 2-su-3 da pool misto
const found0 = findMyShare(pool, trio[0].priv)!;
const found1 = findMyShare(pool, trio[1].priv)!;
const reconstructed = combineSecret([found0, found1]);
ok(bytesToHex(reconstructed) === bytesToHex(ownerSecret),
  'ricombinazione 2/2 da pool misto ricostruisce il segreto originale');

// ══════════════════════════════════════════════════════════════════════
// 8) SAFETY NUMBER — commutatività, collisione, vettore fisso
// ══════════════════════════════════════════════════════════════════════
console.log('8) safetyNumber: commutatività, collisione, vettore fisso');

// Vettore fisso — valori registrati localmente il 2026-05-24.
// MNEMONIC_A = "abandon×11 + about", MNEMONIC_B = "legal winner thank year wave sausage worth useful legal winner thank yellow"
const SN_PUB_A = hexToBytes('024ed395825486a3628176b579749981dca9927c319f6f7ad136d324931da0f661');
const SN_PUB_B = hexToBytes('03c6babf68cf44f67447a9c66398705726c24ec2928091a9e40c076db138e0665a');
const SN_EXPECTED = 'danger vivid depend coast rookie topic';

ok(safetyNumber(SN_PUB_A, SN_PUB_B) === SN_EXPECTED, 'vettore fisso: safety number atteso');
ok(safetyNumber(SN_PUB_B, SN_PUB_A) === SN_EXPECTED, 'vettore fisso: commutativo anche per le chiavi note');

// Commutatività su 20 coppie casuali
let commutativeOk = true;
for (let i = 0; i < 20; i++) {
  const idX = identityFromSeed(newSeedPhrase());
  const idY = identityFromSeed(newSeedPhrase());
  if (safetyNumber(idX.pub, idY.pub) !== safetyNumber(idY.pub, idX.pub)) { commutativeOk = false; break; }
}
ok(commutativeOk, 'commutativo su 20 coppie di chiavi casuali');

// stessa chiave con sé stessa è deterministica
{
  const id = identityFromSeed(newSeedPhrase());
  ok(safetyNumber(id.pub, id.pub) === safetyNumber(id.pub, id.pub),
    'stessa chiave con sé stessa → risultato stabile');
}

// chiavi diverse → safety number diverso (su 20 coppie)
let collisionFree = true;
for (let i = 0; i < 20; i++) {
  const idX = identityFromSeed(newSeedPhrase());
  const idY = identityFromSeed(newSeedPhrase());
  if (safetyNumber(idX.pub, idY.pub) === safetyNumber(idX.pub, idX.pub)) { collisionFree = false; break; }
}
ok(collisionFree, 'chiavi diverse → safety number diverso (20 campioni)');

// formato: 6 parole separate da spazio
{
  const sn = safetyNumber(SN_PUB_A, SN_PUB_B);
  const words = sn.split(' ');
  ok(words.length === 6, 'safety number = esattamente 6 parole');
  ok(words.every(w => w.length >= 3), 'ogni parola ha almeno 3 caratteri (BIP39)');
}

// ══════════════════════════════════════════════════════════════════════
// 9) signChallenge — round-trip + formato compatto
// ══════════════════════════════════════════════════════════════════════
console.log('9) signChallenge: round-trip P-256, formato compatto');

{
  // usa l'identità con vettore fisso per il round-trip server-side
  const id = identityFromSeed(FIXED_MNEMONIC);
  const challenge = 'sentinella:pending:' + Date.now();
  const sigHex = signChallenge(id.priv, challenge);

  // verifica lato server: stessa operazione che eseguirà pending.ts
  const msgHash = sha256(new TextEncoder().encode(challenge));
  const valid = p256.verify(hexToBytes(sigHex), msgHash, id.pub);
  ok(valid, 'signChallenge: p256.verify accetta la firma (round-trip server-side)');

  // formato compatto: 64 byte = 128 hex chars
  ok(sigHex.length === 128, 'signChallenge: firma compatta 64 byte (128 hex)');

  // challenge diverso → firma diversa
  const sig2 = signChallenge(id.priv, 'sentinella:pending:' + (Date.now() + 1));
  ok(sigHex !== sig2, 'challenges diversi → firme diverse');

  // chiave diversa → firma diversa (e non verifica con la chiave sbagliata)
  const other = identityFromSeed(newSeedPhrase());
  const sigOther = signChallenge(other.priv, challenge);
  ok(!p256.verify(hexToBytes(sigOther), msgHash, id.pub),
    'firma con chiave diversa NON verifica con la chiave originale');
}

// ══════════════════════════════════════════════════════════════════════
// RISULTATO
// ══════════════════════════════════════════════════════════════════════
console.log(`\nRisultato: ${pass} passati, ${fail} falliti`);

console.log('\n[VALUTAZIONE SHAMIR — libreria auditata vs implementazione interna]');
console.log('  Opzioni esaminate:');
console.log('  - secrets.js-grempe  : GF(2^8), molto diffusa ma senza audit pubblico');
console.log('  - @privy-io/shamir-ss : recente, audit interno Privy, non indipendente');
console.log('  - @noble/* family     : non include Shamir nel set attuale di librerie');
console.log('  DECISIONE: mantenere implementazione interna (<35 righe GF-256). Motivi:');
console.log('    1) Nessuna alternativa con audit pubblico indipendente disponibile');
console.log('    2) Codice compatto e verificabile a mano contro le tabelle GF(256)');
console.log('    3) Questa suite copre: vettori fissi, proprietà soglia, sub-soglia,');
console.log('       lunghezze multiple, pool misto con esche.');
console.log('  PRE-PRODUZIONE: commissioning audit esterno obbligatorio (CLAUDE.md).');

process.exit(fail ? 1 : 0);
