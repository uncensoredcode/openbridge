import type {
  ProviderTransport,
  ProviderTransportRequest,
  ProviderTransportResponse
} from "@uncensoredcode/openbridge/runtime";
import { bridgeRuntime } from "@uncensoredcode/openbridge/runtime";

import type { FileBridgeStateStore } from "../state/file-bridge-state-store.ts";
import type { ProviderRecord } from "../stores/provider-store.ts";
import type { CollectedProviderTransportCompletion } from "./generic-provider-transport.ts";
import { genericProviderTransportModule } from "./generic-provider-transport.ts";
import type { BridgeProviderSessionResolver } from "./provider-session-resolver.ts";
import type { CollectedProviderCompletion, ProviderStreamFragment } from "./provider-streams.ts";
import { providerTransportProfileModule } from "./provider-transport-profile.ts";

const { ProviderFailure } = bridgeRuntime;
const { collectGenericProviderCompletion, openGenericProviderStream } =
  genericProviderTransportModule;
const { resolveProviderTransportProfile } = providerTransportProfileModule;
type StreamingProviderTransport = {
  streamChat(request: ProviderTransportRequest): Promise<{
    content: AsyncIterable<ProviderStreamFragment>;
    upstreamBinding: Promise<Pick<
      NonNullable<ProviderTransportRequest["upstreamBinding"]>,
      "conversationId" | "parentId"
    > | null>;
  }>;
};
class WebProviderTransport implements ProviderTransport {
  readonly #providerSessionResolver: BridgeProviderSessionResolver;
  readonly #loadProvider: (providerId: string) => ProviderRecord | null;
  constructor(input: {
    providerSessionResolver: BridgeProviderSessionResolver;
    loadProvider?: (providerId: string) => ProviderRecord | null;
  }) {
    this.#providerSessionResolver = input.providerSessionResolver;
    this.#loadProvider = input.loadProvider ?? (() => null);
  }
  async completeChat(request: ProviderTransportRequest): Promise<ProviderTransportResponse> {
    const result = await collectProviderTransportCompletionWithResolver(
      this.#providerSessionResolver,
      request,
      this.#loadProvider
    );
    logCollectedCompletionSummary(request.requestId, result);
    if (!result.completion.content) {
      throw createEmptyCompletionFailure(
        result.providerId,
        result.completion,
        Boolean(request.upstreamBinding)
      );
    }
    return {
      content: result.completion.content,
      upstreamBinding: result.upstreamBinding ?? request.upstreamBinding
    };
  }
  async streamChat(request: ProviderTransportRequest): Promise<{
    content: AsyncIterable<ProviderStreamFragment>;
    upstreamBinding: Promise<Pick<
      NonNullable<ProviderTransportRequest["upstreamBinding"]>,
      "conversationId" | "parentId"
    > | null>;
  }> {
    return await openProviderTransportStreamWithResolver(
      this.#providerSessionResolver,
      request,
      this.#loadProvider
    );
  }
}
function logCollectedCompletionSummary(
  requestId: string,
  result: {
    providerId: string;
    modelId: string;
    completion: CollectedProviderCompletion;
  }
) {
  console.log(
    `[BridgeTransport][${requestId}] provider_completion_collected ${JSON.stringify({
      providerId: result.providerId,
      modelId: result.modelId,
      responseId: result.completion.responseId || null,
      eventCount: result.completion.eventCount,
      fragmentCount: result.completion.fragmentCount,
      contentLength: result.completion.content.length,
      contentPreview: summarizeProviderContent(result.completion.content)
    })}`
  );
}
async function collectProviderTransportCompletion(
  stateStore: FileBridgeStateStore,
  request: ProviderTransportRequest
): Promise<CollectedProviderTransportCompletion> {
  return collectProviderTransportCompletionWithResolver(
    {
      rootDir: stateStore.rootDir,
      loadProviderSession: ({ providerId }) => stateStore.loadProviderSession(providerId)
    },
    request,
    () => null
  );
}
async function collectProviderTransportCompletionWithResolver(
  providerSessionResolver: BridgeProviderSessionResolver,
  request: ProviderTransportRequest,
  loadProvider: (providerId: string) => ProviderRecord | null
): Promise<CollectedProviderTransportCompletion> {
  const provider = loadProvider(request.providerId);
  const profile = resolveProviderTransportProfile(provider);
  if (!profile) {
    throw unsupportedProviderFailure(provider);
  }
  const session = await providerSessionResolver.loadProviderSession({
    providerId: request.providerId
  });
  if (!session) {
    throw missingSessionFailure(request.providerId, providerSessionResolver.rootDir);
  }
  logProviderSessionSummary(request.requestId, request.providerId, profile.family, session);
  return collectGenericProviderCompletion({
    stateRoot: providerSessionResolver.rootDir,
    session,
    request,
    profile
  });
}
async function openProviderTransportStreamWithResolver(
  providerSessionResolver: BridgeProviderSessionResolver,
  request: ProviderTransportRequest,
  loadProvider: (providerId: string) => ProviderRecord | null
) {
  const provider = loadProvider(request.providerId);
  const profile = resolveProviderTransportProfile(provider);
  if (!profile) {
    throw unsupportedProviderFailure(provider);
  }
  const session = await providerSessionResolver.loadProviderSession({
    providerId: request.providerId
  });
  if (!session) {
    throw missingSessionFailure(request.providerId, providerSessionResolver.rootDir);
  }
  logProviderSessionSummary(request.requestId, request.providerId, profile.family, session);
  return openGenericProviderStream({
    stateRoot: providerSessionResolver.rootDir,
    session,
    request,
    profile
  });
}
function logProviderSessionSummary(
  requestId: string,
  providerId: string,
  providerKind: string,
  session: {
    cookie?: string;
    bearerToken?: string;
    extraHeaders?: Record<string, string>;
    userAgent?: string;
    updatedAt?: string;
  }
) {
  const cookieCount =
    typeof session.cookie === "string" && session.cookie
      ? session.cookie.split(/;\s*/).filter(Boolean).length
      : 0;
  const extraHeaderNames = session.extraHeaders ? Object.keys(session.extraHeaders).sort() : [];
  console.log(
    `[BridgeTransport][${requestId}] provider_session_resolved ${JSON.stringify({
      providerId,
      providerKind,
      hasCookie: Boolean(session.cookie),
      cookieCount,
      hasBearerToken: Boolean(session.bearerToken),
      hasUserAgent: Boolean(session.userAgent),
      extraHeaderNames,
      updatedAt: session.updatedAt ?? null
    })}`
  );
}
function unsupportedProviderFailure(provider: ProviderRecord | null) {
  const providerId = provider?.id ?? "";
  const providerKind = provider?.kind ?? "";
  return new ProviderFailure({
    kind: "permanent",
    code: "request_invalid",
    message: `Provider "${providerId}" does not define a supported transport family${providerKind ? ` ("${providerKind}")` : ""}.`,
    displayMessage: "Provider transport configuration is invalid for this request.",
    retryable: false,
    sessionResetEligible: false,
    details: {
      providerId: providerId || null,
      providerKind: providerKind || null,
      hasTransportConfig: Boolean(provider?.config.transport)
    }
  });
}
function missingSessionFailure(providerId: string, rootDir: string) {
  return new ProviderFailure({
    kind: "permanent",
    code: "authentication_failed",
    message: `No uploaded or legacy provider session exists for provider "${providerId}" under ${rootDir}.`,
    displayMessage: "Provider authentication/session state is missing or expired.",
    retryable: false,
    sessionResetEligible: false
  });
}
function createEmptyCompletionFailure(
  providerId: string,
  completion: {
    eventCount: number;
    fragmentCount: number;
  },
  hasBinding: boolean
) {
  const noExtractableContent = completion.eventCount > 0 && completion.fragmentCount === 0;
  return new ProviderFailure({
    kind: "transient",
    code: noExtractableContent ? "empty_extracted_response" : "empty_response",
    message: `${providerId} returned ${noExtractableContent ? "no extractable assistant content" : "an empty response"}.`,
    retryable: true,
    sessionResetEligible: hasBinding,
    emptyOutput: true,
    details: {
      streamEventCount: completion.eventCount,
      fragmentCount: completion.fragmentCount
    }
  });
}
function summarizeProviderContent(value: string, maxLength = 320) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength)}...`;
}

export const webProviderTransportModule = {
  WebProviderTransport,
  collectProviderTransportCompletion
};

export type { StreamingProviderTransport, WebProviderTransport };
