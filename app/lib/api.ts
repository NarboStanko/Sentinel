import Constants from 'expo-constants';

const BASE =
  (Constants.expoConfig?.extra?.serverUrl as string) ?? 'http://localhost:4000';

async function req<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  registerOwner: (publicKey: string, displayName?: string) =>
    req<{ ownerId: string }>('/owner/register', 'POST', { publicKey, displayName }),
  createInvite: (ownerId: string) =>
    req<{ token: string; ownerPublicKey: string }>('/invite', 'POST', { ownerId }),
  pair: (token: string, contactPublicKey: string, pushToken?: string) =>
    req<{ contactId: string }>('/pair', 'POST', { token, contactPublicKey, pushToken }),
  contacts: (ownerId: string) =>
    req<{ contacts: any[] }>(`/contacts?ownerId=${ownerId}`),
  createSwitch: (ownerId: string, intervalSec: number, graceSec: number) =>
    req<{ switchId: string }>('/switch/create', 'POST', { ownerId, intervalSec, graceSec }),
  arm: (payload: any) => req<{ ok: boolean }>('/switch/arm', 'POST', payload),
  disarm: (switchId: string) => req<{ ok: boolean }>('/switch/disarm', 'POST', { switchId }),
  getSwitch: (switchId: string) => req<{ switch: any }>(`/switch?switchId=${switchId}`),
  checkin: (switchId: string) => req<{ ok: boolean; nextCheckAt: number }>('/checkin/respond', 'POST', { switchId }),
  approvalRequest: (switchId: string) =>
    req<any>(`/approval/request?switchId=${switchId}`),
  shares: (switchId: string) =>
    req<{ blobs: string[] }>(`/shares?switchId=${switchId}`),
  approvalSubmit: (switchId: string, share: { x: number; y: string }) =>
    req<{ collected: { x: number; y: string }[] }>('/approval/submit', 'POST', { switchId, share }),
  releaseConfirm: (switchId: string) => req<{ ok: boolean }>('/release/confirm', 'POST', { switchId }),
  // recovery sociale (fail-safe)
  recoveryInitiate: (ownerId: string, newPublicKey: string, delaySec?: number) =>
    req<{ recoveryId: string; unlockAt: number }>('/recovery/initiate', 'POST', { ownerId, newPublicKey, delaySec }),
  recoveryApprove: (recoveryId: string, contactPublicKey: string, sig: string) =>
    req<{ ok: boolean; approvals?: number; reason?: string }>('/recovery/approve', 'POST', { recoveryId, contactPublicKey, sig }),
  recoveryFinalize: (recoveryId: string) =>
    req<{ ok: boolean; reason?: string }>('/recovery/finalize', 'POST', { recoveryId }),
  recoveryCancel: (recoveryId: string, sig: string) =>
    req<{ ok: boolean; reason?: string }>('/recovery/cancel', 'POST', { recoveryId, sig }),
  registerPush: (role: 'owner' | 'contact', id: string, pushToken: string) =>
    req<{ ok: boolean }>('/push/register', 'POST', { role, id, pushToken }),

  // Switch in APPROVAL_PENDING per il contatto autenticato a firma.
  // pub: chiave pubblica hex del contatto; ts: timestamp ms; sig: firma compatta P-256.
  pendingApprovals: (pub: string, ts: number, sig: string) =>
    req<{ switches: { switchId: string; ownerName: string }[] }>(
      `/pending?pub=${encodeURIComponent(pub)}&ts=${ts}&sig=${encodeURIComponent(sig)}`
    ),
};
