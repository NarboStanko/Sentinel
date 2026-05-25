// Test anti-segreti per pushSender.ts
// Regola ferrea: il payload push non deve mai contenere segreti o identificatori
// sensibili (chiavi, DEK, seed, switchId). Apple/Google vedono tutto.
import { checkinPush, approvalPush, sendPush } from './pushSender.js';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => {
  if (c) { pass++; console.log('  ✓', m); }
  else    { fail++; console.log('  ✗ FAIL:', m); }
};

// ── Pattern vietati nel payload serializzato ───────────────────────────────
const FORBIDDEN: Array<[RegExp, string]> = [
  [/[0-9a-fA-F]{32,}/,  'hex ≥ 32 char (chiave/hash/nonce)'],
  [/\bseed\b/i,          '"seed"'],
  [/\bdek\b/i,           '"dek"'],
  [/\bswitchId\b/i,      '"switchId"'],
  [/\bprivKey\b/i,       '"privKey"'],
  [/\bsecret\b/i,        '"secret"'],
  [/\bshare\b/i,         '"share" (quota Shamir)'],
];

function checkClean(label: string, msg: unknown) {
  const json = JSON.stringify(msg);
  for (const [re, desc] of FORBIDDEN) {
    ok(!re.test(json), `${label}: nessun ${desc}`);
  }
}

// ── 1) checkinPush ─────────────────────────────────────────────────────────
console.log('1) Anti-segreti — checkinPush');
const DEMO_TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxxxx]';
checkClean('checkinPush', checkinPush(DEMO_TOKEN));

// ── 2) approvalPush ────────────────────────────────────────────────────────
console.log('2) Anti-segreti — approvalPush');
checkClean('approvalPush', approvalPush(DEMO_TOKEN, 'Alice'));

// ── 3) data.type presente, nient'altro di sensibile ────────────────────────
console.log('3) data.type corretto');
const cp = checkinPush(DEMO_TOKEN);
const ap = approvalPush(DEMO_TOKEN, 'Bob');
ok(cp.data?.type === 'checkin',  'checkinPush: data.type === "checkin"');
ok(ap.data?.type === 'approval', 'approvalPush: data.type === "approval"');
// Nessuna chiave aggiuntiva in data
const cpDataKeys = Object.keys(cp.data ?? {});
const apDataKeys = Object.keys(ap.data ?? {});
ok(cpDataKeys.length === 1 && cpDataKeys[0] === 'type', 'checkinPush: data contiene solo "type"');
ok(apDataKeys.length === 1 && apDataKeys[0] === 'type', 'approvalPush: data contiene solo "type"');

// ── 4) Modalità log: token non-Expo → nessuna fetch ────────────────────────
console.log('4) Modalità log — nessun fetch senza ExponentPushToken');
{
  let fetched = false;
  const orig = globalThis.fetch;
  (globalThis as any).fetch = (..._: unknown[]) => {
    fetched = true;
    return Promise.resolve({ json: () => ({}) } as Response);
  };
  const log = { info: (_: unknown, __: string) => {}, warn: (_: unknown, __: string) => {} };
  await sendPush([], log);
  await sendPush([{ to: 'non-expo-token', title: 'x', body: 'y' }], log);
  (globalThis as any).fetch = orig;
  ok(!fetched, 'sendPush senza ExponentPushToken non chiama fetch (modalità log)');
}

// ── 5) Token ExponentPushToken → chiama fetch ──────────────────────────────
console.log('5) Token reale → fetch viene chiamato');
{
  let fetchedUrl = '';
  const orig = globalThis.fetch;
  (globalThis as any).fetch = (url: string, _: unknown) => {
    fetchedUrl = url;
    return Promise.resolve({ json: () => ({ data: [] }) } as any);
  };
  const log = { info: (_: unknown, __: string) => {}, warn: (_: unknown, __: string) => {} };
  await sendPush([checkinPush(DEMO_TOKEN)], log);
  (globalThis as any).fetch = orig;
  ok(fetchedUrl.includes('exp.host'), 'sendPush con token reale chiama Expo Push API');
}

console.log(`\nRisultato: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
