import Constants from 'expo-constants';
import { signChallenge, bytesToHex } from './crypto';
import { loadIdentity } from './keystore';
import { canonicalize } from './canonicalize';
import { isFacadeActive } from './facadeStore';

export { canonicalize } from './canonicalize';

const BASE =
  (Constants.expoConfig?.extra?.serverUrl as string) ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function req<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  // Modalità facciata (duress A): nessuna chiamata raggiunge il server reale.
  // L'errore imita un problema di rete: generico e plausibile, mai tecnico.
  if (await isFacadeActive()) {
    throw new ApiError(0, 'Connessione non disponibile');
  }
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    if (res.status === 413) {
      throw new ApiError(413, 'Payload troppo grande: riduci la dimensione del file o degli allegati.');
    }
    let message = `${method} ${path} → ${res.status}`;
    let body: Record<string, unknown> | undefined;
    try {
      body = await res.json() as Record<string, unknown>;
      if (typeof body['message'] === 'string') message = body['message'];
      else if (typeof body['error'] === 'string') message = body['error'];
    } catch { /* body non è JSON, usa il messaggio di default */ }
    throw new ApiError(res.status, message, body);
  }
  return res.json() as Promise<T>;
}

async function signedReq<T>(
  path: string,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  const id = await loadIdentity();
  if (!id) throw new ApiError(401, 'Identità non disponibile');
  const pub = bytesToHex(id.pub);
  const ts = Date.now();
  const sig = signChallenge(id.priv, canonicalize(method, path, ts, pub, body));
  return req<T>(path, method, { ...body, pub, ts, sig });
}

export const api = {
  registerOwner: (publicKey: string, displayName?: string) =>
    req<{ ownerId: string }>('/owner/register', 'POST', { publicKey, displayName }),
  createInvite: () =>
    signedReq<{ token: string; ownerPublicKey: string }>('/invite', 'POST', {}),
  pair: (token: string, contactPublicKey: string, pushToken?: string) =>
    req<{ contactId: string }>('/pair', 'POST', { token, contactPublicKey, pushToken }),
  contacts: (ownerId: string) =>
    req<{ contacts: any[] }>(`/contacts?ownerId=${ownerId}`),
  createSwitch: (intervalSec: number, graceSec: number) =>
    signedReq<{ switchId: string }>('/switch/create', 'POST', { intervalSec, graceSec }),
  arm: (payload: Record<string, unknown>) =>
    signedReq<{ ok: boolean; contentId: string }>('/switch/arm', 'POST', payload),
  disarm: (switchId: string) =>
    signedReq<{ ok: boolean }>('/switch/disarm', 'POST', { switchId }),
  getSwitch: (switchId: string) => req<{ switch: any }>(`/switch?switchId=${switchId}`),
  checkin: (switchId: string) =>
    signedReq<{ ok: boolean; nextCheckAt: number }>('/checkin/respond', 'POST', { switchId }),
  approvalRequest: (switchId: string) =>
    req<any>(`/approval/request?switchId=${switchId}`),
  shares: (switchId: string) =>
    req<{ blobs: string[] }>(`/shares?switchId=${switchId}`),
  approvalSubmit: (switchId: string, share: { x: number; y: string }) =>
    signedReq<{ collected: { x: number; y: string }[] }>('/approval/submit', 'POST', { switchId, share }),
  releaseConfirm: (switchId: string) =>
    signedReq<{ ok: boolean }>('/release/confirm', 'POST', { switchId }),
  // autenticazione passwordless
  authChallenge: (publicKey: string) =>
    req<{ nonce: string }>('/auth/challenge', 'POST', { publicKey }),
  authVerify: (publicKey: string, nonce: string, sig: string) =>
    req<{ ok: boolean; reason?: string; token?: string; ownerId?: string; switches?: any[] }>('/auth/verify', 'POST', { publicKey, nonce, sig }),
  // recovery sociale (fail-safe)
  recoveryInitiate: (ownerId: string, newPublicKey: string, delaySec?: number) =>
    req<{ ok: boolean; recoveryId?: string; unlockAt?: number; reason?: string }>('/recovery/initiate', 'POST', { ownerId, newPublicKey, delaySec }),
  recoveryApprove: (recoveryId: string) =>
    signedReq<{ ok: boolean; approvals?: number; reason?: string }>('/recovery/approve', 'POST', { recoveryId }),
  recoveryFinalize: (recoveryId: string) =>
    req<{ ok: boolean; reason?: string }>('/recovery/finalize', 'POST', { recoveryId }),
  recoveryCancel: (recoveryId: string, sig: string) =>
    req<{ ok: boolean; reason?: string }>('/recovery/cancel', 'POST', { recoveryId, sig }),
  recoveryPendingForContact: (pub: string, ts: number, sig: string) =>
    req<{ recoveries: any[] }>(`/recovery/pending-for-contact?pub=${encodeURIComponent(pub)}&ts=${ts}&sig=${encodeURIComponent(sig)}`),

  auditBackupViewed: (token: string) =>
    req<{ ok: boolean }>('/audit/backup-viewed', 'POST', { token }),
  auditSeedRestoreAck: (token: string, switchId: string) =>
    req<{ ok: boolean }>('/audit/seed-restore-ack', 'POST', { token, switchId }),
  registerPush: (role: 'owner' | 'contact', id: string, pushToken: string) =>
    signedReq<{ ok: boolean }>('/push/register', 'POST', { role, id, pushToken }),

  // Switch in APPROVAL_PENDING o RELEASED per il contatto autenticato a firma.
  // pub: chiave pubblica hex del contatto; ts: timestamp ms; sig: firma compatta P-256.
  pendingApprovals: (pub: string, ts: number, sig: string) =>
    req<{ switches: { switchId: string; ownerName: string; state?: string }[] }>(
      `/pending?pub=${encodeURIComponent(pub)}&ts=${ts}&sig=${encodeURIComponent(sig)}`
    ),

  addContent: (switchId: string, drivePointer: string, contentIv: string, label?: string) =>
    signedReq<{ ok: boolean; contentId: string; nextCheckAt: number }>('/switch/add-content', 'POST', { switchId, drivePointer, contentIv, ...(label !== undefined ? { label } : {}) }),

  removeContent: (switchId: string, contentId: string) =>
    signedReq<{ ok: boolean; nextCheckAt: number }>('/switch/remove-content', 'POST', { switchId, contentId }),

  listContents: (switchId: string) =>
    req<{ contents: { id: string; label: string; created_at: number }[] }>(`/switch/contents?switchId=${switchId}`),

  removeContact: (contactId: string, ownerPub: string, ts: number, sig: string, force?: boolean) =>
    req<{ ok: boolean }>(`/contacts/${contactId}`, 'DELETE', { ownerPub, ts, sig, ...(force ? { force } : {}) }),
  rejectPairing: (contactId: string, contactPub: string, ts: number, sig: string) =>
    req<{ ok: boolean }>(`/contacts/${contactId}/reject`, 'DELETE', { contactPub, ts, sig }),
  rotateContactKey: (contactId: string, newPublicKey: string, ownerPub: string, ts: number, sig: string) =>
    req<{ ok: boolean }>(`/contacts/${contactId}`, 'PUT', { ownerPub, ts, sig, newPublicKey }),

  // audit chain endpoints
  auditAnchor: (ownerId: string, pub: string, ts: number, sig: string) =>
    req<{ ownerId: string; chainIndex: number; hash: string; timestamp_ms: number | null }>(
      `/audit/anchor?ownerId=${encodeURIComponent(ownerId)}&pub=${encodeURIComponent(pub)}&ts=${ts}&sig=${encodeURIComponent(sig)}`
    ),
  auditEvents: (ownerId: string, fromIndex: number, toIndex: number, pub: string, ts: number, sig: string) =>
    req<{ events: any[] }>(
      `/audit/events?ownerId=${encodeURIComponent(ownerId)}&fromIndex=${fromIndex}&toIndex=${toIndex}&pub=${encodeURIComponent(pub)}&ts=${ts}&sig=${encodeURIComponent(sig)}`
    ),
  auditAnchorEvent: (
    eventType: 'ANCHOR_SAVED' | 'VERIFICATION_FAILED' | 'RECOVERY_CONFIRMED_AFTER_VERIFICATION_FAIL' | 'DURESS_FACADE_TRIGGERED' | 'DURESS_SETUP_CHANGED',
    metadata: Record<string, unknown>
  ) =>
    signedReq<{ ok: boolean }>('/audit/anchor-event', 'POST', { eventType, metadata }),

  // Duress trigger: porta tutti gli switch ACTIVE/GRACE in APPROVAL_PENDING
  duressTrigger: () =>
    signedReq<{ ok: boolean; switchesTriggered: number }>('/duress/trigger', 'POST', {}),

  // ── SOLO SVILUPPO (NODE_ENV !== 'production' lato server) ─────────────────
  // Crea 2 contatti fittizi sul server e restituisce le loro chiavi pubbliche.
  // L'app le salva come "verificate" solo per superare il controllo compose.
  // Le quote cifrate verso questi contatti non saranno mai decifrabili.
  seedContacts: (ownerId: string) =>
    req<{ contacts: { contactId: string; publicKey: string }[] }>(
      '/debug/seed-contacts', 'POST', { ownerId }
    ),
};
