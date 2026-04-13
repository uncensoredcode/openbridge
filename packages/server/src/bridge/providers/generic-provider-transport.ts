import { Buffer } from "node:buffer";
import { createHmac, randomUUID } from "node:crypto";

import type { ProviderTransportRequest } from "@uncensoredcode/openbridge/runtime";
import { bridgeRuntime } from "@uncensoredcode/openbridge/runtime";

import { redactSensitiveValuesModule } from "../../security/redact-sensitive-values.ts";
import { outputModule } from "../../shared/output.ts";
import type { CollectedProviderCompletion, ProviderStreamFragment } from "./provider-streams.ts";
import { providerStreamsModule } from "./provider-streams.ts";
import type { ProviderTransportProfile } from "./provider-transport-profile.ts";
import { providerTransportProfileModule } from "./provider-transport-profile.ts";

const { ProviderFailure } = bridgeRuntime;
const { sanitizeSensitiveText } = redactSensitiveValuesModule;
const { sanitizeBridgeApiOutput } = outputModule;
const {
  collectConnectJsonCompletion,
  collectSseCompletion,
  createSseJsonEventParser,
  normalizeLeadingAssistantBlock,
  streamConnectJsonFragments,
  streamSseFragments
} = providerStreamsModule;
const { selectProviderPrompt } = providerTransportProfileModule;
type ProviderStreamBinding = Pick<
  NonNullable<ProviderTransportRequest["upstreamBinding"]>,
  "conversationId" | "parentId"
> | null;
type DynamicTemplateState = {
  requestUuid: string;
  userMessageId: string;
  assistantMessageId: string;
  unixTimestampSec: number;
  unixTimestampMs: number;
};
const OMIT_TEMPLATE_VALUE = Symbol("omit_template_value");
type ProviderTransportStream = {
  content: AsyncIterable<ProviderStreamFragment>;
  upstreamBinding: Promise<ProviderStreamBinding>;
};
type CollectedProviderTransportCompletion = {
  providerId: string;
  modelId: string;
  prompt: string;
  conversationId: string;
  completion: CollectedProviderCompletion;
  upstreamBinding: ProviderStreamBinding;
};
async function collectGenericProviderCompletion(input: {
  stateRoot: string;
  session: {
    cookie?: string;
    bearerToken?: string;
    extraHeaders?: Record<string, string>;
    userAgent?: string;
  };
  request: ProviderTransportRequest;
  profile: ProviderTransportProfile;
}) {
  const prompt = selectProviderPrompt(input.request.messages, input.profile.prompt.mode);
  const binding = await ensureConversationBinding(
    input.request,
    input.profile,
    input.session,
    prompt
  );
  const renderContext = ensureDynamicTemplateState({
    request: input.request,
    prompt,
    conversationId: binding.conversationId,
    parentId: binding.parentId
  });
  const preparedHeaders = await resolvePreparedRequestHeaders(
    input.profile,
    input.session,
    renderContext
  );
  const response = await sendConfiguredRequest(
    input.profile.request,
    input.profile,
    input.session,
    renderContext,
    preparedHeaders
  );
  const completion =
    input.profile.family === "http-sse"
      ? await collectSseCompletion(
          response.body,
          createSseJsonEventParser({
            contentPaths: input.profile.response.contentPaths,
            responseIdPaths: input.profile.response.responseIdPaths,
            conversationIdPaths: input.profile.response.conversationIdPaths,
            eventFilters: input.profile.response.eventFilters
          }),
          input.profile.response.trimLeadingAssistantBlock
            ? normalizeLeadingAssistantBlock
            : undefined
        )
      : input.profile.family === "http-connect"
        ? await collectConnectJsonCompletion(
            response.body,
            {
              contentPaths: input.profile.response.contentPaths,
              responseIdPaths: input.profile.response.responseIdPaths,
              conversationIdPaths: input.profile.response.conversationIdPaths,
              eventFilters: input.profile.response.eventFilters
            },
            input.profile.response.trimLeadingAssistantBlock
              ? normalizeLeadingAssistantBlock
              : undefined
          )
        : await collectJsonCompletion(response, input.profile, input.request.providerId);
  const completionWithFallback = applyConfiguredResponseIdFallback(completion, input.profile, {
    ...renderContext
  });
  const normalizedCompletion = input.profile.response.allowVisibleTextFinal
    ? {
        ...completionWithFallback,
        content: wrapVisibleTextAsFinalPacket(completionWithFallback.content)
      }
    : completionWithFallback;
  return {
    providerId: input.request.providerId,
    modelId: input.request.modelId,
    prompt,
    conversationId: binding.conversationId,
    completion: normalizedCompletion,
    upstreamBinding: resolveNextBinding(
      binding,
      normalizedCompletion.responseId,
      normalizedCompletion.conversationId,
      input.request.upstreamBinding
    )
  } satisfies CollectedProviderTransportCompletion;
}
async function openGenericProviderStream(input: {
  stateRoot: string;
  session: {
    cookie?: string;
    bearerToken?: string;
    extraHeaders?: Record<string, string>;
    userAgent?: string;
  };
  request: ProviderTransportRequest;
  profile: ProviderTransportProfile;
}) {
  const prompt = selectProviderPrompt(input.request.messages, input.profile.prompt.mode);
  const binding = await ensureConversationBinding(
    input.request,
    input.profile,
    input.session,
    prompt
  );
  const renderContext = ensureDynamicTemplateState({
    request: input.request,
    prompt,
    conversationId: binding.conversationId,
    parentId: binding.parentId
  });
  const preparedHeaders = await resolvePreparedRequestHeaders(
    input.profile,
    input.session,
    renderContext
  );
  const response = await sendConfiguredRequest(
    input.profile.request,
    input.profile,
    input.session,
    renderContext,
    preparedHeaders
  );
  if (input.profile.family === "http-json") {
    const completion = applyConfiguredResponseIdFallback(
      await collectJsonCompletion(response, input.profile, input.request.providerId),
      input.profile,
      renderContext
    );
    return {
      content: singleFragmentStream(
        completion.content,
        completion.responseId,
        completion.conversationId
      ),
      upstreamBinding: Promise.resolve(
        resolveNextBinding(
          binding,
          completion.responseId,
          completion.conversationId,
          input.request.upstreamBinding
        )
      )
    } satisfies ProviderTransportStream;
  }
  if (input.profile.family === "http-connect") {
    let resolveBinding: (binding: ProviderStreamBinding) => void = () => {};
    const bindingPromise = new Promise<ProviderStreamBinding>((resolve) => {
      resolveBinding = resolve;
    });
    return {
      content: maybeWrapVisibleTextFinalStream(
        streamConnectJsonFragments(
          response.body,
          {
            contentPaths: input.profile.response.contentPaths,
            responseIdPaths: input.profile.response.responseIdPaths,
            conversationIdPaths: input.profile.response.conversationIdPaths,
            eventFilters: input.profile.response.eventFilters
          },
          (completion) => {
            const completionWithFallback = applyConfiguredResponseIdFallback(
              completion,
              input.profile,
              {
                ...renderContext
              }
            );
            const normalized = input.profile.response.trimLeadingAssistantBlock
              ? {
                  ...completionWithFallback,
                  content: normalizeLeadingAssistantBlock(completionWithFallback.content)
                }
              : completionWithFallback;
            resolveBinding(
              resolveNextBinding(
                binding,
                normalized.responseId,
                normalized.conversationId,
                input.request.upstreamBinding
              )
            );
          }
        ),
        input.profile.response.allowVisibleTextFinal
      ),
      upstreamBinding: bindingPromise
    } satisfies ProviderTransportStream;
  }
  let resolveBinding: (binding: ProviderStreamBinding) => void = () => {};
  const bindingPromise = new Promise<ProviderStreamBinding>((resolve) => {
    resolveBinding = resolve;
  });
  return {
    content: maybeWrapVisibleTextFinalStream(
      streamSseFragments(
        response.body,
        createSseJsonEventParser({
          contentPaths: input.profile.response.contentPaths,
          responseIdPaths: input.profile.response.responseIdPaths,
          conversationIdPaths: input.profile.response.conversationIdPaths,
          eventFilters: input.profile.response.eventFilters
        }),
        (completion) => {
          const completionWithFallback = applyConfiguredResponseIdFallback(
            completion,
            input.profile,
            {
              ...renderContext
            }
          );
          const normalized = input.profile.response.trimLeadingAssistantBlock
            ? {
                ...completionWithFallback,
                content: normalizeLeadingAssistantBlock(completionWithFallback.content)
              }
            : completionWithFallback;
          resolveBinding(
            resolveNextBinding(
              binding,
              normalized.responseId,
              normalized.conversationId,
              input.request.upstreamBinding
            )
          );
        }
      ),
      input.profile.response.allowVisibleTextFinal
    ),
    upstreamBinding: bindingPromise
  } satisfies ProviderTransportStream;
}
type RenderContext = {
  request: ProviderTransportRequest;
  prompt: string;
  conversationId: string;
  parentId: string;
  dynamic?: DynamicTemplateState;
};
function resolveNextBinding(
  binding: {
    conversationId: string;
    parentId: string;
  },
  responseId: string,
  responseConversationId: string,
  fallback: ProviderStreamBinding
) {
  const nextConversationId =
    binding.conversationId || responseConversationId || fallback?.conversationId || "";
  if (!nextConversationId) {
    return fallback;
  }
  return {
    conversationId: nextConversationId,
    parentId: responseId || binding.parentId || fallback?.parentId || ""
  } satisfies NonNullable<ProviderStreamBinding>;
}
async function ensureConversationBinding(
  request: ProviderTransportRequest,
  profile: ProviderTransportProfile,
  session: {
    cookie?: string;
    bearerToken?: string;
    extraHeaders?: Record<string, string>;
    userAgent?: string;
  },
  prompt: string
) {
  const existingConversationId = request.upstreamBinding?.conversationId ?? "";
  const existingParentId = request.upstreamBinding?.parentId ?? "";
  if (existingConversationId) {
    return {
      conversationId: existingConversationId,
      parentId: existingParentId
    };
  }
  if (profile.binding.firstTurn !== "empty" && profile.seedBinding?.conversationId) {
    return {
      conversationId: profile.seedBinding.conversationId,
      parentId: profile.seedBinding.parentId ?? ""
    };
  }
  if (!profile.bootstrap) {
    return {
      conversationId: "",
      parentId: ""
    };
  }
  const bootstrapResponse = await sendConfiguredRequest(
    profile.bootstrap.request,
    profile,
    session,
    {
      request,
      prompt,
      conversationId: "",
      parentId: ""
    }
  );
  const payload = await readJsonResponse(bootstrapResponse, request.providerId, "bootstrap");
  const conversationId = extractBootstrapConversationId(
    payload,
    profile.bootstrap.conversationIdPath
  );
  if (!conversationId) {
    throw new ProviderFailure({
      kind: "permanent",
      code: "request_invalid",
      message: `Provider "${request.providerId}" bootstrap response did not contain a conversation id at "${profile.bootstrap.conversationIdPath}".`,
      displayMessage: "Provider conversation bootstrap is misconfigured.",
      retryable: false,
      sessionResetEligible: false
    });
  }
  return {
    conversationId,
    parentId: profile.bootstrap.parentIdPath
      ? extractFirstString(payload, profile.bootstrap.parentIdPath)
      : ""
  };
}
async function sendConfiguredRequest(
  template: ProviderTransportProfile["request"],
  profile: ProviderTransportProfile,
  session: {
    cookie?: string;
    bearerToken?: string;
    extraHeaders?: Record<string, string>;
    userAgent?: string;
  },
  context: RenderContext,
  preparedHeaders: Record<string, string> = {}
) {
  const renderContext = ensureDynamicTemplateState(context);
  const headers = buildRequestHeaders(
    profile,
    session,
    template.headers,
    renderContext,
    preparedHeaders
  );
  const signedRequest = applyConfiguredRequestSigning(
    template,
    session,
    renderContext,
    renderTemplateString(template.url, renderContext),
    headers
  );
  const init: RequestInit = {
    method: template.method,
    headers: signedRequest.headers
  };
  if (template.body !== undefined) {
    const renderedBody = renderTemplateValue(template.body, renderContext);
    init.body =
      profile.family === "http-connect"
        ? encodeConnectBody(renderedBody)
        : typeof renderedBody === "string"
          ? renderedBody
          : JSON.stringify(renderedBody);
    if (!hasHeader(signedRequest.headers, "content-type")) {
      signedRequest.headers["Content-Type"] =
        profile.family === "http-connect" ? "application/connect+json" : "application/json";
    }
  }
  const response = await fetch(signedRequest.url, init);
  if (!response.ok) {
    const responsePreview = sanitizeProviderErrorPreview(await safeReadResponseText(response));
    throw new ProviderFailure({
      kind: response.status >= 500 ? "transient" : "permanent",
      code: response.status >= 500 ? "transport_error" : "request_invalid",
      message: `Provider request failed with status ${response.status} for ${signedRequest.url}.`,
      displayMessage: `Provider request failed with HTTP ${response.status}.`,
      retryable: response.status >= 500,
      sessionResetEligible: response.status === 401 || response.status === 403,
      details: {
        stage: "request",
        httpStatus: response.status,
        responsePreview: responsePreview || undefined
      }
    });
  }
  return response;
}
async function safeReadResponseText(response: Response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
function sanitizeProviderErrorPreview(value: string, maxLength = 600) {
  const normalized = sanitizeSensitiveText(value).replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength)}...`;
}
async function resolvePreparedRequestHeaders(
  profile: ProviderTransportProfile,
  session: {
    cookie?: string;
    bearerToken?: string;
    extraHeaders?: Record<string, string>;
    userAgent?: string;
  },
  context: RenderContext
) {
  if (!profile.preflight) {
    return {};
  }
  const response = await sendConfiguredRequest(
    profile.preflight.request,
    profile,
    session,
    context
  );
  const payload = await readJsonResponse(response, context.request.providerId, "preflight");
  const resolvedHeaders = Object.fromEntries(
    Object.entries(profile.preflight.headerBindings).flatMap(([headerName, path]) => {
      const value = extractFirstString(payload, path);
      return value ? [[headerName, value]] : [];
    })
  );
  if (!profile.preflight.proofOfWork) {
    return resolvedHeaders;
  }
  return {
    ...resolvedHeaders,
    [profile.preflight.proofOfWork.headerName]: await renderProofOfWorkHeader(
      profile.preflight.proofOfWork,
      payload,
      context.request.providerId
    )
  };
}
function buildRequestHeaders(
  profile: ProviderTransportProfile,
  session: {
    cookie?: string;
    bearerToken?: string;
    extraHeaders?: Record<string, string>;
    userAgent?: string;
  },
  configuredHeaders: Record<string, string>,
  context: RenderContext,
  preparedHeaders: Record<string, string> = {}
) {
  const headers: Record<string, string> = profile.session.includeExtraHeaders
    ? {
        ...(session.extraHeaders ?? {})
      }
    : {};
  if (profile.session.requireCookie) {
    headers.Cookie = requireSessionField(session.cookie, context.request.providerId, "cookie");
  }
  if (profile.session.requireBearerToken) {
    headers.Authorization = `Bearer ${requireSessionField(session.bearerToken, context.request.providerId, "bearerToken")}`;
  }
  if (profile.session.requireUserAgent) {
    headers["User-Agent"] = requireSessionField(
      session.userAgent,
      context.request.providerId,
      "userAgent"
    );
  }
  for (const [key, value] of Object.entries(configuredHeaders)) {
    headers[key] = renderTemplateString(value, context);
  }
  for (const [key, value] of Object.entries(preparedHeaders)) {
    headers[key] = value;
  }
  return headers;
}
async function collectJsonCompletion(
  response: Response,
  profile: ProviderTransportProfile,
  providerId: string
): Promise<CollectedProviderCompletion> {
  const payload = await readJsonResponse(response, providerId, "request");
  if (!matchesEventFilters(payload, profile.response.eventFilters)) {
    return {
      content: "",
      responseId: "",
      conversationId: "",
      eventCount: 0,
      fragmentCount: 0
    };
  }
  const content =
    profile.response.contentPaths.map((path) => extractFirstString(payload, path)).find(Boolean) ??
    "";
  const responseId =
    profile.response.responseIdPaths
      .map((path) => extractFirstString(payload, path))
      .find(Boolean) ?? "";
  const conversationId =
    profile.response.conversationIdPaths
      .map((path) => extractFirstString(payload, path))
      .find(Boolean) ?? "";
  return {
    content: profile.response.trimLeadingAssistantBlock
      ? normalizeLeadingAssistantBlock(content)
      : content.trim(),
    responseId,
    conversationId,
    eventCount: content ? 1 : 0,
    fragmentCount: content ? 1 : 0
  };
}
async function readJsonResponse(response: Response, providerId: string, phase: string) {
  try {
    return (await response.json()) as unknown;
  } catch (error) {
    throw new ProviderFailure({
      kind: "permanent",
      code: "request_invalid",
      message: `Provider "${providerId}" returned invalid JSON during ${phase}.`,
      displayMessage: "Provider response format is invalid.",
      retryable: false,
      sessionResetEligible: false,
      cause: error
    });
  }
}
function renderTemplateValue(value: unknown, context: RenderContext): unknown {
  if (typeof value === "string") {
    const exactTemplate = value.match(/^\{\{\s*(\w+)\s*\}\}$/);
    if (exactTemplate) {
      return resolveTemplateToken(exactTemplate[1], context);
    }
    return renderTemplateString(value, context);
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => renderTemplateValue(entry, context))
      .filter((entry) => entry !== OMIT_TEMPLATE_VALUE);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, entry]) => {
        const rendered = renderTemplateValue(entry, context);
        return rendered === OMIT_TEMPLATE_VALUE ? [] : [[key, rendered]];
      })
    );
  }
  return value;
}
function renderTemplateString(template: string, context: RenderContext) {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => {
    const resolved = resolveTemplateToken(key, context);
    return typeof resolved === "string" ? resolved : String(resolved ?? "");
  });
}
function resolveTemplateToken(
  key: string,
  context: RenderContext
): string | number | boolean | null | symbol {
  const dynamic = ensureDynamicTemplateState(context).dynamic;
  const modelVariant = parseBridgeModelVariant(context.request.modelId);
  switch (key) {
    case "prompt":
      return context.prompt;
    case "modelId":
      return modelVariant.baseModelId;
    case "publicModelId":
      return context.request.modelId;
    case "providerId":
      return context.request.providerId;
    case "requestId":
      return context.request.requestId;
    case "requestUuid":
      return dynamic.requestUuid;
    case "messageId":
      return dynamic.userMessageId;
    case "userMessageId":
      return dynamic.userMessageId;
    case "assistantMessageId":
      return dynamic.assistantMessageId;
    case "sessionId":
      return context.request.sessionId;
    case "conversationId":
      return context.conversationId;
    case "conversationIdOrOmit":
      return context.conversationId || OMIT_TEMPLATE_VALUE;
    case "parentId":
      return context.parentId;
    case "parentIdOrClientCreatedRoot":
      return context.parentId || "client-created-root";
    case "parentIdOrOmit":
      return context.parentId || OMIT_TEMPLATE_VALUE;
    case "parentIdOrNull":
      return context.parentId || null;
    case "parentIdNumberOrNull":
      return normalizeNumericTemplateValue(context.parentId);
    case "parentIdNumberOrOmit": {
      const normalized = normalizeNumericTemplateValue(context.parentId);
      return normalized === null ? OMIT_TEMPLATE_VALUE : normalized;
    }
    case "unixTimestampSec":
      return dynamic.unixTimestampSec;
    case "unixTimestampMs":
      return dynamic.unixTimestampMs;
    case "currentDateTime":
      return formatCurrentDateTime();
    case "currentDate":
      return formatCurrentDate();
    case "currentTime":
      return formatCurrentTime();
    case "currentWeekday":
      return formatCurrentWeekday();
    case "currentTimezone":
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    case "userLanguage":
      return "en-US";
    case "userName":
      return "User";
    case "thinkingEnabled":
      return modelVariant.thinkingEnabled ?? false;
    case "thinkingEnabledOrTrue":
      return modelVariant.thinkingEnabled ?? true;
    case "thinkingEnabledOrFalse":
      return modelVariant.thinkingEnabled ?? false;
    case "null":
      return null;
    default:
      return "";
  }
}
function parseBridgeModelVariant(modelId: string) {
  const trimmed = modelId.trim();
  if (trimmed.endsWith("@thinking")) {
    return {
      baseModelId: trimmed.slice(0, -"@thinking".length),
      thinkingEnabled: true
    };
  }
  if (trimmed.endsWith("@instant")) {
    return {
      baseModelId: trimmed.slice(0, -"@instant".length),
      thinkingEnabled: false
    };
  }
  if (trimmed.endsWith("@no-thinking")) {
    return {
      baseModelId: trimmed.slice(0, -"@no-thinking".length),
      thinkingEnabled: false
    };
  }
  return {
    baseModelId: trimmed,
    thinkingEnabled: null
  };
}
function normalizeNumericTemplateValue(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (/^-?(?:0|[1-9]\d*)$/.test(trimmed)) {
    const normalized = Number(trimmed);
    if (Number.isSafeInteger(normalized)) {
      return normalized;
    }
  }
  return trimmed;
}
function ensureDynamicTemplateState(context: RenderContext): RenderContext & {
  dynamic: DynamicTemplateState;
} {
  if (context.dynamic) {
    return context as RenderContext & {
      dynamic: DynamicTemplateState;
    };
  }
  const now = Date.now();
  context.dynamic = {
    requestUuid: randomUUID(),
    userMessageId: randomUUID(),
    assistantMessageId: randomUUID(),
    unixTimestampSec: Math.floor(now / 1000),
    unixTimestampMs: now
  };
  return context as RenderContext & {
    dynamic: DynamicTemplateState;
  };
}
function applyConfiguredResponseIdFallback(
  completion: CollectedProviderCompletion,
  profile: ProviderTransportProfile,
  context: RenderContext
) {
  if (completion.responseId || !profile.response.fallbackResponseId) {
    return completion;
  }
  const dynamic = ensureDynamicTemplateState(context).dynamic;
  const responseId =
    profile.response.fallbackResponseId === "assistantMessageId"
      ? dynamic.assistantMessageId
      : dynamic.userMessageId;
  return {
    ...completion,
    responseId
  } satisfies CollectedProviderCompletion;
}
function applyConfiguredRequestSigning(
  template: ProviderTransportProfile["request"],
  session: {
    cookie?: string;
    bearerToken?: string;
    extraHeaders?: Record<string, string>;
    userAgent?: string;
  },
  context: RenderContext & {
    dynamic: DynamicTemplateState;
  },
  renderedUrl: string,
  headers: Record<string, string>
) {
  if (!template.signing) {
    return {
      url: renderedUrl,
      headers
    };
  }
  if (template.signing.kind !== "z-ai-v1") {
    return {
      url: renderedUrl,
      headers
    };
  }
  const prepared = buildZaiSignedRequest(renderedUrl, session, context);
  return {
    url: prepared.url,
    headers: {
      ...headers,
      "X-FE-Version": headers["X-FE-Version"] || "prod-fe-1.1.2",
      "X-Signature": prepared.signature
    }
  };
}
function buildZaiSignedRequest(
  baseUrl: string,
  session: {
    bearerToken?: string;
    extraHeaders?: Record<string, string>;
    userAgent?: string;
  },
  context: RenderContext & {
    dynamic: DynamicTemplateState;
  }
) {
  const timestamp = String(context.dynamic.unixTimestampMs);
  const requestId = context.dynamic.requestUuid;
  const bearerToken = session.bearerToken ?? "";
  const userId = readSessionJwtField(session.bearerToken, "id");
  const language = readPreferredLanguageFromSession(session.extraHeaders);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const currentUrl = `https://chat.z.ai/c/${context.conversationId}`;
  const pathname = `/c/${context.conversationId}`;
  const localTimeIso = new Date(context.dynamic.unixTimestampMs).toISOString();
  const query = new URLSearchParams([
    ["timestamp", timestamp],
    ["requestId", requestId],
    ["user_id", userId],
    ["version", "0.0.1"],
    ["platform", "web"],
    ["token", bearerToken],
    ["user_agent", session.userAgent ?? ""],
    ["language", language],
    ["languages", language],
    ["timezone", timezone],
    ["cookie_enabled", "true"],
    ["current_url", currentUrl],
    ["pathname", pathname],
    ["search", ""],
    ["hash", ""],
    ["host", "chat.z.ai"],
    ["hostname", "chat.z.ai"],
    ["protocol", "https:"],
    ["referrer", ""],
    ["title", "New Chat | Z.ai - Free AI Chatbot & Agent powered by GLM-5.1 & GLM-5"],
    ["timezone_offset", String(-new Date().getTimezoneOffset())],
    ["local_time", localTimeIso],
    ["utc_time", new Date(context.dynamic.unixTimestampMs).toUTCString()],
    ["is_mobile", "false"],
    ["is_touch", "false"],
    ["max_touch_points", "0"],
    ["browser_name", "Unknown"],
    ["os_name", "Unknown"],
    ["signature_timestamp", timestamp]
  ]);
  const signature = buildZaiSignature(
    [
      ["requestId", requestId],
      ["timestamp", timestamp],
      ["user_id", userId]
    ],
    context.prompt.trim(),
    timestamp
  );
  const url = new URL(baseUrl);
  for (const [key, value] of query.entries()) {
    url.searchParams.set(key, value);
  }
  return {
    url: url.toString(),
    signature
  };
}
function buildZaiSignature(entries: Array<[string, string]>, prompt: string, timestamp: string) {
  const sortedPayload = [...entries]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .flatMap(([key, value]) => [key, value])
    .join(",");
  const promptBase64 = Buffer.from(prompt, "utf8").toString("base64");
  const data = `${sortedPayload}|${promptBase64}|${timestamp}`;
  const bucket = Math.floor(Number(timestamp) / (5 * 60 * 1000));
  const bucketKey = createHmac("sha256", "key-@@@@)))()((9))-xxxx&&&%%%%%")
    .update(String(bucket))
    .digest("hex");
  return createHmac("sha256", bucketKey).update(data).digest("hex");
}
function matchesEventFilters(
  payload: unknown,
  filters: ProviderTransportProfile["response"]["eventFilters"]
) {
  if (filters.length === 0) {
    return true;
  }
  return filters.every((filter) => {
    const values = extractPathValues(payload, filter.path.split(".").filter(Boolean));
    return values.some((value) => value === filter.equals);
  });
}
function readPreferredLanguageFromSession(headers: Record<string, string> | undefined) {
  const acceptLanguage =
    Object.entries(headers ?? {})
      .find(([key]) => key.toLowerCase() === "accept-language")?.[1]
      ?.trim() ?? "";
  if (!acceptLanguage) {
    return "en-US";
  }
  return (
    acceptLanguage
      .split(",")
      .map((entry) => entry.split(";")[0]?.trim())
      .find(Boolean) ?? "en-US"
  );
}
function readSessionJwtField(token: string | undefined, field: string) {
  const source = token?.trim();
  if (!source) {
    return "";
  }
  const parts = source.split(".");
  if (parts.length < 2) {
    return "";
  }
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<
      string,
      unknown
    >;
    return typeof payload[field] === "string" ? payload[field] : "";
  } catch {
    return "";
  }
}
function formatCurrentDateTime() {
  const now = new Date();
  return `${formatCurrentDate(now)} ${formatCurrentTime(now)}`;
}
function formatCurrentDate(now = new Date()) {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  ].join("-");
}
function formatCurrentTime(now = new Date()) {
  return [
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0")
  ].join(":");
}
function formatCurrentWeekday(now = new Date()) {
  return new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(now);
}
function extractFirstString(payload: unknown, path: string) {
  for (const value of extractPathValues(payload, path.split(".").filter(Boolean))) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return "";
}
function extractBootstrapConversationId(payload: unknown, configuredPath: string) {
  const candidates = [configuredPath];
  if (configuredPath.endsWith(".id")) {
    candidates.push(configuredPath.replace(/\.id$/, ".chat_session.id"));
    candidates.push(configuredPath.replace(/\.id$/, ".chat_session_id"));
  }
  if (configuredPath.endsWith(".chat_session.id")) {
    candidates.push(configuredPath.replace(/\.chat_session\.id$/, ".id"));
  }
  if (configuredPath.endsWith(".chat_session_id")) {
    candidates.push(configuredPath.replace(/\.chat_session_id$/, ".id"));
  }
  for (const path of [
    "data.biz_data.chat_session.id",
    "data.biz_data.chat_session_id",
    "data.biz_data.id",
    "data.chat_session.id",
    "data.chat_session_id",
    "data.id",
    "chat_session.id",
    "chat_session_id",
    "id"
  ]) {
    if (!candidates.includes(path)) {
      candidates.push(path);
    }
  }
  for (const path of candidates) {
    const value = extractFirstString(payload, path);
    if (value) {
      return value;
    }
  }
  return "";
}
function extractFirstNumber(payload: unknown, path: string) {
  for (const value of extractPathValues(payload, path.split(".").filter(Boolean))) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const normalized = Number(value.trim());
      if (Number.isFinite(normalized)) {
        return normalized;
      }
    }
  }
  return null;
}
async function renderProofOfWorkHeader(
  proof: NonNullable<ProviderTransportProfile["preflight"]>["proofOfWork"],
  payload: unknown,
  providerId: string
) {
  if (!proof) {
    return "";
  }
  const algorithm = requiredPathString(payload, proof.algorithmPath, providerId, "preflight");
  const challenge = requiredPathString(payload, proof.challengePath, providerId, "preflight");
  const salt = requiredPathString(payload, proof.saltPath, providerId, "preflight");
  const signature = requiredPathString(payload, proof.signaturePath, providerId, "preflight");
  const difficulty = requiredPathNumber(payload, proof.difficultyPath, providerId, "preflight");
  const expireAt = requiredPathNumber(payload, proof.expireAtPath, providerId, "preflight");
  const targetPath = proof.targetPathPath ? extractFirstString(payload, proof.targetPathPath) : "";
  if (proof.kind !== "sha3-wasm-salt-expiry") {
    throw new ProviderFailure({
      kind: "permanent",
      code: "request_invalid",
      message: `Provider "${providerId}" uses an unsupported proof-of-work configuration.`,
      displayMessage: "Provider proof-of-work configuration is invalid.",
      retryable: false,
      sessionResetEligible: false
    });
  }
  let answer: number;
  try {
    answer = await solveSha3WasmSaltExpiryProof({
      wasmUrl: proof.wasmUrl,
      challenge,
      salt,
      expireAt,
      difficulty
    });
  } catch (error) {
    throw new ProviderFailure({
      kind: "permanent",
      code: "request_invalid",
      message: `Provider "${providerId}" proof-of-work preparation failed.`,
      displayMessage: "Provider request preparation failed.",
      retryable: false,
      sessionResetEligible: false,
      cause: error
    });
  }
  return Buffer.from(
    JSON.stringify({
      algorithm,
      challenge,
      salt,
      answer,
      signature,
      ...(targetPath ? { target_path: targetPath } : {})
    }),
    "utf8"
  ).toString("base64");
}
function requiredPathString(payload: unknown, path: string, providerId: string, phase: string) {
  const value = extractFirstString(payload, path);
  if (value) {
    return value;
  }
  throw new ProviderFailure({
    kind: "permanent",
    code: "request_invalid",
    message: `Provider "${providerId}" ${phase} response did not contain a string value at "${path}".`,
    displayMessage: "Provider request preparation is misconfigured.",
    retryable: false,
    sessionResetEligible: false
  });
}
function requiredPathNumber(payload: unknown, path: string, providerId: string, phase: string) {
  const value = extractFirstNumber(payload, path);
  if (value !== null) {
    return value;
  }
  throw new ProviderFailure({
    kind: "permanent",
    code: "request_invalid",
    message: `Provider "${providerId}" ${phase} response did not contain a numeric value at "${path}".`,
    displayMessage: "Provider request preparation is misconfigured.",
    retryable: false,
    sessionResetEligible: false
  });
}
type WasmPowModule = {
  memory: WebAssembly.Memory;
  wasm_solve: (
    retptr: number,
    challengePtr: number,
    challengeLen: number,
    prefixPtr: number,
    prefixLen: number,
    difficulty: number
  ) => void;
  __wbindgen_add_to_stack_pointer: (delta: number) => number;
  __wbindgen_export_0: (length: number, align: number) => number;
  __wbindgen_export_1: (
    pointer: number,
    oldLength: number,
    newLength: number,
    align: number
  ) => number;
};
const wasmPowModuleCache = new Map<string, Promise<WasmPowModule>>();
async function solveSha3WasmSaltExpiryProof(input: {
  wasmUrl: string;
  challenge: string;
  salt: string;
  expireAt: number;
  difficulty: number;
}) {
  const wasm = await loadWasmPowModule(input.wasmUrl);
  let cachedBytes: Uint8Array | null = null;
  let cachedView: DataView | null = null;
  let vectorLength = 0;
  const encoder = new TextEncoder();
  const memoryBytes = () => {
    if (!cachedBytes || cachedBytes.buffer !== wasm.memory.buffer) {
      cachedBytes = new Uint8Array(wasm.memory.buffer);
    }
    return cachedBytes;
  };
  const memoryView = () => {
    if (!cachedView || cachedView.buffer !== wasm.memory.buffer) {
      cachedView = new DataView(wasm.memory.buffer);
    }
    return cachedView;
  };
  const passString = (value: string) => {
    let length = value.length;
    let pointer = wasm.__wbindgen_export_0(length, 1) >>> 0;
    let offset = 0;
    const bytes = memoryBytes();
    for (; offset < length; offset += 1) {
      const code = value.charCodeAt(offset);
      if (code > 0x7f) {
        break;
      }
      bytes[pointer + offset] = code;
    }
    if (offset !== length) {
      if (offset !== 0) {
        value = value.slice(offset);
      }
      pointer =
        wasm.__wbindgen_export_1(pointer, length, (length = offset + value.length * 3), 1) >>> 0;
      const target = memoryBytes().subarray(pointer + offset, pointer + length);
      const encoded = encoder.encodeInto(value, target);
      offset += encoded.written;
      pointer = wasm.__wbindgen_export_1(pointer, length, offset, 1) >>> 0;
    }
    vectorLength = offset;
    return pointer;
  };
  const prefix = `${input.salt}_${input.expireAt}_`;
  const returnPointer = wasm.__wbindgen_add_to_stack_pointer(-16);
  const challengePointer = passString(input.challenge);
  const challengeLength = vectorLength;
  const prefixPointer = passString(prefix);
  const prefixLength = vectorLength;
  wasm.wasm_solve(
    returnPointer,
    challengePointer,
    challengeLength,
    prefixPointer,
    prefixLength,
    input.difficulty
  );
  const solved = memoryView().getInt32(returnPointer, true);
  const answer = memoryView().getFloat64(returnPointer + 8, true);
  wasm.__wbindgen_add_to_stack_pointer(16);
  if (solved !== 1 || !Number.isFinite(answer)) {
    throw new Error(`Proof-of-work solve failed for ${input.wasmUrl}.`);
  }
  return answer;
}
async function loadWasmPowModule(wasmUrl: string) {
  let cached = wasmPowModuleCache.get(wasmUrl);
  if (!cached) {
    cached = (async () => {
      const response = await fetch(wasmUrl);
      if (!response.ok) {
        throw new Error(`Failed to load proof-of-work module from ${wasmUrl}.`);
      }
      const bytes = await response.arrayBuffer();
      const { instance } = await WebAssembly.instantiate(bytes, {
        wbg: {}
      });
      return instance.exports as unknown as WasmPowModule;
    })();
    wasmPowModuleCache.set(wasmUrl, cached);
  }
  return await cached;
}
function wrapVisibleTextAsFinalPacket(content: string) {
  const trimmed = content.trim();
  if (!trimmed || looksLikeAssistantPacket(trimmed)) {
    return trimmed;
  }
  const sanitized = sanitizeBridgeApiOutput(trimmed);
  if (sanitized.sanitized) {
    return trimmed;
  }
  return `<final>${trimmed}</final>`;
}
async function* maybeWrapVisibleTextFinalStream(
  stream: AsyncIterable<ProviderStreamFragment>,
  allowVisibleTextFinal: boolean
) {
  if (!allowVisibleTextFinal) {
    yield* stream;
    return;
  }
  let started = false;
  let passthroughAssistantPacket = false;
  let bufferedContent = "";
  let responseId = "";
  let conversationId = "";
  for await (const fragment of stream) {
    responseId = fragment.responseId;
    conversationId = fragment.conversationId;
    if (!started && !passthroughAssistantPacket) {
      bufferedContent += fragment.content;
      const trimmed = bufferedContent.trimStart();
      if (!trimmed) {
        continue;
      }
      if (looksLikeAssistantPacket(trimmed)) {
        started = true;
        passthroughAssistantPacket = true;
        yield {
          ...fragment,
          content: bufferedContent
        } satisfies ProviderStreamFragment;
        bufferedContent = "";
        continue;
      }
      if (trimmed.startsWith("<") && trimmed.length < "<zc_packet".length) {
        continue;
      }
      started = true;
      yield {
        content: "<final>",
        responseId,
        conversationId,
        eventCountDelta: 0,
        fragmentCountDelta: 0
      } satisfies ProviderStreamFragment;
      yield {
        ...fragment,
        content: bufferedContent
      } satisfies ProviderStreamFragment;
      bufferedContent = "";
      continue;
    }
    yield fragment;
  }
  if (!started || passthroughAssistantPacket) {
    return;
  }
  yield {
    content: "</final>",
    responseId,
    conversationId,
    eventCountDelta: 0,
    fragmentCountDelta: 0
  } satisfies ProviderStreamFragment;
}
function looksLikeAssistantPacket(content: string) {
  return /^<(?:final|tool|zc_packet|packet)\b/i.test(content);
}
function extractPathValues(value: unknown, segments: string[]): unknown[] {
  if (segments.length === 0) {
    return [value];
  }
  if (value === null || value === undefined) {
    return [];
  }
  const [segment, ...rest] = segments;
  if (segment === "*") {
    if (Array.isArray(value)) {
      return value.flatMap((entry) => extractPathValues(entry, rest));
    }
    if (typeof value === "object") {
      return Object.values(value as Record<string, unknown>).flatMap((entry) =>
        extractPathValues(entry, rest)
      );
    }
    return [];
  }
  if (Array.isArray(value)) {
    const index = Number.parseInt(segment, 10);
    if (!Number.isInteger(index)) {
      return [];
    }
    return extractPathValues(value[index], rest);
  }
  if (typeof value === "object") {
    return extractPathValues((value as Record<string, unknown>)[segment], rest);
  }
  return [];
}
function requireSessionField(value: string | undefined, providerId: string, field: string) {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  throw new ProviderFailure({
    kind: "permanent",
    code: "authentication_failed",
    message: `Provider "${providerId}" session is missing required field "${field}".`,
    displayMessage: "Provider authentication/session state is incomplete.",
    retryable: false,
    sessionResetEligible: false
  });
}
function hasHeader(headers: Record<string, string>, name: string) {
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
}
async function* singleFragmentStream(
  content: string,
  responseId: string,
  conversationId: string
): AsyncIterable<ProviderStreamFragment> {
  if (!content) {
    return;
  }
  yield {
    content,
    responseId,
    conversationId,
    eventCountDelta: 1,
    fragmentCountDelta: 1
  };
}
function encodeConnectBody(value: unknown) {
  const payloadText = typeof value === "string" ? value : JSON.stringify(value);
  const payloadBytes = new TextEncoder().encode(payloadText);
  const buffer = new Uint8Array(5 + payloadBytes.length);
  buffer[0] = 0;
  buffer[1] = (payloadBytes.length >>> 24) & 0xff;
  buffer[2] = (payloadBytes.length >>> 16) & 0xff;
  buffer[3] = (payloadBytes.length >>> 8) & 0xff;
  buffer[4] = payloadBytes.length & 0xff;
  buffer.set(payloadBytes, 5);
  return buffer;
}

export const genericProviderTransportModule = {
  collectGenericProviderCompletion,
  openGenericProviderStream
};

export type {
  CollectedProviderTransportCompletion,
  ProviderStreamBinding,
  ProviderTransportStream
};
