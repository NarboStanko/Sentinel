// Storage del contenuto CIFRATO su drive esterno scelto dall'utente.
// PRODUZIONE: implementare qui l'upload OAuth verso Google Drive (o S3/IPFS).
// Il server deve ricevere SOLO il puntatore restituito da questa funzione.
//
// Per lo sviluppo end-to-end usiamo un endpoint dev del server (/dev/blob) che
// conserva il ciphertext separatamente — VA SOSTITUITO con il drive reale.
import Constants from 'expo-constants';
const BASE = (Constants.expoConfig?.extra?.serverUrl as string) ?? 'http://localhost:4000';

export async function uploadEncrypted(ciphertextHex: string): Promise<string> {
  // TODO(produzione): caricare su Google Drive via OAuth e restituire l'URL.
  const res = await fetch(BASE + '/dev/blob', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: ciphertextHex }),
  });
  const { pointer } = await res.json();
  return pointer; // es. "drive://dev/abc123"
}
export async function downloadEncrypted(pointer: string): Promise<string> {
  const res = await fetch(BASE + '/dev/blob?pointer=' + encodeURIComponent(pointer));
  const { data } = await res.json();
  return data;
}
