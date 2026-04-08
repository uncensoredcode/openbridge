import type { RuntimeTool } from "../execution/types.ts";
import { bashModule } from "./bash.ts";
import { editModule } from "./edit.ts";
import { listDirModule } from "./list-dir.ts";
import { readModule } from "./read.ts";
import { searchFilesModule } from "./search-files.ts";
import { writeModule } from "./write.ts";

const { createBashTool } = bashModule;
const { createEditTool } = editModule;
const { createListDirTool } = listDirModule;
const { createReadTool } = readModule;
const { createSearchFilesTool } = searchFilesModule;
const { createWriteTool } = writeModule;
type RuntimeToolProfile = "default" | "workspace";
function createDefaultRuntimeTools(runtimeRoot: string): RuntimeTool[] {
  return [
    createReadTool({ runtimeRoot }),
    createWriteTool({ runtimeRoot }),
    createEditTool({ runtimeRoot }),
    createBashTool({ runtimeRoot })
  ];
}
function createSecondaryRuntimeTools(workspaceRoot: string): RuntimeTool[] {
  return [createListDirTool({ workspaceRoot }), createSearchFilesTool({ workspaceRoot })];
}
function createRuntimeTools(input: {
  profile?: RuntimeToolProfile;
  runtimeRoot: string;
  workspaceRoot?: string;
}) {
  const defaultTools = createDefaultRuntimeTools(input.runtimeRoot);
  if ((input.profile ?? "default") !== "workspace") {
    return defaultTools;
  }
  return [
    ...defaultTools,
    ...createSecondaryRuntimeTools(input.workspaceRoot ?? input.runtimeRoot)
  ];
}

export const registryModule = {
  createDefaultRuntimeTools,
  createSecondaryRuntimeTools,
  createRuntimeTools
};

export type { RuntimeToolProfile };
