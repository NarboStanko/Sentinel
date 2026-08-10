// Polyfill TextEncoder/TextDecoder per Hermes (WHATWG Encoding, UTF-8).
// Hermes (RN 0.74) ha TextEncoder nativo ma NON TextDecoder: senza questo
// polyfill il percorso di rilascio (approve.tsx) crasha con
// "Property 'TextDecoder' doesn't exist".
// Va importato in cima a app/_layout.tsx, PRIMA di qualsiasi modulo che usi
// TextEncoder/TextDecoder a livello di modulo (es. lib/crypto.ts).
// Assegna il globale solo se assente: dove esiste l'implementazione nativa
// (stesso UTF-8 standard) resta quella, così l'output byte-per-byte usato per
// derivazione chiavi e hash è identico su tutti i dispositivi.
import { TextEncoder as TextEncoderPolyfill, TextDecoder as TextDecoderPolyfill } from 'text-encoding';

const g = globalThis as any;
if (typeof g.TextEncoder === 'undefined') {
  g.TextEncoder = TextEncoderPolyfill;
}
if (typeof g.TextDecoder === 'undefined') {
  g.TextDecoder = TextDecoderPolyfill;
}
