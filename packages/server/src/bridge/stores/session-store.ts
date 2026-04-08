import { z } from "zod";

import { bridgeApiErrorModule } from "../../shared/bridge-api-error.ts";

const { BridgeApiError } = bridgeApiErrorModule;
const nonEmptyString = (field: string) => z.string().trim().min(1, `${field} is required.`);
const nullableNonEmptyString = (field: string) => nonEmptyString(field).nullable();
const metadataSchema = z.object({}).catchall(z.unknown());
const sessionSchema = z.object({
  id: nonEmptyString("id"),
  providerId: nullableNonEmptyString("providerId"),
  label: nullableNonEmptyString("label"),
  metadata: metadataSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true })
});
const createSessionRequestSchema = z
  .object({
    id: nonEmptyString("id"),
    providerId: nullableNonEmptyString("providerId").default(null),
    label: nullableNonEmptyString("label").default(null),
    metadata: metadataSchema.default({})
  })
  .strict();
const updateSessionRequestSchema = z
  .object({
    providerId: nullableNonEmptyString("providerId").optional(),
    label: nullableNonEmptyString("label").optional(),
    metadata: metadataSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.keys(value).length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one mutable field must be provided."
      });
    }
  });
const sessionIdParamsSchema = z
  .object({
    id: nonEmptyString("id")
  })
  .strict();
const sessionResponseSchema = z.object({
  session: sessionSchema
});
const sessionListResponseSchema = z.object({
  sessions: z.array(sessionSchema)
});
const sessionDeleteResponseSchema = z.object({
  ok: z.literal(true),
  id: z.string()
});
type SessionRecord = z.infer<typeof sessionSchema>;
type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;
type UpdateSessionRequest = z.infer<typeof updateSessionRequestSchema>;
function createInMemorySessionStore() {
  const sessions = new Map<string, SessionRecord>();
  return {
    list() {
      return [...sessions.values()].map(cloneSession);
    },
    get(id: string) {
      const session = sessions.get(id);
      return session ? cloneSession(session) : null;
    },
    create(input: CreateSessionRequest) {
      if (sessions.has(input.id)) {
        throw new BridgeApiError({
          statusCode: 409,
          code: "session_exists",
          message: `Session '${input.id}' already exists.`
        });
      }
      const timestamp = createTimestamp();
      const session: SessionRecord = {
        id: input.id,
        providerId: input.providerId,
        label: input.label,
        metadata: cloneMetadata(input.metadata),
        createdAt: timestamp,
        updatedAt: timestamp
      };
      sessions.set(session.id, session);
      return cloneSession(session);
    },
    update(id: string, patch: UpdateSessionRequest) {
      const session = sessions.get(id);
      if (!session) {
        throw missingSessionError(id);
      }
      const nextSession: SessionRecord = {
        ...session,
        ...patch,
        metadata: patch.metadata === undefined ? session.metadata : cloneMetadata(patch.metadata),
        updatedAt: createTimestamp(session.updatedAt)
      };
      sessions.set(id, nextSession);
      return cloneSession(nextSession);
    },
    delete(id: string) {
      if (!sessions.delete(id)) {
        throw missingSessionError(id);
      }
      return sessionDeleteResponseSchema.parse({
        ok: true,
        id
      });
    }
  };
}
type SessionStore = ReturnType<typeof createInMemorySessionStore>;
function createTimestamp(previous?: string) {
  const previousTime = previous ? Date.parse(previous) : 0;
  const now = Date.now();
  const nextTime = previousTime >= now ? previousTime + 1 : now;
  return new Date(nextTime).toISOString();
}
function cloneSession(session: SessionRecord): SessionRecord {
  return sessionSchema.parse({
    ...session,
    metadata: cloneMetadata(session.metadata)
  });
}
function cloneMetadata(metadata: Record<string, unknown>) {
  return structuredClone(metadata);
}
function missingSessionError(id: string) {
  return new BridgeApiError({
    statusCode: 404,
    code: "session_not_found",
    message: `Session '${id}' was not found.`
  });
}

export const sessionStoreModule = {
  sessionSchema,
  createSessionRequestSchema,
  updateSessionRequestSchema,
  sessionIdParamsSchema,
  sessionResponseSchema,
  sessionListResponseSchema,
  sessionDeleteResponseSchema,
  createInMemorySessionStore
};

export type { CreateSessionRequest, SessionRecord, SessionStore, UpdateSessionRequest };
