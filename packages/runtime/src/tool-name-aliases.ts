const PROVIDER_TOOL_NAME_ALIASES: Record<string, string> = {
  run_command: "bash",
  execute_shell_command: "bash",
  code_interpreter: "bash"
};
function normalizeProviderToolName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) {
    return trimmed;
  }
  return PROVIDER_TOOL_NAME_ALIASES[trimmed] ?? trimmed;
}

export const toolNameAliasesModule = {
  normalizeProviderToolName
};
