import { z, type ZodSchema } from 'zod';
import type { FastifyRequest, FastifyReply } from 'fastify';

export function validateBody(schema: ZodSchema) {
  return async function preHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const message = result.error.errors
        .map((e) => `${e.path.join('.') || 'body'}: ${e.message}`)
        .join('; ');
      reply.code(400).send({ error: 'validation_failed', message });
    }
  };
}

// ── Primitivi riusabili ────────────────────────────────────────────────────────
const Pub = z.string().length(66);            // compressed P-256 hex (33 B)
const Ts  = z.number().int().positive();
const Sig = z.string().length(128);           // compact P-256 signature hex (64 B)
const SwitchId = z.string().startsWith('sw_').max(32);
const auth = { pub: Pub, ts: Ts, sig: Sig };

// ── pairing ───────────────────────────────────────────────────────────────────
export const ownerRegisterSchema = z.object({
  publicKey: Pub,
  displayName: z.string().max(64).optional(),
}).strict();

export const inviteSchema = z.object({
  ...auth,
  ownerId: z.string().max(32).optional(),
}).strict();

export const pairSchema = z.object({
  token:            z.string().min(1).max(64),
  contactPublicKey: Pub,
  pushToken:        z.string().max(512).optional(),
}).strict();

export const rejectSchema = z.object({
  contactPub: Pub,
  ts:         Ts,
  sig:        Sig,
}).strict();

export const removeContactSchema = z.object({
  ownerPub: Pub,
  ts:       Ts,
  sig:      Sig,
  force:    z.boolean().optional(),
}).strict();

export const rotateContactKeySchema = z.object({
  ownerPub:     Pub,
  ts:           Ts,
  sig:          Sig,
  newPublicKey: Pub,
}).strict();

// ── switch ────────────────────────────────────────────────────────────────────
export const switchCreateSchema = z.object({
  intervalSec: z.number().int().positive().max(31 * 86400),
  graceSec:    z.number().int().positive(),
  ...auth,
}).strict();

export const switchArmSchema = z.object({
  switchId:     SwitchId,
  drivePointer: z.string().min(1).max(2048),
  contentIv:    z.string().min(1).max(256),
  label:        z.string().max(128).optional(),
  shares:       z.array(z.object({
    x:    z.number().int().positive(),
    blob: z.string().min(1),
  })),
  recoveryK: z.number().int().positive().max(100).optional(),
  ...auth,
}).strict();

export const addContentSchema = z.object({
  switchId:     SwitchId,
  drivePointer: z.string().min(1).max(2048),
  contentIv:    z.string().min(1).max(256),
  label:        z.string().max(128).optional(),
  ...auth,
}).strict();

export const removeContentSchema = z.object({
  switchId:  SwitchId,
  contentId: z.string().startsWith('sc_').max(32),
  ...auth,
}).strict();

export const disarmSchema = z.object({
  switchId: SwitchId,
  ...auth,
}).strict();

// ── checkin ───────────────────────────────────────────────────────────────────
export const checkinSchema = z.object({
  switchId: SwitchId,
  ...auth,
}).strict();

// ── approvals ─────────────────────────────────────────────────────────────────
export const approvalSubmitSchema = z.object({
  switchId: SwitchId,
  share:    z.object({ x: z.number().int().positive(), y: z.string().min(1) }),
  ...auth,
}).strict();

export const releaseConfirmSchema = z.object({
  switchId: SwitchId,
  ...auth,
}).strict();

// ── push ──────────────────────────────────────────────────────────────────────
export const pushRegisterSchema = z.object({
  role:      z.enum(['owner', 'contact']),
  id:        z.string().min(1).max(32),
  pushToken: z.string().min(1).max(512),
  ...auth,
}).strict();

// ── recovery ──────────────────────────────────────────────────────────────────
export const recoveryInitiateSchema = z.object({
  ownerId:      z.string().startsWith('usr_').max(32),
  newPublicKey: Pub,
  delaySec:     z.number().int().min(0).optional(),
}).strict();

export const recoveryApproveSchema = z.object({
  recoveryId: z.string().startsWith('rec_').max(32),
  ...auth,
}).strict();

export const recoveryFinalizeSchema = z.object({
  recoveryId: z.string().startsWith('rec_').max(32),
}).strict();

export const recoveryCancelSchema = z.object({
  recoveryId: z.string().startsWith('rec_').max(32),
  sig:        Sig,
}).strict();

// ── auth ──────────────────────────────────────────────────────────────────────
export const authChallengeSchema = z.object({
  publicKey: Pub,
}).strict();

export const authVerifySchema = z.object({
  publicKey: Pub,
  nonce:     z.string().min(1).max(128),
  sig:       Sig,
}).strict();

// ── debug ─────────────────────────────────────────────────────────────────────
export const debugSeedContactsSchema = z.object({
  ownerId: z.string().startsWith('usr_').max(32),
}).strict();

// ── devblob ───────────────────────────────────────────────────────────────────
export const devBlobSchema = z.object({
  data: z.string().min(1),
}).strict();
