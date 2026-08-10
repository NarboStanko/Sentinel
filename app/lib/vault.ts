// Vault locale dei "pacchetti ricevuti" (lato contatto, post-RELEASED).
//
// Modello di protezione — coerente con seed/identità:
// - Una chiave simmetrica di vault (32 byte) generata al primo uso e custodita
//   in expo-secure-store (Keystore/StrongBox su Android, Keychain su iOS),
//   WHEN_UNLOCKED_THIS_DEVICE_ONLY.
// - Tutto ciò che tocca il disco (manifest, DEK dello switch, allegati cache)
//   è cifrato con quella chiave: XChaCha20-Poly1305, file = base64(nonce24 || ct).
// - I file vivono in FileSystem.documentDirectory/vault/ (area privata dell'app,
//   sopravvive al riavvio; nessun plaintext su disco).
// - Il server non entra mai in questo percorso: qui arrivano solo dati già
//   decifrati sul dispositivo dal flusso di rilascio.
import * as SecureStore from 'expo-secure-store';
import * as FileSystem from 'expo-file-system';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';
import type { AttachmentMeta } from './attachments';

const VAULT_KEY_STORE = 'sentinella.vault_key';
const NONCE_LEN = 24;

function vaultDir(): string {
  const base = FileSystem.documentDirectory;
  if (!base) throw new Error('[vault] documentDirectory non disponibile su questa piattaforma');
  return base + 'vault/';
}

// ── base64 ↔ bytes (chunked per non far esplodere lo stack su file grandi) ────
function uint8ToBase64(bytes: Uint8Array): string {
  let out = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(out);
}
function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ── chiave di vault ───────────────────────────────────────────────────────────
async function getVaultKey(): Promise<Uint8Array> {
  let hex = await SecureStore.getItemAsync(VAULT_KEY_STORE);
  if (!hex) {
    hex = bytesToHex(randomBytes(32));
    await SecureStore.setItemAsync(VAULT_KEY_STORE, hex, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  }
  return hexToBytes(hex);
}

// ── cifratura at-rest ─────────────────────────────────────────────────────────
function sealBytes(key: Uint8Array, plain: Uint8Array): string {
  const nonce = randomBytes(NONCE_LEN);
  const ct = xchacha20poly1305(key, nonce).encrypt(plain);
  const packed = new Uint8Array(NONCE_LEN + ct.length);
  packed.set(nonce, 0);
  packed.set(ct, NONCE_LEN);
  return uint8ToBase64(packed);
}
function openBytes(key: Uint8Array, packedB64: string): Uint8Array {
  const packed = base64ToUint8(packedB64);
  const nonce = packed.subarray(0, NONCE_LEN);
  const ct = packed.subarray(NONCE_LEN);
  return xchacha20poly1305(key, nonce).decrypt(ct);
}

async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(vaultDir());
  if (!info.exists) await FileSystem.makeDirectoryAsync(vaultDir(), { intermediates: true });
}

// ── modello dati ──────────────────────────────────────────────────────────────
export type ReceivedAttachment = {
  meta: AttachmentMeta;   // pointer + nonce originali: con la DEK permette il re-download
  cachedFile?: string;    // nome del file cifrato nel vault (disponibile offline)
};
export type ReceivedItem = { label: string; text: string; attachments: ReceivedAttachment[] };
export type ReceivedPackage = {
  switchId: string;
  ownerName: string;
  savedAt: number;
  // DEK dello switch, cifrata a riposo insieme al resto del record: serve a
  // scaricare/decifrare gli allegati non ancora in cache. Mai inviata al server.
  dekHex: string;
  items: ReceivedItem[];
};

const pkgFile = (switchId: string) => vaultDir() + 'pkg_' + switchId + '.enc';
const attFile = (switchId: string, item: number, att: number) =>
  vaultDir() + 'att_' + switchId + '_' + item + '_' + att + '.enc';

// ── API ───────────────────────────────────────────────────────────────────────
// Salva (o aggiorna) un pacchetto. Se esiste già un record per lo stesso switch,
// conserva i marker cachedFile degli allegati già scaricati (match sul pointer).
export async function savePackage(pkg: ReceivedPackage): Promise<void> {
  await ensureDir();
  const key = await getVaultKey();

  const existing = await getPackage(pkg.switchId).catch(() => null);
  if (existing) {
    for (const item of pkg.items) {
      for (const att of item.attachments) {
        if (att.cachedFile) continue;
        const prev = existing.items
          .flatMap((i) => i.attachments)
          .find((a) => a.meta.pointer === att.meta.pointer && a.cachedFile);
        if (prev) att.cachedFile = prev.cachedFile;
      }
    }
  }

  const plain = new TextEncoder().encode(JSON.stringify(pkg));
  await FileSystem.writeAsStringAsync(pkgFile(pkg.switchId), sealBytes(key, plain), {
    encoding: FileSystem.EncodingType.UTF8,
  });
}

export async function getPackage(switchId: string): Promise<ReceivedPackage | null> {
  const info = await FileSystem.getInfoAsync(pkgFile(switchId));
  if (!info.exists) return null;
  const key = await getVaultKey();
  const packedB64 = await FileSystem.readAsStringAsync(pkgFile(switchId), {
    encoding: FileSystem.EncodingType.UTF8,
  });
  return JSON.parse(new TextDecoder().decode(openBytes(key, packedB64))) as ReceivedPackage;
}

// Elenco dei pacchetti salvati, più recente per primo. I record corrotti o non
// decifrabili vengono saltati (mai far crashare la lista per un file rovinato).
export async function listPackages(): Promise<ReceivedPackage[]> {
  const info = await FileSystem.getInfoAsync(vaultDir());
  if (!info.exists) return [];
  const names = await FileSystem.readDirectoryAsync(vaultDir());
  const out: ReceivedPackage[] = [];
  for (const name of names) {
    if (!name.startsWith('pkg_') || !name.endsWith('.enc')) continue;
    const switchId = name.slice('pkg_'.length, -'.enc'.length);
    try {
      const pkg = await getPackage(switchId);
      if (pkg) out.push(pkg);
    } catch (e) {
      console.log('[vault] record non leggibile, saltato:', name, e);
    }
  }
  out.sort((a, b) => b.savedAt - a.savedAt);
  return out;
}

export async function deletePackage(switchId: string): Promise<void> {
  const pkg = await getPackage(switchId).catch(() => null);
  if (pkg) {
    for (const item of pkg.items) {
      for (const att of item.attachments) {
        if (att.cachedFile) {
          await FileSystem.deleteAsync(vaultDir() + att.cachedFile, { idempotent: true }).catch(() => {});
        }
      }
    }
  }
  await FileSystem.deleteAsync(pkgFile(switchId), { idempotent: true }).catch(() => {});
}

// Mette in cache (cifrati con la chiave di vault) i byte in chiaro di un
// allegato già decifrato, e aggiorna il record del pacchetto.
export async function cacheAttachment(
  pkg: ReceivedPackage,
  itemIndex: number,
  attIndex: number,
  plainBytes: Uint8Array,
): Promise<ReceivedPackage> {
  await ensureDir();
  const key = await getVaultKey();
  const fileName = 'att_' + pkg.switchId + '_' + itemIndex + '_' + attIndex + '.enc';
  await FileSystem.writeAsStringAsync(attFile(pkg.switchId, itemIndex, attIndex), sealBytes(key, plainBytes), {
    encoding: FileSystem.EncodingType.UTF8,
  });
  pkg.items[itemIndex].attachments[attIndex].cachedFile = fileName;
  await savePackage(pkg);
  return pkg;
}

// Legge e decifra un allegato dalla cache del vault.
export async function readCachedAttachment(cachedFile: string): Promise<Uint8Array> {
  const key = await getVaultKey();
  const packedB64 = await FileSystem.readAsStringAsync(vaultDir() + cachedFile, {
    encoding: FileSystem.EncodingType.UTF8,
  });
  return openBytes(key, packedB64);
}
