// Test della StorageProvider interface con InMemoryProvider (zero dipendenze native).
// Copre: round-trip binario, round-trip encrypt→upload→download→decrypt,
//        pointer opaco, registry getActiveProvider/setActiveProvider.
import { encryptContent, decryptContent } from './crypto';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';
import { setActiveProvider, getActiveProvider, type StorageProvider } from './storage';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => {
  if (c) { pass++; console.log('  ✓', m); }
  else   { fail++; console.log('  ✗ FAIL:', m); }
};

// ── InMemoryProvider — zero dipendenze, usabile in test Node.js ───────────────
class InMemoryProvider implements StorageProvider {
  readonly name = 'memory';
  private store = new Map<string, Uint8Array>();
  isAuthorized() { return true; }
  async upload(blob: Uint8Array): Promise<string> {
    const id = 'mem://' + bytesToHex(randomBytes(8));
    this.store.set(id, new Uint8Array(blob)); // copia difensiva
    return id;
  }
  async download(pointer: string): Promise<Uint8Array> {
    const d = this.store.get(pointer);
    if (!d) throw new Error('Not found: ' + pointer);
    return d;
  }
  async delete(pointer: string): Promise<void> { this.store.delete(pointer); }
}

async function runTests() {
  // ── 1) upload → download restituisce gli stessi byte ──────────────────────
  console.log('1) InMemoryProvider: upload/download round-trip byte identici');
  {
    const p = new InMemoryProvider();
    const orig = randomBytes(64);
    const ptr = await p.upload(orig);

    ok(typeof ptr === 'string' && ptr.startsWith('mem://'), `puntatore formato mem:// (${ptr})`);
    const back = await p.download(ptr);
    ok(bytesToHex(back) === bytesToHex(orig), 'download restituisce gli stessi byte');
  }

  // ── 2) copia difensiva ────────────────────────────────────────────────────
  console.log('2) upload fa copia difensiva (mutare orig non corrode lo store)');
  {
    const p = new InMemoryProvider();
    const orig = new Uint8Array([1, 2, 3, 4]);
    const ptr = await p.upload(orig);
    orig[0] = 99;
    const back = await p.download(ptr);
    ok(back[0] === 1, `primo byte intatto dopo mutazione orig (${back[0]})`);
  }

  // ── 3) ogni upload genera un puntatore unico ──────────────────────────────
  console.log('3) upload ripetuto genera puntatori diversi');
  {
    const p = new InMemoryProvider();
    const blob = randomBytes(16);
    const p1 = await p.upload(blob);
    const p2 = await p.upload(blob);
    ok(p1 !== p2, `puntatori distinti`);
  }

  // ── 4) delete rimuove il blob ─────────────────────────────────────────────
  console.log('4) delete rimuove il blob');
  {
    const p = new InMemoryProvider();
    const ptr = await p.upload(randomBytes(8));
    await p.delete(ptr);
    let threw = false;
    try { await p.download(ptr); } catch { threw = true; }
    ok(threw, 'download dopo delete lancia eccezione');
  }

  // ── 5) round-trip: encryptContent → upload → download → decryptContent ───
  console.log('5) Round-trip cifra → upload → download → decifra (plaintext identico)');
  {
    const p = new InMemoryProvider();
    const plaintext = new TextEncoder().encode('Testo segreto con àéîõü 🔑');
    const { dek, nonce, ct } = encryptContent(plaintext);

    const ptr = await p.upload(hexToBytes(ct));
    ok(typeof ptr === 'string', `puntatore ricevuto: ${ptr}`);

    const ctBack = bytesToHex(await p.download(ptr));
    ok(ctBack === ct, 'ciphertext round-trip identico (byte per byte)');

    const recovered = decryptContent(dek, nonce, ctBack);
    const text = new TextDecoder().decode(recovered);
    ok(text === new TextDecoder().decode(plaintext), `testo recuperato identico`);
  }

  // ── 6) manifest JSON sopravvive al round-trip ─────────────────────────────
  console.log('6) Manifest JSON cifrato → round-trip → stesso JSON');
  {
    const p = new InMemoryProvider();
    const manifest = JSON.stringify({ text: 'Messaggio di rilascio', files: [], ts: 12345 });
    const pt = new TextEncoder().encode(manifest);
    const { dek, nonce, ct } = encryptContent(pt);

    const ptr = await p.upload(hexToBytes(ct));
    const ctBack = bytesToHex(await p.download(ptr));
    const recovered = JSON.parse(new TextDecoder().decode(decryptContent(dek, nonce, ctBack)));

    ok(recovered.text === 'Messaggio di rilascio', `manifest.text: ${recovered.text}`);
    ok(Array.isArray(recovered.files), 'manifest.files array');
  }

  // ── 7) registry setActiveProvider/getActiveProvider ───────────────────────
  console.log('7) Registry setActiveProvider / getActiveProvider');
  {
    const p = new InMemoryProvider();
    setActiveProvider(p);
    const got = getActiveProvider();
    ok(got === p, 'getActiveProvider restituisce il provider impostato');
    ok(got.name === 'memory', `name corretto: ${got.name}`);
  }

  // ── 8) pointer opaco: no filename, no metadati rivelatori ─────────────────
  console.log('8) Pointer opaco');
  {
    const p = new InMemoryProvider();
    const ptr = await p.upload(randomBytes(32));
    ok(!ptr.includes('sentinella'), `no "sentinella" in pointer (${ptr})`);
    ok(!ptr.includes('manifest'),  `no "manifest" in pointer`);
    ok(!ptr.includes('text'),      `no "text" in pointer`);
  }

  // ── 9) contenuto cifrato: provider non può decifrare senza DEK ───────────
  console.log('9) Provider vede solo blob opaco (non decifrabile senza DEK)');
  {
    const p = new InMemoryProvider();
    const plaintext = new TextEncoder().encode('segreto');
    const { ct } = encryptContent(plaintext);
    const ptr = await p.upload(hexToBytes(ct));
    const stored = await p.download(ptr);
    // il provider ha i byte ma non può sapere cosa contengono
    ok(bytesToHex(stored) !== new TextDecoder().decode(plaintext), 'byte cifrati ≠ plaintext');
    ok(bytesToHex(stored) === ct, 'byte salvati = ciphertext originale');
  }
}

runTests().then(() => {
  console.log(`\nRisultato: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
}).catch(e => { console.error(e); process.exit(1); });
