import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ConfigStore } from "../../backend/config";
import { DebugLogService } from "../../backend/debug";
import type { ApplicationPaths } from "../../backend/paths";
import { LocalToolRegistry } from "../../backend/tools/registry";
import { createBackendTestScratchDir, removeBackendTestScratchDir } from "./testScratch";

type ListDirectoryResultData = {
  readonly entries: readonly {
    readonly name: string;
  }[];
  readonly resolvedPath: string;
};

function isListDirectoryResultData(value: unknown): value is ListDirectoryResultData {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return typeof candidate["resolvedPath"] === "string" && Array.isArray(candidate["entries"]);
}

describe.serial("LocalToolRegistry", () => {
  let applicationPaths: ApplicationPaths;
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createBackendTestScratchDir("local-llm-gui-tools");
    applicationPaths = {
      configFilePath: path.join(rootDir, "config.json"),
      databasePath: path.join(rootDir, "local-llm-gui.sqlite"),
      mediaDir: path.join(rootDir, "media"),
      staticOutDir: path.join(rootDir, "out"),
      tempDir: path.join(rootDir, "temp"),
      toolsDir: path.join(rootDir, "tools"),
      userDataDir: rootDir,
      workspaceRoot: rootDir,
    };

    await Promise.all([
      mkdir(applicationPaths.mediaDir, { recursive: true }),
      mkdir(applicationPaths.tempDir, { recursive: true }),
      mkdir(applicationPaths.toolsDir, { recursive: true }),
    ]);
  });

  afterEach(async () => {
    await removeBackendTestScratchDir(rootDir);
  });

  test("loads a valid local tool and executes it", async () => {
    await createTool(
      applicationPaths.toolsDir,
      "say_hello",
      `export default {
  apiVersion: 1,
  kind: "local-tool",
  manifest: {
    name: "say_hello",
    description: "Return a greeting.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 1 }
      },
      required: ["name"]
    },
    policy: {
      category: "custom",
      enabledByDefault: true
    }
  },
  run(args) {
    return {
      ok: true,
      content: \`Hello, \${args.name}!\`,
      data: { greeted: args.name }
    };
  }
};
`,
    );

    const configStore = new ConfigStore(applicationPaths);
    const registry = new LocalToolRegistry(applicationPaths, configStore, new DebugLogService());
    const tools = await registry.refreshTools();
    const loadedTool = tools.find((tool) => tool.name === "say_hello");

    expect(loadedTool).toBeDefined();
    expect(loadedTool?.loadStatus).toBe("loaded");
    expect(loadedTool?.enabled).toBe(true);
    expect(loadedTool?.policy.timeoutMs).toBe(30_000);

    const result = await registry.executeTool("say_hello", {
      args: { name: "Ben" },
      chatId: "chat-1",
    });

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.content).toBe("Hello, Ben!");
      expect(result.data).toEqual({ greeted: "Ben" });
    }
  });

  test("discovers built-in tools before local tools and executes them", async () => {
    const configStore = new ConfigStore(applicationPaths);
    const registry = new LocalToolRegistry(applicationPaths, configStore, new DebugLogService());
    const sampleFilePath = path.join(applicationPaths.workspaceRoot, "sample-tool-file.txt");

    await writeFile(sampleFilePath, "Built-in tool content", "utf8");

    const tools = await registry.refreshTools();
    const builtInReadTool = tools.find((tool) => tool.name === "read_text_file");
    const builtInListTool = tools.find((tool) => tool.name === "list_directory");

    expect(builtInReadTool?.source).toBe("built-in");
    expect(builtInReadTool?.loadStatus).toBe("loaded");
    expect(builtInReadTool?.enabled).toBe(true);
    expect(builtInListTool?.source).toBe("built-in");
    expect(builtInListTool?.loadStatus).toBe("loaded");

    const readResult = await registry.executeTool("read_text_file", {
      args: { path: "sample-tool-file.txt" },
      chatId: "chat-built-in-read",
    });
    const listResult = await registry.executeTool("list_directory", {
      args: { path: "." },
      chatId: "chat-built-in-list",
    });

    expect(readResult.ok).toBe(true);
    expect(listResult.ok).toBe(true);

    if (readResult.ok) {
      expect(readResult.data).toEqual({
        content: "Built-in tool content",
        resolvedPath: sampleFilePath,
        truncated: false,
      });
    }

    if (listResult.ok) {
      expect(isListDirectoryResultData(listResult.data)).toBe(true);

      if (!isListDirectoryResultData(listResult.data)) {
        throw new Error("Expected list_directory to return structured directory data.");
      }

      expect(Array.isArray(listResult.data.entries)).toBe(true);
      expect(listResult.data.resolvedPath).toBe(applicationPaths.workspaceRoot);
      expect(listResult.data.entries.some((entry) => entry.name === "sample-tool-file.txt")).toBe(
        true,
      );
    }
  });

  test("rejects invalid tool folders and reports precise errors", async () => {
    await mkdir(path.join(applicationPaths.toolsDir, "missing_entry"), { recursive: true });
    await createTool(
      applicationPaths.toolsDir,
      "bad_name",
      `export default {
  apiVersion: 1,
  kind: "local-tool",
  manifest: {
    name: "different_name",
    description: "Mismatched name.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: []
    }
  },
  run() {
    return { ok: true, content: "never" };
  }
};
`,
    );
    await createTool(
      applicationPaths.toolsDir,
      "schema_ref",
      `export default {
  apiVersion: 1,
  kind: "local-tool",
  manifest: {
    name: "schema_ref",
    description: "Unsupported schema.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        payload: {
          $ref: "#/definitions/payload"
        }
      },
      required: ["payload"]
    }
  },
  run() {
    return { ok: true, content: "never" };
  }
};
`,
    );

    const configStore = new ConfigStore(applicationPaths);
    const registry = new LocalToolRegistry(applicationPaths, configStore, new DebugLogService());
    const tools = await registry.refreshTools();

    expect(tools.find((tool) => tool.name === "missing_entry")?.loadStatus).toBe("rejected");
    expect(tools.find((tool) => tool.name === "missing_entry")?.error).toContain(
      "Missing tool entry file",
    );
    expect(tools.find((tool) => tool.name === "different_name")?.error).toContain(
      "Tool folder name must match manifest.name exactly.",
    );
    expect(tools.find((tool) => tool.name === "schema_ref")?.error).toContain(
      "unsupported schema keyword $ref",
    );
  });

  test("rejects local tools that collide with built-in names", async () => {
    await createTool(
      applicationPaths.toolsDir,
      "list_directory",
      `export default {
  apiVersion: 1,
  kind: "local-tool",
  manifest: {
    name: "list_directory",
    description: "Should be rejected.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: []
    }
  },
  run() {
    return { ok: true, content: "never" };
  }
};
`,
    );

    const configStore = new ConfigStore(applicationPaths);
    const registry = new LocalToolRegistry(applicationPaths, configStore, new DebugLogService());
    const tools = await registry.refreshTools();
    const builtInTool = tools.find(
      (tool) => tool.name === "list_directory" && tool.source === "built-in",
    );
    const rejectedLocalTool = tools.find(
      (tool) => tool.name === "list_directory" && tool.source === "local",
    );

    expect(builtInTool?.loadStatus).toBe("loaded");
    expect(rejectedLocalTool?.loadStatus).toBe("rejected");
    expect(rejectedLocalTool?.error).toContain("Duplicate tool name: list_directory.");
  });

  test("respects persisted enabled-state and rejects execution while disabled", async () => {
    await createTool(
      applicationPaths.toolsDir,
      "toggle_me",
      `export default {
  apiVersion: 1,
  kind: "local-tool",
  manifest: {
    name: "toggle_me",
    description: "Toggle me.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: []
    }
  },
  run() {
    return { ok: true, content: "ran" };
  }
};
`,
    );

    const configStore = new ConfigStore(applicationPaths);
    await configStore.updateConfig({
      toolEnabledStates: {
        toggle_me: false,
      },
    });

    const registry = new LocalToolRegistry(applicationPaths, configStore, new DebugLogService());
    const tools = await registry.refreshTools();
    const toggledTool = tools.find((tool) => tool.name === "toggle_me");

    expect(toggledTool?.enabled).toBe(false);

    const result = await registry.executeTool("toggle_me", {
      args: {},
      chatId: "chat-2",
    });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe("tool_disabled");
    }
  });

  test("refreshTools reloads updated tool source without leaking cache-busted entrypoints", async () => {
    await createTool(
      applicationPaths.toolsDir,
      "refresh_me",
      `export default {
  apiVersion: 1,
  kind: "local-tool",
  manifest: {
    name: "refresh_me",
    description: "Refresh me.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: []
    }
  },
  run() {
    return { ok: true, content: "first" };
  }
};
`,
    );

    const configStore = new ConfigStore(applicationPaths);
    const registry = new LocalToolRegistry(applicationPaths, configStore, new DebugLogService());

    await registry.refreshTools();

    const firstResult = await registry.executeTool("refresh_me", {
      args: {},
      chatId: "chat-refresh-1",
    });

    expect(firstResult.ok).toBe(true);

    if (firstResult.ok) {
      expect(firstResult.content).toBe("first");
    }

    const toolPath = path.join(applicationPaths.toolsDir, "refresh_me", "tool.ts");
    const updatedSource = (await readFile(toolPath, "utf8")).replace("first", "second");

    await writeFile(toolPath, updatedSource, "utf8");
    await registry.refreshTools();

    const secondResult = await registry.executeTool("refresh_me", {
      args: {},
      chatId: "chat-refresh-2",
    });

    expect(secondResult.ok).toBe(true);

    if (secondResult.ok) {
      expect(secondResult.content).toBe("second");
    }
  });

  test("times out a CPU-bound local tool without freezing the registry", async () => {
    await createTool(
      applicationPaths.toolsDir,
      "spin_forever",
      `export default {
  apiVersion: 1,
  kind: "local-tool",
  manifest: {
    name: "spin_forever",
    description: "Spin forever.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: []
    },
    policy: {
      timeoutMs: 75
    }
  },
  run() {
    while (true) {}
  }
};
`,
    );

    const configStore = new ConfigStore(applicationPaths);
    const registry = new LocalToolRegistry(applicationPaths, configStore, new DebugLogService());

    await registry.refreshTools();

    const startedAt = Date.now();
    const result = await registry.executeTool("spin_forever", {
      args: {},
      chatId: "chat-timeout",
    });
    const elapsedMs = Date.now() - startedAt;
    const builtInResult = await registry.executeTool("list_directory", {
      args: { path: "." },
      chatId: "chat-timeout-follow-up",
    });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe("timeout");
    }

    expect(elapsedMs).toBeLessThan(5_000);
    expect(builtInResult.ok).toBe(true);
  }, 15_000);

  test("aborts a local tool without hanging the registry", async () => {
    await createTool(
      applicationPaths.toolsDir,
      "wait_for_abort",
      `export default {
  apiVersion: 1,
  kind: "local-tool",
  manifest: {
    name: "wait_for_abort",
    description: "Wait for abort.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: []
    },
    policy: {
      timeoutMs: 5_000
    }
  },
  async run(args, context) {
    while (!context.signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    return {
      ok: true,
      content: "aborted"
    };
  }
};
`,
    );

    const configStore = new ConfigStore(applicationPaths);
    const registry = new LocalToolRegistry(applicationPaths, configStore, new DebugLogService());
    const abortController = new AbortController();

    await registry.refreshTools();

    const resultPromise = registry.executeTool("wait_for_abort", {
      args: {},
      chatId: "chat-abort",
      signal: abortController.signal,
    });

    setTimeout(() => {
      abortController.abort();
    }, 50);

    const result = await resultPromise;

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe("aborted");
    }
  }, 15_000);
});

async function createTool(toolsDir: string, toolName: string, toolSource: string): Promise<void> {
  const toolDir = path.join(toolsDir, toolName);

  await mkdir(toolDir, { recursive: true });
  await writeFile(path.join(toolDir, "tool.ts"), toolSource, "utf8");
}
