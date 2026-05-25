// Invio push via Expo Push API. REGOLA: nessun segreto nel payload.
// La notifica dice solo "apri l'app"; la quota cifrata si scarica via TLS e
// si decifra sul device del contatto.
type PushMsg = { to: string; title: string; body: string; data?: Record<string, unknown> };

const EXPO_PUSH = 'https://exp.host/--/api/v2/push/send';

export async function sendPush(messages: PushMsg[], log?: { info: Function; warn: Function }) {
  const valid = messages.filter((m) => m.to && m.to.startsWith('ExponentPushToken'));
  if (valid.length === 0) {
    log?.info?.({ messages }, '[pushSender] nessun token reale: modalita log (dev)');
    return;
  }
  try {
    const res = await fetch(EXPO_PUSH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(valid),
    });
    const json = await res.json();
    log?.info?.({ json }, '[pushSender] inviate');
  } catch (e) {
    log?.warn?.({ e }, '[pushSender] errore invio push');
  }
}

// Helpers: payload SENZA contenuto sensibile.
export const checkinPush = (to: string): PushMsg => ({
  to, title: 'Sentinella', body: 'Tutto ok? Tocca per confermare.',
  data: { type: 'checkin' },
});
export const approvalPush = (to: string, ownerName: string): PushMsg => ({
  to, title: 'Richiesta di rilascio',
  body: `${ownerName} non risponde. Apri l'app per decidere.`,
  data: { type: 'approval' },
});
