// Custodia della chiave privata. In produzione: Secure Enclave (iOS) / StrongBox
// (Android) tramite expo-secure-store, con la seed phrase come UNICO percorso di
// recupero (scritta dall'utente, mai sul server).
import * as SecureStore from 'expo-secure-store';
import { identityFromSeed, type Identity } from './crypto';

const SEED_KEY = 'sentinella.seed';
const OWNER_ID_KEY = 'sentinella.ownerId';

export async function saveSeed(mnemonic: string) {
  await SecureStore.setItemAsync(SEED_KEY, mnemonic, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}
export async function loadIdentity(): Promise<Identity | null> {
  const m = await SecureStore.getItemAsync(SEED_KEY);
  return m ? identityFromSeed(m) : null;
}
export async function loadSeed(): Promise<string | null> {
  return SecureStore.getItemAsync(SEED_KEY);
}
export async function saveOwnerId(id: string) {
  await SecureStore.setItemAsync(OWNER_ID_KEY, id);
}
export async function loadOwnerId(): Promise<string | null> {
  return SecureStore.getItemAsync(OWNER_ID_KEY);
}

const SWITCH_KEY = 'sentinella.switchId';
export async function saveSwitchId(id: string) { await SecureStore.setItemAsync(SWITCH_KEY, id); }
export async function loadSwitchId(): Promise<string | null> { return SecureStore.getItemAsync(SWITCH_KEY); }

// DEK per switch: salvata dopo l'armo per permettere add-content senza ridistribuire le quote.
const dekKey = (switchId: string) => 'sentinella.dek.' + switchId;
export async function saveDek(switchId: string, dekHex: string): Promise<void> {
  await SecureStore.setItemAsync(dekKey(switchId), dekHex, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}
export async function loadDek(switchId: string): Promise<string | null> {
  return SecureStore.getItemAsync(dekKey(switchId));
}
export async function deleteDek(switchId: string): Promise<void> {
  await SecureStore.deleteItemAsync(dekKey(switchId));
}

// Registro client-side dei puntatori ai contenuti (contentId → {pointer, iv}).
// Usato per pulire i blob dallo storage alla rimozione di un contenuto,
// senza esporre i puntatori al server prima del RELEASED.
export type ContentEntry = { pointer: string; iv: string };

const contentRegistryKey = (switchId: string) => 'sentinella.contents.' + switchId;

export async function saveContentPointer(switchId: string, contentId: string, pointer: string, iv: string): Promise<void> {
  const raw = await SecureStore.getItemAsync(contentRegistryKey(switchId));
  const reg: Record<string, ContentEntry> = raw ? JSON.parse(raw) : {};
  reg[contentId] = { pointer, iv };
  await SecureStore.setItemAsync(contentRegistryKey(switchId), JSON.stringify(reg));
}

export async function loadContentPointers(switchId: string): Promise<Record<string, ContentEntry>> {
  const raw = await SecureStore.getItemAsync(contentRegistryKey(switchId));
  return raw ? JSON.parse(raw) : {};
}

export async function deleteContentPointer(switchId: string, contentId: string): Promise<void> {
  const raw = await SecureStore.getItemAsync(contentRegistryKey(switchId));
  if (!raw) return;
  const reg: Record<string, ContentEntry> = JSON.parse(raw);
  delete reg[contentId];
  await SecureStore.setItemAsync(contentRegistryKey(switchId), JSON.stringify(reg));
}

// Chiavi verificate di persona — mai fidarsi solo della copia del server.
// L'owner salva qui le pubkey dei contatti scansionate dal QR.
// Il contatto salva qui la pubkey dell'owner scansionata dal QR.
const VERIFIED_CONTACT_KEYS_KEY = 'sentinella.verified_contact_keys'; // JSON: string[]
const VERIFIED_OWNER_KEY_KEY    = 'sentinella.verified_owner_key';    // string

export async function saveVerifiedContactKey(pubkeyHex: string): Promise<void> {
  const raw = await SecureStore.getItemAsync(VERIFIED_CONTACT_KEYS_KEY);
  const list: string[] = raw ? JSON.parse(raw) : [];
  if (!list.includes(pubkeyHex)) list.push(pubkeyHex);
  await SecureStore.setItemAsync(VERIFIED_CONTACT_KEYS_KEY, JSON.stringify(list));
}

export async function loadVerifiedContactKeys(): Promise<Set<string>> {
  const raw = await SecureStore.getItemAsync(VERIFIED_CONTACT_KEYS_KEY);
  return new Set<string>(raw ? JSON.parse(raw) : []);
}

export async function saveVerifiedOwnerKey(pubkeyHex: string): Promise<void> {
  await SecureStore.setItemAsync(VERIFIED_OWNER_KEY_KEY, pubkeyHex);
}

export async function loadVerifiedOwnerKey(): Promise<string | null> {
  return SecureStore.getItemAsync(VERIFIED_OWNER_KEY_KEY);
}

// PIN di protezione per la pagina backup seed
const BACKUP_PIN_KEY = 'sentinella.backup_pin';
export async function saveBackupPin(hashHex: string, saltHex: string): Promise<void> {
  await SecureStore.setItemAsync(BACKUP_PIN_KEY, JSON.stringify({ hashHex, saltHex }), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}
export async function loadBackupPin(): Promise<{ hashHex: string; saltHex: string } | null> {
  const raw = await SecureStore.getItemAsync(BACKUP_PIN_KEY);
  return raw ? JSON.parse(raw) : null;
}

// Token di sessione dalla /auth/verify (usato per audit, scade in 30min)
const AUTH_TOKEN_KEY = 'sentinella.auth_token';
export async function saveAuthToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(AUTH_TOKEN_KEY, token);
}
export async function loadAuthToken(): Promise<string | null> {
  return SecureStore.getItemAsync(AUTH_TOKEN_KEY);
}
