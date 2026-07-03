// Politica condivisa per i PIN dell'app (sblocco e coercizione).
// Unica fonte della blacklist: usata sia dalla lock screen (creazione PIN di
// sblocco) sia da duress-setup (PIN di emergenza), così i due PIN rispettano
// gli stessi requisiti minimi e nessuno dei due può essere una sequenza banale.

export const PIN_MIN_LENGTH = 6;

// PIN deboli comunemente usati: vietati (≥ 6 cifre).
// 28 pattern: ripetizioni, sequenze, tastiera numerica, palindrome, alternanze.
export const BLACKLIST = [
  '000000', '111111', '222222', '333333', '444444', '555555',
  '666666', '777777', '888888', '999999',
  '123456', '654321', '234567', '987654',
  '112233', '123123', '121212', '000001',
  '012345', '098765', '159753', '147258',
  '369852', '123321', '131313', '232323',
  '202020', '808080',
];

// Requisiti di formato comuni a tutti i PIN. Ritorna il messaggio d'errore
// oppure null se il PIN è accettabile.
export function validatePinFormat(pin: string): string | null {
  if (!/^\d+$/.test(pin)) return 'Il PIN deve contenere solo cifre.';
  if (pin.length < PIN_MIN_LENGTH) return `Il PIN deve essere di almeno ${PIN_MIN_LENGTH} cifre.`;
  if (BLACKLIST.includes(pin)) return 'PIN troppo comune. Scegli una sequenza meno prevedibile.';
  return null;
}
