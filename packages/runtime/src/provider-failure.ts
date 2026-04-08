type ProviderFailureKind = "transient" | "session_corruption" | "protocol" | "permanent";
type ProviderFailureCode =
  | "transport_timeout"
  | "transport_error"
  | "empty_response"
  | "empty_extracted_response"
  | "empty_final_message"
  | "packet_extraction_failed"
  | "packet_normalization_failed"
  | "packet_validation_failed"
  | "authentication_failed"
  | "request_invalid"
  | "unsupported_request"
  | "session_reset_failed";
type ProviderRecoveryState = {
  softRetryCount: number;
  sessionResetCount: number;
};
type SerializedProviderFailure = {
  kind: ProviderFailureKind;
  code: ProviderFailureCode;
  message: string;
  retryable: boolean;
  sessionResetEligible: boolean;
  emptyOutput: boolean;
  recovery: ProviderRecoveryState;
  details?: Record<string, unknown>;
};
class ProviderFailure extends Error {
  readonly kind: ProviderFailureKind;
  readonly code: ProviderFailureCode;
  readonly displayMessage: string;
  readonly retryable: boolean;
  readonly sessionResetEligible: boolean;
  readonly emptyOutput: boolean;
  readonly recovery: ProviderRecoveryState;
  readonly details: Record<string, unknown> | undefined;
  constructor(input: {
    kind: ProviderFailureKind;
    code: ProviderFailureCode;
    message: string;
    displayMessage?: string;
    retryable?: boolean;
    sessionResetEligible?: boolean;
    emptyOutput?: boolean;
    recovery?: Partial<ProviderRecoveryState>;
    details?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "ProviderFailure";
    this.kind = input.kind;
    this.code = input.code;
    this.displayMessage = input.displayMessage ?? input.message;
    this.retryable = input.retryable ?? input.kind === "transient";
    this.sessionResetEligible = input.sessionResetEligible ?? input.kind === "session_corruption";
    this.emptyOutput = input.emptyOutput ?? false;
    this.recovery = {
      softRetryCount: input.recovery?.softRetryCount ?? 0,
      sessionResetCount: input.recovery?.sessionResetCount ?? 0
    };
    this.details = input.details;
  }
}
function isProviderFailure(error: unknown): error is ProviderFailure {
  return error instanceof ProviderFailure;
}
function serializeProviderFailure(error: ProviderFailure): SerializedProviderFailure {
  return {
    kind: error.kind,
    code: error.code,
    message: error.displayMessage,
    retryable: error.retryable,
    sessionResetEligible: error.sessionResetEligible,
    emptyOutput: error.emptyOutput,
    recovery: error.recovery,
    details: error.details
  };
}
function withProviderRecovery(
  error: ProviderFailure,
  recovery: Partial<ProviderRecoveryState>,
  overrides: Partial<
    Pick<ProviderFailure, "kind" | "displayMessage" | "retryable" | "sessionResetEligible">
  > = {}
) {
  return new ProviderFailure({
    kind: overrides.kind ?? error.kind,
    code: error.code,
    message: error.message,
    displayMessage: overrides.displayMessage ?? error.displayMessage,
    retryable: overrides.retryable ?? error.retryable,
    sessionResetEligible: overrides.sessionResetEligible ?? error.sessionResetEligible,
    emptyOutput: error.emptyOutput,
    details: error.details,
    recovery: {
      softRetryCount: recovery.softRetryCount ?? error.recovery.softRetryCount,
      sessionResetCount: recovery.sessionResetCount ?? error.recovery.sessionResetCount
    },
    cause: error.cause
  });
}
function classifyProviderTransportError(error: unknown) {
  if (isProviderFailure(error)) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  const details = extractSafeProviderFailureDetails(error);
  if (normalized.includes("timed out")) {
    return new ProviderFailure({
      kind: "transient",
      code: "transport_timeout",
      message,
      displayMessage: "Provider request timed out.",
      retryable: true,
      sessionResetEligible: false,
      details,
      cause: error
    });
  }
  if (
    normalized.includes("no captured bridge session exists") ||
    normalized.includes("missing the auth token")
  ) {
    return new ProviderFailure({
      kind: "permanent",
      code: "authentication_failed",
      message,
      displayMessage: "Provider authentication/session state is missing or expired.",
      retryable: false,
      sessionResetEligible: false,
      details,
      cause: error
    });
  }
  if (
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden") ||
    normalized.includes("401") ||
    normalized.includes("403")
  ) {
    return new ProviderFailure({
      kind: "permanent",
      code: "authentication_failed",
      message,
      displayMessage:
        "Provider authentication/session state is invalid and could not be recovered.",
      retryable: false,
      sessionResetEligible: false,
      details,
      cause: error
    });
  }
  if (
    normalized.includes("unsupported provider") ||
    normalized.includes("invalid provider") ||
    normalized.includes("invalid model")
  ) {
    return new ProviderFailure({
      kind: "permanent",
      code: "request_invalid",
      message,
      displayMessage: "Provider configuration is invalid for this request.",
      retryable: false,
      sessionResetEligible: false,
      details,
      cause: error
    });
  }
  if (normalized.includes("unsupported")) {
    return new ProviderFailure({
      kind: "permanent",
      code: "unsupported_request",
      message,
      displayMessage: "Provider does not support this request.",
      retryable: false,
      sessionResetEligible: false,
      details,
      cause: error
    });
  }
  if (
    normalized.includes("stale") ||
    normalized.includes("corrupt") ||
    normalized.includes("conversation binding") ||
    normalized.includes("parent_id") ||
    normalized.includes("parent message")
  ) {
    return new ProviderFailure({
      kind: "session_corruption",
      code: "transport_error",
      message,
      displayMessage: "Provider session state became unusable.",
      retryable: false,
      sessionResetEligible: true,
      details,
      cause: error
    });
  }
  return new ProviderFailure({
    kind: "transient",
    code: "transport_error",
    message,
    displayMessage: "Provider request failed.",
    retryable: true,
    sessionResetEligible: false,
    details,
    cause: error
  });
}
function formatProviderFailureMessage(error: ProviderFailure) {
  const recovery = formatRecoverySummary(error.recovery);
  switch (error.code) {
    case "transport_timeout":
      return `Provider request timed out${recovery}.`;
    case "empty_response":
      return `Provider returned an empty response${recovery}.`;
    case "empty_extracted_response":
      return `Provider returned no extractable assistant content${recovery}.`;
    case "empty_final_message":
      return `Provider returned an empty final answer${recovery}.`;
    case "packet_extraction_failed":
    case "packet_normalization_failed":
    case "packet_validation_failed":
      return `Provider returned malformed or unusable output${recovery}.`;
    case "authentication_failed":
      return error.displayMessage;
    case "request_invalid":
      if (
        typeof error.details?.stage === "string" &&
        typeof error.details?.httpStatus === "number"
      ) {
        return `Provider request failed during ${error.details.stage} with HTTP ${error.details.httpStatus}${recovery}.`;
      }
      return "Provider configuration is invalid for this request.";
    case "unsupported_request":
      return "Provider does not support this request.";
    case "session_reset_failed":
      return `Provider session reset failed${recovery}.`;
    case "transport_error":
      if (
        typeof error.details?.stage === "string" &&
        typeof error.details?.httpStatus === "number"
      ) {
        return `Provider request failed during ${error.details.stage} with HTTP ${error.details.httpStatus}${recovery}.`;
      }
    default:
      return `Provider request failed${recovery}.`;
  }
}
function extractSafeProviderFailureDetails(error: unknown) {
  if (!(error instanceof Error) || !("details" in error) || !isRecord(error.details)) {
    return undefined;
  }
  const result: Record<string, unknown> = {};
  if (typeof error.details.provider === "string" && error.details.provider.trim()) {
    result.provider = error.details.provider.trim();
  }
  if (typeof error.details.stage === "string" && error.details.stage.trim()) {
    result.stage = error.details.stage.trim();
  }
  if (typeof error.details.httpStatus === "number" && Number.isInteger(error.details.httpStatus)) {
    result.httpStatus = error.details.httpStatus;
  }
  if (typeof error.details.networkCode === "string" && error.details.networkCode.trim()) {
    result.networkCode = error.details.networkCode.trim();
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function formatRecoverySummary(recovery: ProviderRecoveryState) {
  const parts: string[] = [];
  if (recovery.softRetryCount > 0) {
    parts.push(
      `${recovery.softRetryCount} soft retr${recovery.softRetryCount === 1 ? "y" : "ies"}`
    );
  }
  if (recovery.sessionResetCount > 0) {
    parts.push(
      `${recovery.sessionResetCount} provider-session reset${recovery.sessionResetCount === 1 ? "" : "s"}`
    );
  }
  if (parts.length === 0) {
    return "";
  }
  return ` after ${parts.join(" and ")}`;
}

export const providerFailureModule = {
  ProviderFailure,
  isProviderFailure,
  serializeProviderFailure,
  withProviderRecovery,
  classifyProviderTransportError,
  formatProviderFailureMessage
};

export type {
  ProviderFailure,
  ProviderFailureCode,
  ProviderFailureKind,
  ProviderRecoveryState,
  SerializedProviderFailure
};
