import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { LocalToolModule, ToolFailure, ToolResult } from "./types";

const MAX_DIRECTORY_ENTRIES = 200;
const MAX_TEXT_FILE_BYTES = 64 * 1024;

type DirectoryEntry = {
  readonly kind: "directory" | "file";
  readonly name: string;
  readonly sizeBytes?: number;
};

type ListDirectoryResultData = {
  readonly entries: readonly DirectoryEntry[];
  readonly resolvedPath: string;
};

type ReadTextFileResultData = {
  readonly content: string;
  readonly resolvedPath: string;
  readonly truncated: boolean;
};

const listDirectoryTool: LocalToolModule<
  {
    path?: string;
  },
  ListDirectoryResultData
> = {
  apiVersion: 1,
  kind: "local-tool",
  manifest: {
    name: "list_directory",
    displayName: "List Directory",
    description: "List files and folders inside a workspace-relative directory.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description:
            "Optional workspace-relative directory path. Defaults to the workspace root.",
        },
      },
      required: [],
    },
    policy: {
      category: "filesystem",
      enabledByDefault: true,
      timeoutMs: 10_000,
    },
  },
  async run(args, context): Promise<ToolResult<ListDirectoryResultData>> {
    const targetPath = resolveWorkspacePath(context.workspaceDir, args.path);

    if (targetPath instanceof Error) {
      return createToolError("invalid_path", targetPath.message);
    }

    let stats;

    try {
      stats = await stat(targetPath);
    } catch (error) {
      return createToolError("not_found", describeError(error, `Path not found: ${targetPath}`));
    }

    if (!stats.isDirectory()) {
      return createToolError("not_directory", `Path is not a directory: ${targetPath}`);
    }

    const directoryEntries = await readdir(targetPath, { withFileTypes: true });
    const visibleEntries = directoryEntries.slice(0, MAX_DIRECTORY_ENTRIES);
    const entries = await Promise.all(
      visibleEntries.map(async (entry) => {
        const entryPath = path.join(targetPath, entry.name);

        if (entry.isDirectory()) {
          return {
            kind: "directory" as const,
            name: entry.name,
          };
        }

        try {
          const entryStats = await stat(entryPath);

          return {
            kind: "file" as const,
            name: entry.name,
            sizeBytes: entryStats.size,
          };
        } catch {
          return {
            kind: "file" as const,
            name: entry.name,
          };
        }
      }),
    );

    return {
      ok: true,
      content: `Listed ${String(entries.length)} entr${entries.length === 1 ? "y" : "ies"} in ${targetPath}.`,
      data: {
        entries,
        resolvedPath: targetPath,
      },
    };
  },
};

const readTextFileTool: LocalToolModule<
  {
    path: string;
  },
  ReadTextFileResultData
> = {
  apiVersion: 1,
  kind: "local-tool",
  manifest: {
    name: "read_text_file",
    displayName: "Read Text File",
    description: "Read a UTF-8 text file from the workspace and return its contents.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description: "Workspace-relative path to the text file.",
        },
      },
      required: ["path"],
    },
    policy: {
      category: "filesystem",
      enabledByDefault: true,
      timeoutMs: 10_000,
    },
  },
  async run(args, context): Promise<ToolResult<ReadTextFileResultData>> {
    const targetPath = resolveWorkspacePath(context.workspaceDir, args.path);

    if (targetPath instanceof Error) {
      return createToolError("invalid_path", targetPath.message);
    }

    let fileStats;

    try {
      fileStats = await stat(targetPath);
    } catch (error) {
      return createToolError("not_found", describeError(error, `Path not found: ${targetPath}`));
    }

    if (!fileStats.isFile()) {
      return createToolError("not_file", `Path is not a file: ${targetPath}`);
    }

    const file = Bun.file(targetPath);
    const chunk = await file.slice(0, MAX_TEXT_FILE_BYTES).text();
    const truncated = fileStats.size > MAX_TEXT_FILE_BYTES;
    const content = truncated
      ? `${chunk}\n\n[truncated after ${String(MAX_TEXT_FILE_BYTES)} bytes]`
      : chunk;

    return {
      ok: true,
      content: `Read ${path.basename(targetPath)} from ${targetPath}.`,
      data: {
        content,
        resolvedPath: targetPath,
        truncated,
      },
    };
  },
};

export const BUILT_IN_TOOLS: readonly LocalToolModule[] = [listDirectoryTool, readTextFileTool];

function resolveWorkspacePath(
  workspaceDir: string | undefined,
  requestedPath: string | undefined,
): Error | string {
  if (!workspaceDir) {
    return new Error("Workspace path is unavailable for this tool execution.");
  }

  const normalizedInput = requestedPath?.trim() ?? ".";
  const candidatePath = path.resolve(workspaceDir, normalizedInput);
  const relativePath = path.relative(workspaceDir, candidatePath);
  const escapedWorkspace = relativePath.startsWith("..") || path.isAbsolute(relativePath);

  if (escapedWorkspace) {
    return new Error(`Path escapes the workspace root: ${normalizedInput}`);
  }

  return candidatePath;
}

function createToolError(code: string, message: string): ToolFailure {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  };
}

function describeError(error: unknown, fallbackMessage: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallbackMessage;
}
