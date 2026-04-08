class BridgeApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  constructor(input: {
    statusCode: number;
    code: string;
    message: string;
    details?: Record<string, unknown>;
  }) {
    super(input.message);
    this.name = "BridgeApiError";
    this.statusCode = input.statusCode;
    this.code = input.code;
    this.details = input.details;
  }
}
function isBridgeApiError(error: unknown): error is BridgeApiError {
  return error instanceof BridgeApiError;
}

export const bridgeApiErrorModule = {
  BridgeApiError,
  isBridgeApiError
};

export type { BridgeApiError };
