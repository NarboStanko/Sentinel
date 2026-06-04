// Lockout esponenziale per tentativi PIN errati.
// Dopo il 3° fallimento: 30s → 2min → 10min → 1h → 4h (cap).
// Persiste in SecureStore attraverso i restart dell'app.
// Il contatore si azzera automaticamente dopo 24h senza fallimenti.
import * as SecureStore from 'expo-secure-store';

const LOCKOUT_KEY = 'sentinella.duress_lockout';
const STEPS_MS = [30_000, 120_000, 600_000, 3_600_000, 14_400_000];
const RESET_AFTER_MS = 24 * 3_600_000;

interface LockoutState {
  failCount: number;
  lockedUntil: number;
  lastFailAt: number;
}

async function read(): Promise<LockoutState> {
  const raw = await SecureStore.getItemAsync(LOCKOUT_KEY);
  return raw ? (JSON.parse(raw) as LockoutState) : { failCount: 0, lockedUntil: 0, lastFailAt: 0 };
}

async function write(state: LockoutState): Promise<void> {
  await SecureStore.setItemAsync(LOCKOUT_KEY, JSON.stringify(state), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function checkLockout(): Promise<{ locked: boolean; remainingMs: number }> {
  const state = await read();
  const now = Date.now();
  if (state.lockedUntil > now) {
    return { locked: true, remainingMs: state.lockedUntil - now };
  }
  return { locked: false, remainingMs: 0 };
}

export async function recordFailure(): Promise<{ locked: boolean; lockedUntil: number }> {
  const state = await read();
  const now = Date.now();

  const isExpired = state.lastFailAt > 0 && now - state.lastFailAt > RESET_AFTER_MS;
  const newCount = isExpired ? 1 : state.failCount + 1;

  // Lockout inizia dal 3° fallimento (newCount >= 3)
  const lockedUntil = newCount >= 3
    ? now + STEPS_MS[Math.min(newCount - 3, STEPS_MS.length - 1)]
    : 0;

  await write({ failCount: newCount, lockedUntil, lastFailAt: now });
  return { locked: lockedUntil > 0, lockedUntil };
}

export async function resetLockout(): Promise<void> {
  await SecureStore.deleteItemAsync(LOCKOUT_KEY);
}

export function formatLockoutMs(ms: number): string {
  if (ms < 60_000) return `${Math.ceil(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.ceil(ms / 60_000)}min`;
  return `${Math.ceil(ms / 3_600_000)}h`;
}
