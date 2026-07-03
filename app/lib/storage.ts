// Astrazione storage per i contenuti cifrati.
// INVARIANTE: i blob passati a upload sono GIÀ cifrati lato client (XChaCha20-Poly1305).
// Il provider vede solo byte opachi e NON deve ricevere mai chiavi o DEK.
// Il server riceve SOLO il puntatore restituito da upload(), mai il blob.
export interface StorageProvider {
  readonly name: string;
  /** true se il provider ha credenziali valide */
  isAuthorized(): boolean;
  /** Carica blob cifrato, restituisce puntatore opaco */
  upload(blob: Uint8Array): Promise<string>;
  /** Scarica blob cifrato dal puntatore */
  download(pointer: string): Promise<Uint8Array>;
  /** Cancella il blob (opzionale — non tutti i provider lo supportano) */
  delete?(pointer: string): Promise<void>;
}

let _active: StorageProvider | null = null;

export function setActiveProvider(p: StorageProvider): void {
  _active = p;
}

export function clearActiveProvider(): void {
  _active = null;
}

export function getActiveProvider(): StorageProvider {
  if (!_active) {
    throw new Error(
      '[storage] Nessun provider configurato. ' +
      'Chiama setActiveProvider() prima di usare uploadEncrypted/downloadEncrypted.'
    );
  }
  return _active;
}
