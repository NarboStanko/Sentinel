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
