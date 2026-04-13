type ToolSchema = {
  type: "object";
  properties: Record<
    string,
    {
      type: "string" | "boolean";
      description: string;
    }
  >;
  required: string[];
};
type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: ToolSchema;
};

export const executionTypesModule = {};

export type { ToolDefinition, ToolSchema };
