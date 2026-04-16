# Tools Authoring and Use

This document describes the app's local tool system as it exists in this repository today.

This is not llama-server's experimental `--tools` or `/tools` feature. The app owns the entire tool pipeline itself: it discovers local tool modules, sends enabled tool definitions to the model through the OpenAI-style `tools` field on chat-completions requests, intercepts streamed `tool_calls`, executes the selected local tool, and injects the result back into the next model turn.

## Quick Start

1. Open `Global settings` in the app.
2. In `Tool manager`, click `Open tools folder`.
3. Create a folder for your tool, for example `read_text_file`.
4. Inside that folder, create `tool.ts`.
5. Paste the example from this document.
6. Back in the app, click `Refresh tools`.
7. Confirm the tool appears with `loadStatus: loaded` and leave it enabled.
8. Load a model whose active chat template is tool-capable.
9. Ask the model to use the tool in a normal chat turn.

## Mental Model

The easiest way to reason about tools in this app is:

1. A tool is a local plugin discovered from the app-data `tools/` directory.
2. The registry validates that plugin before the model ever sees it.
3. Only enabled, successfully loaded tools are sent to the model.
4. The model can request a tool only during `POST /v1/chat/completions` generation.
5. The app hides raw streamed `tool_calls` from the visible chat transcript.
6. The app validates the tool arguments, optionally asks the user for confirmation, runs the tool, and sends the tool result back as a `tool` role message.
7. The model then gets another chat-completions turn and continues from the tool result.

## Where Tools Live

The canonical on-disk layout is:

```text
<APP_DATA>/tools/
  read_text_file/
    tool.ts
  list_directory/
    tool.ts
```

Important rules:

- Each immediate child folder under `<APP_DATA>/tools/` is exactly one tool.
- The folder name is the tool ID and must match `manifest.name` exactly.
- The canonical authoring entry file is `tool.ts`.
- The current loader can also import `tool.js`, but `tool.ts` is the intended format and the one you should author against.
- Nested tool discovery is not supported.
- Per-tool `package.json`, per-tool dependency installation, and per-tool package managers are out of scope.
- Your tool may use Bun or Node built-ins and runtime dependencies already shipped with the app.
- After adding, editing, removing, enabling, or disabling a tool, click `Refresh tools`. Changes only affect subsequent turns.

If you do not know where `<APP_DATA>/tools/` is on your machine, use the app's `Open tools folder` action instead of guessing.

## Exact Tool Contract

Every tool module must default-export an object with these required top-level fields:

- `apiVersion: 1`
- `kind: "local-tool"`
- `manifest: { ... }`
- `run(args, context) { ... }`

### `manifest`

These fields matter:

- `name`: required. Must match `^[a-z][a-z0-9_]{0,63}$` and must equal the folder name.
- `displayName`: optional. Human-friendly label shown in the UI.
- `description`: required. Non-empty string shown to the model.
- `inputSchema`: required. The root must be an object schema with `additionalProperties: false`.
- `outputSchema`: optional. Describes the shape of `data` on success. It is validated at load time.
- `policy`: optional. Execution and UI hints.

### Supported schema subset

Supported schema types are:

- `string`
- `number`
- `integer`
- `boolean`
- `array`
- `object`

Supported object-schema fields are:

- `properties`
- `required`
- `additionalProperties`
- `title`
- `description`

Supported string and numeric constraints are:

- `enum`
- `minLength`
- `maxLength`
- `minimum`
- `maximum`
- `minItems`
- `maxItems`

Not supported in v1:

- `$ref`
- `oneOf`
- `anyOf`
- `allOf`
- `patternProperties`
- recursive schemas
- custom runtime validators

The loader will reject unsupported schemas and the Tool Manager will show the exact load error.

### `policy`

The supported policy fields are:

- `enabledByDefault?: boolean`
- `dangerous?: boolean`
- `requiresConfirmation?: boolean`
- `allowParallel?: boolean`
- `timeoutMs?: number`
- `category?: "filesystem" | "network" | "system" | "data" | "custom"`

Actual behavior to keep in mind:

- `enabledByDefault` defaults to `true`.
- `dangerous` is UI metadata. It marks the tool as side-effecting in Tool Manager and in confirmation UI.
- `requiresConfirmation` is what actually pauses execution and asks the user before the backend runs the tool.
- `allowParallel` is stored in policy metadata, but the current chat orchestration still forces `parallel_tool_calls: false` and executes sequentially.
- `timeoutMs` becomes the tool's execution timeout if provided.
- `category` is used for grouping and display in the UI.

### `run(args, context)`

`run(...)` may be synchronous or async. It receives validated arguments and a runtime context containing:

- `signal`: abort signal for cancellation or timeout.
- `callId`: unique ID for this tool call.
- `chatId`: chat that triggered the call.
- `appDataDir`: app data root.
- `workspaceDir`: workspace root, if one is configured.
- `tempDir`: scratch directory for temporary files.
- `modelName`: active model ID when known.
- `log(...)`: structured logging hook that goes to the backend debug log.

Your tool must return one of these two shapes:

Successful result:

```ts
{
  ok: true,
  content: "Short model-facing summary",
  data: { ...optional JSON-serializable structured payload... }
}
```

Failure result:

```ts
{
  ok: false,
  error: {
    code: "machine_readable_code",
    message: "Human-readable failure message",
    retryable: true,
    data: { ...optional JSON-serializable structured payload... }
  }
}
```

Everything in `data` must be JSON-serializable. If your tool throws, times out, is aborted, returns invalid data, or receives invalid arguments, the registry normalizes that into a structured failure.

## A Real Tool Example

Create this file:

```text
<APP_DATA>/tools/read_text_file/tool.ts
```

Paste this exact example:

```ts
import { readFile } from "node:fs/promises";
import path from "node:path";

function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
  const normalizedCandidate = path.resolve(candidatePath);
  const normalizedRoot = path.resolve(rootPath);

  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`)
  );
}

export default {
  apiVersion: 1,
  kind: "local-tool",
  manifest: {
    name: "read_text_file",
    displayName: "Read Text File",
    description:
      "Read a UTF-8 text file from the current workspace and return its contents.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        relativePath: {
          type: "string",
          minLength: 1,
          description: "Path relative to the current workspace root.",
        },
        maxBytes: {
          type: "integer",
          minimum: 1,
          maximum: 20000,
          description: "Optional maximum number of bytes to read.",
        },
      },
      required: ["relativePath"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        relativePath: { type: "string" },
        sizeBytes: { type: "integer" },
        text: { type: "string" },
      },
      required: ["relativePath", "sizeBytes", "text"],
    },
    policy: {
      category: "filesystem",
      enabledByDefault: true,
      dangerous: false,
      requiresConfirmation: false,
      timeoutMs: 5000,
    },
  },
  async run(args, context) {
    const relativePath = typeof args.relativePath === "string" ? args.relativePath : "";
    const maxBytes = typeof args.maxBytes === "number" ? args.maxBytes : 16000;

    if (!context.workspaceDir) {
      return {
        ok: false,
        error: {
          code: "workspace_unavailable",
          message: "This tool requires an open workspace.",
        },
      };
    }

    const absolutePath = path.resolve(context.workspaceDir, relativePath);

    if (!isPathInsideRoot(absolutePath, context.workspaceDir)) {
      return {
        ok: false,
        error: {
          code: "path_out_of_bounds",
          message: "relativePath must stay inside the current workspace.",
        },
      };
    }

    context.log({
      level: "info",
      message: `Reading file: ${relativePath}`,
      data: {
        callId: context.callId,
        modelName: context.modelName ?? null,
      },
    });

    const fileBuffer = await readFile(absolutePath, {
      signal: context.signal,
    });
    const sizeBytes = Math.min(fileBuffer.length, maxBytes);
    const text = fileBuffer.subarray(0, maxBytes).toString("utf8");

    return {
      ok: true,
      content: `Read ${sizeBytes} bytes from ${relativePath}.`,
      data: {
        relativePath,
        sizeBytes,
        text,
      },
    };
  },
};
```

What this example demonstrates:

- A valid `apiVersion` and `kind`.
- A folder name that matches `manifest.name`.
- A root `inputSchema` with `type: "object"` and `additionalProperties: false`.
- Safe use of `workspaceDir` so the tool does not escape the current repo.
- Use of `context.signal` so reads can be aborted on cancel or timeout.
- Use of `context.log(...)` for debug visibility.
- A short `content` string for the model and a richer `data` payload for follow-up reasoning.

If you are writing a destructive tool such as rename, delete, or write, change the policy to:

```ts
policy: {
  category: "filesystem",
  dangerous: true,
  requiresConfirmation: true,
  timeoutMs: 5000,
}
```

That will cause the app to stop and show a confirmation dialog before execution.

## How to Load and Enable the Tool in the App

Once the file exists, use this flow:

1. Open `Global settings`.
2. Find the `Tool manager` section.
3. Click `Refresh tools`.
4. Look for your tool in the list.
5. If it shows `rejected`, fix the exact error shown in the UI and refresh again.
6. If it shows `loaded`, make sure its toggle is enabled.

What Tool Manager shows for each discovered tool:

- source: `built-in` or `local`
- display name or tool name
- description
- enabled state
- policy flags such as `dangerous` and `requiresConfirmation`
- load status
- exact load error, if rejected
- source path, when available

Enable and disable changes are persisted immediately in backend config and survive restarts.

## How to Use a Tool With a Model

### Step 1: Make sure the active template is tool-capable

Tools only work in chat generation, and only when the active chat template supports tool use.

In practice, the current runtime checks whether the active template contains tool-related markers such as:

- `tools`
- `tool_calls`
- `tool_call_id`

If the loaded model's built-in chat template is not tool-capable, add a Jinja template override in the Preset Editor before expecting tool calls to work.

### Step 2: Load the model and keep the tool enabled

Only enabled, successfully loaded tools are sent to the model.

Disabled tools remain visible in Tool Manager but are not exposed to the model.

### Step 3: Ask naturally, but be explicit

For the example tool above, a good prompt is:

```text
Use the read_text_file tool to read README.md from the workspace root, then summarize the setup steps.
```

You do not call the tool manually from the chat UI. You ask the model to solve the task, and the model decides whether to emit a tool call.

### Step 4: What the app sends upstream

For enabled tools, the app adds a `tools` array to the chat-completions request and also sets:

```json
{
  "parse_tool_calls": true,
  "parallel_tool_calls": false
}
```

The tool definition sent for the example looks like this in principle:

```json
{
  "type": "function",
  "function": {
    "name": "read_text_file",
    "description": "Read a UTF-8 text file from the current workspace and return its contents.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "relativePath": { "type": "string", "minLength": 1 },
        "maxBytes": { "type": "integer", "minimum": 1, "maximum": 20000 }
      },
      "required": ["relativePath"]
    }
  }
}
```

### Step 5: What the model emits

If the model decides to use the tool, the streamed assistant turn contains a tool call similar to this:

```json
{
  "tool_calls": [
    {
      "id": "call_1",
      "type": "function",
      "function": {
        "name": "read_text_file",
        "arguments": "{\"relativePath\":\"README.md\",\"maxBytes\":4000}"
      }
    }
  ]
}
```

The app intercepts that payload before it becomes visible as a normal chat message.

### Step 6: What the user sees

The visible chat UX is:

- Raw `tool_calls` deltas are suppressed.
- The app may show a compact status update such as `Running tool: read_text_file`.
- If `requiresConfirmation` is `true`, a confirmation dialog opens and shows the tool name, category, danger badge, and the exact JSON arguments.
- After the tool finishes, the chat resumes and the assistant continues with a normal response.

### Step 7: What the model gets back

The backend appends a `tool` role message to the next chat-completions turn. The content of that message is the JSON string form of the tool result.

For a successful result, the conversation message injected back to the model looks like this:

```json
{
  "role": "tool",
  "tool_call_id": "call_1",
  "content": "{\"ok\":true,\"content\":\"Read 1820 bytes from README.md.\",\"data\":{\"relativePath\":\"README.md\",\"sizeBytes\":1820,\"text\":\"...file contents...\"}}"
}
```

After that, the model gets another assistant turn and can summarize, explain, or ask for the next tool call.

## Common Load Errors and What They Mean

These are the main failure modes you will see in Tool Manager:

- `Missing tool entry file. Expected tool.ts.`
- `Invalid apiVersion. Expected 1.`
- `Invalid kind. Expected "local-tool".`
- `Tool module must export a run(...) function.`
- `Tool manifest is missing or invalid.`
- `Tool manifest name must match ^[a-z][a-z0-9_]{0,63}$.`
- `Tool folder name must match manifest.name exactly.`
- `<tool>.inputSchema must use an object schema at the root.`
- `<tool>.inputSchema must set additionalProperties to false at the root.`
- `<tool>.inputSchema uses unsupported schema keyword $ref.`
- `Duplicate tool name: <name>.`

The app keeps rejected tools in the registry so you can see the exact failure instead of a generic load error.

## Common Runtime Failures

These are the main runtime failures to expect:

- `tool_disabled`: the tool exists but is currently disabled.
- `tool_not_found`: the model asked for a tool that is not in the enabled registry snapshot.
- `invalid_arguments`: the model emitted JSON arguments that do not match your declared `inputSchema`.
- `timeout`: the tool exceeded its configured timeout.
- `aborted`: the user stopped generation or the request was otherwise canceled.
- `execution_failed`: your tool threw an exception.
- `invalid_result`: your tool returned a shape that is not a valid `ToolResult`.

These failures are still passed back to the model as structured tool results so the model can recover or explain what went wrong.

## Authoring Guidelines That Will Save You Time

- Keep `description` specific. The model uses it to decide when to call the tool.
- Keep `inputSchema` small and explicit. Simpler schemas are easier for the model to satisfy.
- Put the model-facing summary in `content` and the detailed machine-readable payload in `data`.
- Return structured failures instead of throwing for expected conditions such as missing files or invalid paths.
- Use `workspaceDir` and `appDataDir` deliberately. Do not assume the current process working directory is the repo root.
- Use `context.signal` for long-running or I/O-heavy work.
- Set `requiresConfirmation: true` for anything that writes, deletes, renames, sends network mutations, or otherwise has side effects.
- Remember that `dangerous: true` marks the tool as risky, but confirmation only happens when `requiresConfirmation: true` is also set.
- Remember that editing a tool file is not hot-reloaded into the current generation. Refresh it and then start a new turn.

## Minimal Checklist

Before expecting a tool to work end to end, verify all of these are true:

- The folder name matches `manifest.name`.
- The file is `tool.ts`.
- The module default-export is an object with `apiVersion: 1` and `kind: "local-tool"`.
- `manifest.description` is non-empty.
- `inputSchema` is an object schema with `additionalProperties: false` at the root.
- No unsupported schema keywords are present.
- The tool shows `loaded` in Tool Manager.
- The tool toggle is enabled.
- The active model template is tool-capable.
- You are testing through chat generation, not raw completion.

## Source of Truth in This Repo

If you change this system, these files are the implementation sources to keep aligned with this document:

- [src/backend/tools/types.ts](src/backend/tools/types.ts)
- [src/backend/tools/registry.ts](src/backend/tools/registry.ts)
- [src/backend/chatOrchestrator.ts](src/backend/chatOrchestrator.ts)
- [src/backend/llamaServer.ts](src/backend/llamaServer.ts)
- [src/components/Settings/GlobalSettings.tsx](src/components/Settings/GlobalSettings.tsx)
- [src/components/ChatApp.tsx](src/components/ChatApp.tsx)
- [src/test/backend/toolRegistry.test.ts](src/test/backend/toolRegistry.test.ts)
- [src/test/backend/chatOrchestrator.test.ts](src/test/backend/chatOrchestrator.test.ts)
- [local_llm_gui_spec.md](local_llm_gui_spec.md)