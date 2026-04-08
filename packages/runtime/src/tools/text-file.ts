import type { Stats } from "node:fs";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";

import { executionTypesModule } from "../execution/types.ts";

const { ToolExecutionError } = executionTypesModule;
const MAX_FILE_READ_BYTES = 64 * 1024;
const MAX_FILE_WRITE_BYTES = 64 * 1024;
const MAX_LIST_DIR_ENTRIES = 200;
const MAX_SEARCH_FILE_BYTES = 256 * 1024;
const MAX_SEARCH_RESULTS = 50;
const MAX_SEARCH_SNIPPET_CHARS = 240;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
type ReadTextFileWithinLimitInput = {
  absolutePath: string;
  relativePath: string;
  maxBytes: number;
  operation: "read" | "search" | "write";
};
async function readTextFileWithinLimit(input: ReadTextFileWithinLimitInput) {
  const details = await statExistingPath(input.absolutePath, input.relativePath);
  if (!details.isFile()) {
    throw new ToolExecutionError("invalid_type", `Path "${input.relativePath}" is not a file.`);
  }
  if (details.size > input.maxBytes) {
    throw new ToolExecutionError(
      "file_too_large",
      `File "${input.relativePath}" is ${details.size} bytes, which exceeds the ${input.maxBytes}-byte limit for ${input.operation}.`
    );
  }
  const buffer = await readFile(input.absolutePath);
  const content = decodeTextBuffer(buffer, input.relativePath);
  return {
    content,
    bytes: buffer.byteLength
  };
}
async function assertWritableTextTarget(input: {
  absolutePath: string;
  relativePath: string;
  maxBytes: number;
}) {
  try {
    await readTextFileWithinLimit({
      absolutePath: input.absolutePath,
      relativePath: input.relativePath,
      maxBytes: input.maxBytes,
      operation: "write"
    });
  } catch (error) {
    if (error instanceof ToolExecutionError && error.code === "not_found") {
      return;
    }
    throw error;
  }
}
function assertTextContent(content: string, relativePath: string, maxBytes: number) {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > maxBytes) {
    throw new ToolExecutionError(
      "file_too_large",
      `Content for "${relativePath}" is ${bytes} bytes, which exceeds the ${maxBytes}-byte write limit.`
    );
  }
  return bytes;
}
async function writeTextFileAtomic(absolutePath: string, content: string) {
  const tempPath = `${absolutePath}.bridge-runtime-tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tempPath, content, { encoding: "utf8", flag: "wx" });
    await rename(tempPath, absolutePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}
function truncateSnippet(line: string, maxChars = MAX_SEARCH_SNIPPET_CHARS) {
  const trimmed = line.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 3))}...`;
}
function decodeTextBuffer(buffer: Buffer, relativePath: string) {
  if (buffer.includes(0)) {
    throw new ToolExecutionError("binary_file", `File "${relativePath}" appears to be binary.`);
  }
  try {
    return UTF8_DECODER.decode(buffer);
  } catch {
    throw new ToolExecutionError("binary_file", `File "${relativePath}" is not valid UTF-8 text.`);
  }
}
async function statExistingPath(absolutePath: string, relativePath: string): Promise<Stats> {
  try {
    return await stat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ToolExecutionError("not_found", `File does not exist: ${relativePath}`);
    }
    throw new ToolExecutionError(
      "io_error",
      `Unable to inspect "${relativePath}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export const textFileModule = {
  MAX_FILE_READ_BYTES,
  MAX_FILE_WRITE_BYTES,
  MAX_LIST_DIR_ENTRIES,
  MAX_SEARCH_FILE_BYTES,
  MAX_SEARCH_RESULTS,
  MAX_SEARCH_SNIPPET_CHARS,
  readTextFileWithinLimit,
  assertWritableTextTarget,
  assertTextContent,
  writeTextFileAtomic,
  truncateSnippet
};
