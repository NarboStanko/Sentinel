// Test di app/lib/attachments.ts — zero dipendenze native.
// Usa InMemoryProvider e file simulati tramite data URI.
import { encryptAndUpload, decryptAttachment, MAX_FILE_BYTES, MAX_TOTAL_BYTES, type PendingAttachment } from './attachments';
import { setActiveProvider, type StorageProvider } from './storage';
import { randomBytes, bytesToHex } from '@noble/hashes/utils';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => {
  if (c) { pass++; console.log('  ✓', m); }
  else   { fail++; console.log('  ✗ FAIL:', m); }
};

// ── InMemoryProvider ──────────────────────────────────────────────────────────
class InMemoryProvider implements StorageProvider {
  readonly name = 'memory';
  private store = new Map<string, Uint8Array>();
  isAuthorized() { return true; }
  async upload(blob: Uint8Array): Promise<string> {
    const id = 'mem://' + bytesToHex(randomBytes(8));
    this.store.set(id, new Uint8Array(blob));
    return id;
  }
  async download(pointer: string): Promise<Uint8Array> {
    const d = this.store.get(pointer);
    if (!d) throw new Error('Not found: ' + pointer);
    return d;
  }
  async delete(pointer: string): Promise<void> { this.store.delete(pointer); }
}

// Crea un PendingAttachment simulato con data-URI (accessibile via fetch in Node).
// In RN veri, l'URI sarebbe file:// o content://; qui usiamo un blob URL alternativo.
// Poiché Node non ha fetch nativo sui data: URI, usiamo un mock di fetch.
const originalFetch = globalThis.fetch;
function mockFetchWithBytes(bytes: Uint8Array) {
  (globalThis as any).fetch = async (_uri: string) => ({
    ok: true,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });
}
function restoreFetch() { globalThis.fetch = originalFetch; }

async function runTests() {
  const provider = new InMemoryProvider();
  setActiveProvider(provider);
  const dek = randomBytes(32);

  // ── 1) round-trip: encryptAndUpload → decryptAttachment ───────────────────
  console.log('1) Round-trip: cifra+carica → scarica+decifra (plaintext identico)');
  {
    const original = randomBytes(128);
    const att: PendingAttachment = { uri: 'file://fake', name: 'doc.pdf', mimeType: 'application/pdf', size: 128 };
    mockFetchWithBytes(original);
    const meta = await encryptAndUpload(att, dek);
    restoreFetch();

    ok(typeof meta.pointer === 'string' && meta.pointer.startsWith('mem://'), `puntatore opaco: ${meta.pointer}`);
    ok(meta.name === 'doc.pdf',               `nome preservato nel meta: ${meta.name}`);
    ok(meta.mimeType === 'application/pdf',   `mimeType preservato: ${meta.mimeType}`);
    ok(meta.size === 128,                     `size preservata: ${meta.size}`);
    ok(typeof meta.nonce === 'string' && meta.nonce.length === 48, `nonce hex 24B: len=${meta.nonce.length}`);

    const recovered = await decryptAttachment(meta, dek);
    ok(bytesToHex(recovered) === bytesToHex(original), 'plaintext identico dopo round-trip');
  }

  // ── 2) puntatore opaco — nessun nome file o metadata rivelatore ───────────
  console.log('2) Puntatore opaco (no filename, no mimeType, no nome utente)');
  {
    const att: PendingAttachment = { uri: 'file://sentinella-secret.pdf', name: 'documento_segreto.pdf', mimeType: 'application/pdf', size: 64 };
    mockFetchWithBytes(randomBytes(64));
    const meta = await encryptAndUpload(att, dek);
    restoreFetch();

    ok(!meta.pointer.includes('documento'), `no nome nel pointer (${meta.pointer})`);
    ok(!meta.pointer.includes('pdf'),       `no estensione nel pointer`);
    ok(!meta.pointer.includes('sentinella'), `no "sentinella" nel pointer`);
  }

  // ── 3) nonce diverso ad ogni chiamata ─────────────────────────────────────
  console.log('3) Nonce unico ad ogni encrypt (chiavi di sessione non riutilizzate)');
  {
    const bytes = randomBytes(32);
    const att: PendingAttachment = { uri: 'file://f', name: 'f', mimeType: 'application/octet-stream', size: 32 };
    mockFetchWithBytes(bytes);
    const m1 = await encryptAndUpload(att, dek);
    restoreFetch();
    mockFetchWithBytes(bytes);
    const m2 = await encryptAndUpload(att, dek);
    restoreFetch();

    ok(m1.nonce !== m2.nonce,     `nonce distinti (${m1.nonce.slice(0,8)}… ≠ ${m2.nonce.slice(0,8)}…)`);
    ok(m1.pointer !== m2.pointer, `puntatori distinti`);
  }

  // ── 4) DEK diversa → decifratura fallisce ────────────────────────────────
  console.log('4) DEK diversa → decrypt lancia eccezione (AEAD tag invalido)');
  {
    const original = randomBytes(64);
    const att: PendingAttachment = { uri: 'file://f', name: 'f', mimeType: 'application/octet-stream', size: 64 };
    mockFetchWithBytes(original);
    const meta = await encryptAndUpload(att, dek);
    restoreFetch();

    const wrongDek = randomBytes(32);
    let threw = false;
    try { await decryptAttachment(meta, wrongDek); } catch { threw = true; }
    ok(threw, 'decryptAttachment con DEK errata lancia eccezione');
  }

  // ── 5) contenuto cifrato ≠ plaintext (il provider vede solo ciphertext) ───
  console.log('5) Provider vede ciphertext opaco (non leggibile senza DEK)');
  {
    const plain = new TextEncoder().encode('segreto importante');
    const att: PendingAttachment = { uri: 'file://f', name: 'f', mimeType: 'text/plain', size: plain.length };
    mockFetchWithBytes(plain);
    const meta = await encryptAndUpload(att, dek);
    restoreFetch();

    const stored = await provider.download(meta.pointer);
    ok(bytesToHex(stored) !== bytesToHex(plain), 'byte sul provider ≠ plaintext');
  }

  // ── 6) onProgress callback chiamato (0%, 40%, 70%, 100%) ─────────────────
  console.log('6) onProgress chiamato con 0→40→70→100');
  {
    const progress: number[] = [];
    const att: PendingAttachment = { uri: 'file://f', name: 'f', mimeType: 'application/octet-stream', size: 16 };
    mockFetchWithBytes(randomBytes(16));
    await encryptAndUpload(att, dek, pct => progress.push(pct));
    restoreFetch();

    ok(progress[0] === 0,   `primo callback = 0 (${progress[0]})`);
    ok(progress[progress.length - 1] === 100, `ultimo callback = 100 (${progress[progress.length - 1]})`);
    ok(progress.length >= 3, `almeno 3 callback (${progress.length})`);
  }

  // ── 7) costanti limiti dimensione ────────────────────────────────────────
  console.log('7) Costanti MAX_FILE_BYTES e MAX_TOTAL_BYTES');
  {
    ok(MAX_FILE_BYTES  === 25 * 1024 * 1024,  `MAX_FILE_BYTES = 25 MB (${MAX_FILE_BYTES})`);
    ok(MAX_TOTAL_BYTES === 200 * 1024 * 1024, `MAX_TOTAL_BYTES = 200 MB (${MAX_TOTAL_BYTES})`);
    ok(MAX_TOTAL_BYTES > MAX_FILE_BYTES, 'totale > singolo file');
  }
}

runTests().then(() => {
  console.log(`\nRisultato: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
}).catch(e => { console.error(e); process.exit(1); });
