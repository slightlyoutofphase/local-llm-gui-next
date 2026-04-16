import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatInput } from "../../components/Chat/ChatInput";
import {
  buildGlobalSettingsDraft,
  buildGlobalSettingsSavePayload,
  buildToolEnabledStates,
  resolveGlobalSettingsDraft,
} from "../../components/Settings/GlobalSettings";
import type { AppConfig, ToolSummary } from "../../lib/contracts";

test("ChatInput renders pending attachments and composer controls", () => {
  const markup = renderToStaticMarkup(
    <ChatInput
      attachmentHint="Images and text files are allowed."
      canAttachAudio={false}
      canAttachImages={true}
      canAttachText={true}
      disabled={false}
      isSending={false}
      onAddFiles={() => {}}
      onChange={() => {}}
      onError={() => {}}
      onRemoveAttachment={() => {}}
      onSend={() => {}}
      onStop={() => {}}
      pendingAttachments={[
        {
          file: new File(["hello"], "notes.md", { type: "text/markdown" }),
          fileName: "notes.md",
          id: "attachment-1",
          kind: "text",
          mimeType: "text/markdown",
          size: 5,
        },
      ]}
      value="Summarize this file"
    />,
  );

  expect(markup).toContain("Summarize this file");
  expect(markup).toContain("notes.md");
  expect(markup).toContain("text · 5 B");
  expect(markup).toContain("Add text file");
  expect(markup).toContain("application/json");
  expect(markup).toContain("Send");
});

test("buildToolEnabledStates preserves persisted values and seeds loaded tools", () => {
  const config: AppConfig = {
    autoNamingEnabled: true,
    customBinaries: {},
    debug: {
      enabled: true,
      maxEntries: 250,
      showProcessStderr: true,
      showProcessStdout: true,
      showServerLogs: true,
      verboseServerLogs: true,
    },
    llamaServerPath: "C:/llama-server.exe",
    modelsPath: "C:/models",
    theme: "dark",
    toolEnabledStates: {
      read_text_file: true,
    },
  };
  const tools: ToolSummary[] = [
    {
      description: "Read a UTF-8 text file from the workspace and return its contents.",
      enabled: true,
      id: "read_text_file",
      loadStatus: "loaded",
      name: "read_text_file",
      policy: {
        allowParallel: false,
        category: "filesystem",
        dangerous: false,
        requiresConfirmation: false,
        timeoutMs: 10_000,
      },
      source: "built-in",
    },
  ];

  expect(buildToolEnabledStates(config, tools)).toEqual({
    read_text_file: true,
  });
});

test("buildGlobalSettingsDraft keeps dialog edits separate from persisted config snapshots", () => {
  const config: AppConfig = {
    autoNamingEnabled: false,
    customBinaries: {
      llama_quantize: "C:/tools/llama-quantize.exe",
    },
    debug: {
      enabled: true,
      maxEntries: 250,
      showProcessStderr: true,
      showProcessStdout: false,
      showServerLogs: true,
      verboseServerLogs: false,
    },
    llamaServerPath: "C:/llama-server.exe",
    modelsPath: "C:/models",
    theme: "dark",
    toolEnabledStates: {
      read_text_file: true,
    },
  };
  const tools: ToolSummary[] = [
    {
      description: "Read a UTF-8 text file from the workspace and return its contents.",
      enabled: false,
      id: "write_text_file",
      loadStatus: "loaded",
      name: "write_text_file",
      policy: {
        allowParallel: false,
        category: "filesystem",
        dangerous: true,
        requiresConfirmation: true,
        timeoutMs: 10_000,
      },
      source: "local",
    },
  ];

  expect(buildGlobalSettingsDraft(config, tools)).toEqual({
    autoNamingEnabled: false,
    customBinaries: [{ key: "llama_quantize", value: "C:/tools/llama-quantize.exe" }],
    debugEnabled: true,
    llamaServerPath: "C:/llama-server.exe",
    maxEntries: 250,
    modelsPath: "C:/models",
    showProcessStderr: true,
    showProcessStdout: false,
    showServerLogs: true,
    theme: "dark",
    toolEnabledStates: {
      read_text_file: true,
      write_text_file: false,
    },
    verboseServerLogs: false,
  });
});

test("buildGlobalSettingsSavePayload trims custom binaries and preserves draft toggles", () => {
  expect(
    buildGlobalSettingsSavePayload({
      autoNamingEnabled: true,
      customBinaries: [
        { key: " llama_quantize ", value: " C:/tools/llama-quantize.exe " },
        { key: " ", value: "ignored" },
      ],
      debugEnabled: false,
      llamaServerPath: "C:/llama-server.exe",
      maxEntries: 500,
      modelsPath: "C:/models",
      showProcessStderr: false,
      showProcessStdout: true,
      showServerLogs: false,
      theme: "system",
      toolEnabledStates: {
        read_text_file: true,
      },
      verboseServerLogs: true,
    }),
  ).toEqual({
    autoNamingEnabled: true,
    customBinaries: {
      llama_quantize: "C:/tools/llama-quantize.exe",
    },
    debug: {
      enabled: false,
      maxEntries: 500,
      showProcessStderr: false,
      showProcessStdout: true,
      showServerLogs: false,
      verboseServerLogs: true,
    },
    llamaServerPath: "C:/llama-server.exe",
    modelsPath: "C:/models",
    theme: "system",
    toolEnabledStates: {
      read_text_file: true,
    },
  });
});

test("resolveGlobalSettingsDraft prefers the persisted snapshot until the user edits locally", () => {
  const persistedDraft = buildGlobalSettingsDraft(
    {
      autoNamingEnabled: true,
      customBinaries: {},
      debug: {
        enabled: true,
        maxEntries: 250,
        showProcessStderr: true,
        showProcessStdout: true,
        showServerLogs: true,
        verboseServerLogs: false,
      },
      llamaServerPath: "C:/llama-server.exe",
      modelsPath: "C:/models",
      theme: "system",
      toolEnabledStates: {},
    },
    [],
  );
  const staleLocalDraft = buildGlobalSettingsDraft(null, []);

  expect(resolveGlobalSettingsDraft(persistedDraft, staleLocalDraft, false)).toEqual(
    persistedDraft,
  );
  expect(resolveGlobalSettingsDraft(persistedDraft, staleLocalDraft, true)).toEqual(
    staleLocalDraft,
  );
});
