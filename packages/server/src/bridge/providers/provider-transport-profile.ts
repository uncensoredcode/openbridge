import type { CompiledProviderMessage } from "@uncensoredcode/openbridge/runtime";
import { z } from "zod";

import type { ProviderRecord } from "../stores/provider-store.ts";

const nonEmptyString = (field: string) => z.string().trim().min(1, `${field} is required.`);
const stringMapSchema = z.record(z.string(), z.string()).default({});
const requestSigningSchema = z
  .object({
    kind: z.literal("z-ai-v1")
  })
  .strict();
const requestTemplateSchema = z
  .object({
    method: nonEmptyString("method").default("POST"),
    url: nonEmptyString("url"),
    headers: stringMapSchema,
    body: z.unknown().optional(),
    signing: requestSigningSchema.optional()
  })
  .strict();
const sessionPolicySchema = z
  .object({
    requireCookie: z.boolean().default(false),
    requireBearerToken: z.boolean().default(false),
    requireUserAgent: z.boolean().default(false),
    includeExtraHeaders: z.boolean().default(true)
  })
  .strict();
const promptPolicySchema = z
  .object({
    mode: z.enum(["auto_join", "flatten", "latest_user"]).default("auto_join")
  })
  .strict();
const responseMappingSchema = z
  .object({
    contentPaths: z
      .array(nonEmptyString("content path"))
      .min(1, "At least one content path is required."),
    responseIdPaths: z.array(nonEmptyString("response id path")).default([]),
    conversationIdPaths: z.array(nonEmptyString("conversation id path")).default([]),
    eventFilters: z
      .array(
        z.object({
          path: nonEmptyString("event filter path"),
          equals: z.union([z.string(), z.number(), z.boolean()])
        })
      )
      .default([]),
    fallbackResponseId: z.enum(["assistantMessageId", "userMessageId"]).optional(),
    trimLeadingAssistantBlock: z.boolean().default(false),
    allowVisibleTextFinal: z.boolean().default(false)
  })
  .strict();
const bindingPolicySchema = z
  .object({
    firstTurn: z.enum(["seed", "empty"]).default("seed")
  })
  .strict();
const bootstrapConfigSchema = z
  .object({
    request: requestTemplateSchema,
    conversationIdPath: nonEmptyString("conversationIdPath"),
    parentIdPath: nonEmptyString("parentIdPath").optional()
  })
  .strict();
const proofOfWorkConfigSchema = z
  .object({
    kind: z.literal("sha3-wasm-salt-expiry"),
    headerName: nonEmptyString("headerName"),
    wasmUrl: z.string().url(),
    algorithmPath: nonEmptyString("algorithmPath"),
    challengePath: nonEmptyString("challengePath"),
    saltPath: nonEmptyString("saltPath"),
    signaturePath: nonEmptyString("signaturePath"),
    difficultyPath: nonEmptyString("difficultyPath"),
    expireAtPath: nonEmptyString("expireAtPath"),
    targetPathPath: nonEmptyString("targetPathPath").optional()
  })
  .strict();
const preflightConfigSchema = z
  .object({
    request: requestTemplateSchema,
    headerBindings: stringMapSchema.default({}),
    proofOfWork: proofOfWorkConfigSchema.optional()
  })
  .strict();
const seedBindingSchema = z
  .object({
    conversationId: nonEmptyString("conversationId"),
    parentId: nonEmptyString("parentId").optional()
  })
  .strict();
const transportConfigSchema = z
  .object({
    prompt: promptPolicySchema.default({
      mode: "auto_join"
    }),
    binding: bindingPolicySchema.default({
      firstTurn: "seed"
    }),
    session: sessionPolicySchema.default({
      requireCookie: false,
      requireBearerToken: false,
      requireUserAgent: false,
      includeExtraHeaders: true
    }),
    request: requestTemplateSchema,
    response: responseMappingSchema,
    seedBinding: seedBindingSchema.optional(),
    bootstrap: bootstrapConfigSchema.optional(),
    preflight: preflightConfigSchema.optional()
  })
  .strict();
const transportFamilySchema = z.enum(["http-sse", "http-json", "http-connect"]);
type ProviderTransportFamily = z.infer<typeof transportFamilySchema>;
type ProviderPromptMode = z.infer<typeof promptPolicySchema>["mode"];
type ProviderTransportProfile = {
  family: ProviderTransportFamily;
  models: string[];
  prompt: z.infer<typeof promptPolicySchema>;
  binding: z.infer<typeof bindingPolicySchema>;
  session: z.infer<typeof sessionPolicySchema>;
  request: z.infer<typeof requestTemplateSchema>;
  response: z.infer<typeof responseMappingSchema>;
  seedBinding?: z.infer<typeof seedBindingSchema>;
  bootstrap?: z.infer<typeof bootstrapConfigSchema>;
  preflight?: z.infer<typeof preflightConfigSchema>;
};
function resolveProviderTransportProfile(provider: ProviderRecord | null) {
  if (!provider) {
    return null;
  }
  const family = transportFamilySchema.safeParse(provider.kind);
  if (!family.success) {
    return null;
  }
  const transportConfig = transportConfigSchema.safeParse(provider.config.transport ?? {});
  if (!transportConfig.success) {
    return null;
  }
  return {
    family: family.data,
    models: readConfiguredModelIds(provider.config),
    ...transportConfig.data
  } satisfies ProviderTransportProfile;
}
function readConfiguredModelIds(config: Record<string, unknown>) {
  const configuredModels = config.models;
  if (!Array.isArray(configuredModels)) {
    return [];
  }
  return [
    ...new Set(
      configuredModels
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
    )
  ]
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}
function defaultModelForProviderRecord(provider: ProviderRecord | null) {
  const models = provider ? readConfiguredModelIds(provider.config) : [];
  return models[0] ?? null;
}
function selectProviderPrompt(messages: CompiledProviderMessage[], mode: ProviderPromptMode) {
  if (messages.length === 0) {
    return "";
  }
  if (isBridgeToolAwarePrompt(messages)) {
    return messages
      .map((message) => message.content.trim())
      .filter(Boolean)
      .join("\n\n");
  }
  if (mode === "latest_user") {
    return selectLatestUserPrompt(messages);
  }
  if (messages.length === 1) {
    return messages[0].content.trim();
  }
  if (mode === "flatten") {
    return flattenMessages(messages);
  }
  return flattenMessages(messages);
}
function selectLatestUserPrompt(messages: CompiledProviderMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      return message.content.trim();
    }
  }
  return messages[messages.length - 1].content.trim();
}
function isBridgeToolAwarePrompt(messages: CompiledProviderMessage[]) {
  const systemContent = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const userContent = messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n\n");
  return (
    /OpenAI-compatible tool-calling adapter/i.test(systemContent) &&
    /(Conversation transcript:|Current turn:|Prior turns are already present upstream\.)/i.test(
      userContent
    )
  );
}
function flattenMessages(messages: CompiledProviderMessage[]) {
  return messages
    .map((message) => `${message.role.toUpperCase()}:\n${message.content.trim()}`)
    .join("\n\n")
    .trim();
}

export const providerTransportProfileModule = {
  resolveProviderTransportProfile,
  readConfiguredModelIds,
  defaultModelForProviderRecord,
  selectProviderPrompt
};

export type { ProviderPromptMode, ProviderTransportFamily, ProviderTransportProfile };
