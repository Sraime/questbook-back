import { z } from 'zod';

const idSchema = z.string().uuid();
const isoDate = z.string().datetime({ offset: true });

/// The table creator is a `gm`, everyone who accepts an invitation is a
/// `player`. Only a `gm` may change the table or schedule sessions.
export const memberRoleSchema = z.enum(['gm', 'player']);

/// A missing attendance row means "has not answered", which is why there is no
/// `pending` member here: it is the absence of a value, not a value.
export const attendanceStatusSchema = z.enum(['yes', 'no']);

export const invitationStatusSchema = z.enum([
  'pending',
  'accepted',
  'declined',
  'revoked',
]);

const tableCoreSchema = z.object({
  title: z.string().min(1).max(120),
  universeLabel: z.string().max(120).nullish(),
});

export const createTableSchema = tableCoreSchema;

export const patchTableSchema = tableCoreSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'At least one field must be provided' },
);

/// 320 is the maximum length of an email address per RFC 3696.
export const inviteSchema = z.object({
  email: z.string().email().max(320),
});

const sessionCoreSchema = z.object({
  title: z.string().min(1).max(120),
  description: z.string().max(5000).nullish(),
  startsAt: isoDate,
  location: z.string().min(1).max(200),
});

export const createSessionSchema = sessionCoreSchema;

export const patchSessionSchema = sessionCoreSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'At least one field must be provided' },
);

/// The character is optional here on purpose: a player may confirm first and
/// say who they are playing later, through [attendanceCharacterSchema].
export const attendanceSchema = z.object({
  status: attendanceStatusSchema,
  characterId: idSchema.nullish(),
});

/// `null` detaches the character without touching the answer.
export const attendanceCharacterSchema = z.object({
  characterId: idSchema.nullable(),
});

export const transferGameMasterSchema = z.object({
  userId: idSchema,
});

export const tableIdParamsSchema = z.object({ id: idSchema });

export const tableMemberParamsSchema = z.object({
  id: idSchema,
  userId: idSchema,
});

export const tableInvitationParamsSchema = z.object({
  id: idSchema,
  invitationId: idSchema,
});

export const invitationIdParamsSchema = z.object({ id: idSchema });

export const sessionIdParamsSchema = z.object({ id: idSchema });

export const sessionAttendeeParamsSchema = z.object({
  id: idSchema,
  userId: idSchema,
});

/// The raw token from the emailed link. It is base64url, never a UUID, so it
/// is only bounded rather than shape-checked.
export const invitationTokenParamsSchema = z.object({
  token: z.string().min(1).max(200),
});

export type CreateTableInput = z.infer<typeof createTableSchema>;
export type PatchTableInput = z.infer<typeof patchTableSchema>;
export type InviteInput = z.infer<typeof inviteSchema>;
export type TransferGameMasterInput = z.infer<typeof transferGameMasterSchema>;
export type CreateSessionInput = z.infer<typeof createSessionSchema>;
export type PatchSessionInput = z.infer<typeof patchSessionSchema>;
export type AttendanceInput = z.infer<typeof attendanceSchema>;
export type AttendanceCharacterInput = z.infer<typeof attendanceCharacterSchema>;
export type MemberRole = z.infer<typeof memberRoleSchema>;
export type AttendanceStatus = z.infer<typeof attendanceStatusSchema>;
