import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

export function hashPin(salt: string, pin: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(salt + pin)));
}
