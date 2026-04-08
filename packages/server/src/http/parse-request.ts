import { type z, ZodError, type ZodTypeAny } from "zod";

import { bridgeApiErrorModule } from "../shared/bridge-api-error.ts";

const { BridgeApiError } = bridgeApiErrorModule;
function parseRequest<TSchema extends ZodTypeAny>(
  schema: TSchema,
  value: unknown
): z.output<TSchema> {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new BridgeApiError({
        statusCode: 400,
        code: "invalid_request",
        message: "Request validation failed.",
        details: {
          issues: error.issues.map((issue) => ({
            path: issue.path.length > 0 ? issue.path.join(".") : "$",
            message: issue.message
          }))
        }
      });
    }
    throw error;
  }
}

export const parseRequestModule = {
  parseRequest
};
