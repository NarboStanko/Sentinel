// Stato globale di sblocco dell'app (solo in memoria: si azzera a ogni cold
// start, quindi l'app riparte sempre bloccata). La lock screen è l'unico punto
// che chiama setUnlocked(true) dopo verifica del PIN; onboarding e restore
// sbloccano direttamente perché l'utente si è appena autenticato con la seed.

export const LOCK_TIMEOUT_MS = 3 * 60_000;

let unlocked = false;
let backgroundAt = 0;

// Deep link (es. tap su push) intercettato mentre l'app era bloccata:
// la lock screen lo consuma dopo lo sblocco al posto di /home.
let pendingRoute: string | null = null;

export function isUnlocked(): boolean {
  return unlocked;
}

export function setUnlocked(value: boolean): void {
  unlocked = value;
  if (value) backgroundAt = 0;
}

// Chiamata quando l'app va in background: registra il momento.
export function noteBackground(): void {
  backgroundAt = Date.now();
}

// Chiamata al ritorno in foreground: true se è passato troppo tempo
// e l'app va ribloccata.
export function shouldRelock(): boolean {
  return unlocked && backgroundAt > 0 && Date.now() - backgroundAt > LOCK_TIMEOUT_MS;
}

export function setPendingRoute(route: string | null): void {
  pendingRoute = route;
}

export function consumePendingRoute(): string | null {
  const r = pendingRoute;
  pendingRoute = null;
  return r;
}
