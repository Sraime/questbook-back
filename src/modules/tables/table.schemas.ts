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

export const createSessionSchema = sessionCoreSchema.extend({
  scenarioId: idSchema.optional(),
});

export const patchSessionSchema = sessionCoreSchema
  .partial()
  .extend({
    scenarioId: idSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });

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

/// A non-player character is a name and a free-form note. The description is
/// generous — it is where the game master writes what the thing wants, what it
/// knows and what it does if pressed — but not unbounded, like a session's.
const npcCoreSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(5000),
});

export const createNpcSchema = npcCoreSchema.partial({ description: true });

export const patchNpcSchema = npcCoreSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'At least one field must be provided' },
);

export const sessionNpcParamsSchema = z.object({
  id: idSchema,
  npcId: idSchema,
});

/// A clue is a title and a body the players will read. The body is far more
/// generous than a note: it is a handout, a letter, a page torn from a journal.
const clueCoreSchema = z.object({
  title: z.string().trim().min(1).max(120),
  contentMarkdown: z.string().max(20000),
});

/// `kind` is absent on purpose: a game master only ever creates markdown, and
/// accepting the field would invite an `image` the server cannot honour.
export const createClueSchema = clueCoreSchema.partial({ contentMarkdown: true });

export const patchClueSchema = clueCoreSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'At least one field must be provided' },
);

/// The whole list, every time. An empty array is the legitimate way to take a
/// clue back from everyone, so it must not be refused.
export const setClueAccessSchema = z.object({
  userIds: z.array(idSchema).max(50),
});

export const sessionClueParamsSchema = z.object({
  id: idSchema,
  clueId: idSchema,
});

/// The board arrives whole, as the opaque JSON the app already keeps on the
/// device. The server checks that it is a JSON array and how big it is,
/// nothing more: knowing the shape of a pawn is the client's job, and a
/// server that validated it would have to be updated before any new kind of
/// pawn could be placed.
///
/// The ceiling is a guard against a runaway client, not a design limit — a
/// hundred kilobytes is several hundred pawns.
export const replaceBoardSchema = z.object({
  tokens: z
    .string()
    .max(100_000)
    .refine((value) => {
      try {
        return Array.isArray(JSON.parse(value));
      } catch {
        return false;
      }
    }, { message: 'tokens must be a JSON array' }),
  mapId: z.string().trim().min(1).max(120).nullish(),
});

export type ReplaceBoardInput = z.infer<typeof replaceBoardSchema>;

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
export type CreateNpcInput = z.infer<typeof createNpcSchema>;
export type PatchNpcInput = z.infer<typeof patchNpcSchema>;
export type CreateClueInput = z.infer<typeof createClueSchema>;
export type PatchClueInput = z.infer<typeof patchClueSchema>;
export type SetClueAccessInput = z.infer<typeof setClueAccessSchema>;
export type MemberRole = z.infer<typeof memberRoleSchema>;
export type AttendanceStatus = z.infer<typeof attendanceStatusSchema>;
