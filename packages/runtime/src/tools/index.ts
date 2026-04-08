import { bashModule } from "./bash.ts";
import { editModule } from "./edit.ts";
import { listDirModule } from "./list-dir.ts";
import { readModule } from "./read.ts";
import { registryModule } from "./registry.ts";
import { runtimePathModule } from "./runtime-path.ts";
import { searchFilesModule } from "./search-files.ts";
import { textFileModule } from "./text-file.ts";
import { workspacePathModule } from "./workspace-path.ts";
import { writeModule } from "./write.ts";

export const toolsModule = {
  createBashTool: bashModule.createBashTool,
  createEditTool: editModule.createEditTool,
  createListDirTool: listDirModule.createListDirTool,
  createReadTool: readModule.createReadTool,
  createDefaultRuntimeTools: registryModule.createDefaultRuntimeTools,
  createRuntimeTools: registryModule.createRuntimeTools,
  createSecondaryRuntimeTools: registryModule.createSecondaryRuntimeTools,
  createSearchFilesTool: searchFilesModule.createSearchFilesTool,
  MAX_FILE_READ_BYTES: textFileModule.MAX_FILE_READ_BYTES,
  MAX_FILE_WRITE_BYTES: textFileModule.MAX_FILE_WRITE_BYTES,
  ensureRuntimeRoot: runtimePathModule.ensureRuntimeRoot,
  resolveRuntimePath: runtimePathModule.resolveRuntimePath,
  ensureWorkspaceRoot: workspacePathModule.ensureWorkspaceRoot,
  resolveWorkspacePath: workspacePathModule.resolveWorkspacePath,
  createWriteTool: writeModule.createWriteTool
};

export type { RuntimeToolProfile } from "./registry.ts";

export type { ResolvedWorkspacePath } from "./workspace-path.ts";
