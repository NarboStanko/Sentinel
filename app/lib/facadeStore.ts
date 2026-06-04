// Gestione della modalità facciata (duress mode A).
// Quando attiva, l'app mostra dati fittizi e non chiama il server reale.
// La modalità si attiva inserendo il duress PIN di tipo 'facade'.
// Si disattiva inserendo il PIN normale, il che registra DURESS_FACADE_TRIGGERED in catena.
import * as SecureStore from 'expo-secure-store';

const FACADE_KEY = 'sentinella.facade_active';

// Cache in memoria per la sessione corrente (evita letture ripetute da SecureStore)
let cache: boolean | null = null;

export async function activateFacade(): Promise<void> {
  cache = true;
  await SecureStore.setItemAsync(FACADE_KEY, '1');
}

export async function deactivateFacade(): Promise<void> {
  cache = false;
  await SecureStore.deleteItemAsync(FACADE_KEY);
}

export async function isFacadeActive(): Promise<boolean> {
  if (cache !== null) return cache;
  const val = await SecureStore.getItemAsync(FACADE_KEY);
  cache = val === '1';
  return cache;
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

export const FACADE_CONTACTS = [
  { id: 'c_facade_001', display_name: 'Marco R.', pairedAt: Date.now() - 7 * 86400_000 },
  { id: 'c_facade_002', display_name: 'Elena V.', pairedAt: Date.now() - 14 * 86400_000 },
];
