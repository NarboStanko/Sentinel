// Gestione della modalità facciata (duress mode A).
// Quando attiva, l'app mostra dati fittizi e non chiama il server reale.
// La modalità si attiva inserendo il duress PIN di tipo 'facade'.
// Si disattiva inserendo il PIN normale, il che registra DURESS_FACADE_TRIGGERED in catena.
import * as SecureStore from 'expo-secure-store';

const FACADE_KEY = 'sentinella.facade_active';

// Cache in memoria per la sessione corrente (evita letture ripetute da SecureStore).
// Il valore persistito è il timestamp ms di attivazione (serve per l'avviso
// «Hai usato il PIN di emergenza alle X» all'uscita dalla facciata).
let cache: number | null | undefined; // undefined = non ancora letto

export async function activateFacade(): Promise<void> {
  const now = Date.now();
  cache = now;
  await SecureStore.setItemAsync(FACADE_KEY, String(now));
}

export async function deactivateFacade(): Promise<void> {
  cache = null;
  await SecureStore.deleteItemAsync(FACADE_KEY);
}

async function readActivatedAt(): Promise<number | null> {
  if (cache !== undefined) return cache;
  const val = await SecureStore.getItemAsync(FACADE_KEY);
  // '1' = formato legacy (senza timestamp): facciata attiva, orario ignoto.
  cache = val === null ? null : val === '1' ? 0 : Number(val);
  return cache;
}

export async function isFacadeActive(): Promise<boolean> {
  return (await readActivatedAt()) !== null;
}

export async function getFacadeActivatedAt(): Promise<number | null> {
  const at = await readActivatedAt();
  return at === 0 ? null : at; // legacy: attiva ma orario sconosciuto
}

// Dati fittizi mostrati in modalità facciata.
// 1 switch DISARMED, 2 contatti, aspetto identico ai dati reali.
export const FACADE_SWITCH = {
  id: 'sw_facade_000',
  state: 'DISARMED' as const,
  interval_sec: 86400,
  grace_sec: 3600,
  armed_at: null as number | null,
  next_check_at: null as number | null,
};

// I campi rispecchiano quelli che contacts.tsx renderizza per i contatti reali
// (public_key/to_hash/created_at): chiavi esadecimali plausibili ma fittizie.
export const FACADE_CONTACTS = [
  {
    id: 'c_facade_001',
    display_name: 'Marco R.',
    public_key: '02a4c1f08b3d5e7291c6b0d84f13a75e920cd8461b3f5a09e7d2c48b160f3a9d51',
    to_hash: 'a7e2c91b4d60',
    created_at: Date.now() - 7 * 86400_000,
    pairedAt: Date.now() - 7 * 86400_000,
  },
  {
    id: 'c_facade_002',
    display_name: 'Elena V.',
    public_key: '03d97b2e51c48a06f3e1b9d270c5a84e6f02d3b18c47e9a05b6d1f28c93e470ab2',
    to_hash: '3f81d5a2c96e',
    created_at: Date.now() - 14 * 86400_000,
    pairedAt: Date.now() - 14 * 86400_000,
  },
];
