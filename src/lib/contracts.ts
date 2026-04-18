/**
 * Represents the available UI theme modes.
 */
export type ThemePreference = "light" | "dark" | "system";

/**
 * Enumerates the supported experimental KV-cache quantization types.
 */
export type KvCacheType =
  | "f32"
  | "f16"
  | "bf16"
  | "q8_0"
  | "q4_0"
  | "q4_1"
  | "iq4_nl"
  | "q5_0"
  | "q5_1";

/**
 * Describes how the application should react when the active context is full.
 */
export type ContextOverflowStrategy = "truncate-middle" | "rolling-window" | "stop-at-limit";

/**
 * Enumerates the supported structured-output request modes.
 */
export type StructuredOutputMode = "off" | "json_object" | "json_schema";

/**
 * Enumerates the persisted validation outcomes for a structured assistant turn.
 */
export type StructuredOutputValidationStatus =
  | "valid"
  | "parse_error"
  | "schema_error"
  | "truncated";

/**
 * Captures post-response structured-output validation metadata for an assistant turn.
 */
export interface StructuredOutputMetadata {
  /** The structured-output mode that was active for the request. */
  mode: Exclude<StructuredOutputMode, "off">;
  /** The persisted validation outcome. */
  status: StructuredOutputValidationStatus;
  /** Optional human-readable validation failure details. */
  error?: string;
  /** Optional parsed JSON value retained after successful validation. */
  parsedValue?: unknown;
}

/**
 * Enumerates the supported high-level tool categories.
 */
export type ToolCategory = "filesystem" | "network" | "system" | "data" | "custom";

/**
 * Enumerates the supported tool discovery sources.
 */
export type ToolSource = "built-in" | "local";

/**
 * Enumerates the load states for a discovered local tool.
 */
export type ToolLoadStatus = "loaded" | "rejected";

/**
 * Describes the user-visible execution policy for a tool.
 */
export interface ToolPolicySummary {
  /** Indicates whether the tool may mutate local state or files. */
  dangerous: boolean;
  /** Indicates whether the user must explicitly confirm each execution. */
  requiresConfirmation: boolean;
  /** Indicates whether concurrent invocations are permitted. */
  allowParallel: boolean;
  /** Optional execution timeout in milliseconds. */
  timeoutMs?: number;
  /** High-level category used for filtering and UX. */
  category: ToolCategory;
}

/**
 * Represents a discovered built-in or local tool shown in the manager UI.
 */
export interface ToolSummary {
  /** Stable tool identifier, matching the canonical manifest name. */
  id: string;
  /** Stable tool manifest name. */
  name: string;
  /** Optional user-facing display name. */
  displayName?: string;
  /** User-facing tool description. */
  description: string;
  /** Whether the tool is currently enabled. */
  enabled: boolean;
  /** Where the tool originated from. */
  source: ToolSource;
  /** Current load status. */
  loadStatus: ToolLoadStatus;
  /** Optional source path on disk for local tools. */
  sourcePath?: string;
  /** Optional load/validation error text for rejected tools. */
  error?: string;
  /** User-visible execution policy summary. */
  policy: ToolPolicySummary;
}

/**
 * Represents the persisted debug-log preferences.
 */
export interface DebugLogSettings {
  /** Enables or disables debug log collection. */
  enabled: boolean;
  /** Shows `llama-server` stdout lines in the frontend debug window. */
  showProcessStdout: boolean;
  /** Shows `llama-server` stderr lines in the frontend debug window. */
  showProcessStderr: boolean;
  /** Shows Bun backend log events in the frontend debug window. */
  showServerLogs: boolean;
  /** Emits additional backend request-tracing logs during send and generation flows. */
  verboseServerLogs: boolean;
  /** Caps the in-memory log buffer size while clients are connected. */
  maxEntries: number;
}

/**
 * Represents the persisted global application configuration.
 */
export interface AppConfig {
  /** Absolute path to the `llama-server` executable. */
  llamaServerPath: string;
  /** Absolute path to the root GGUF models directory. */
  modelsPath: string;
  /** Additional named binary paths maintained by the user. */
  customBinaries: Record<string, string>;
  /** The active UI theme preference. */
  theme: ThemePreference;
  /** Enables or disables background auto-naming. */
  autoNamingEnabled: boolean;
  /** Persisted tool enabled-state keyed by canonical tool name. */
  toolEnabledStates: Record<string, boolean>;
  /** Debug window collection and filtering defaults. */
  debug: DebugLogSettings;
  /** Monotonically increasing revision to detect concurrent cross-tab updates. */
  configRevision?: number;
}

/**
 * Enumerates the media attachment kinds supported by persisted messages.
 */
export type MediaAttachmentKind = "image" | "audio" | "text";

/**
 * Represents a media file attached to a persisted chat message.
 */
export interface MediaAttachmentRecord {
  /** Stable identifier for the attachment row. */
  id: string;
  /** The attachment media category. */
  kind: MediaAttachmentKind;
  /** The original filename captured at upload time. */
  fileName: string;
  /** The resolved MIME type used for later request reconstruction. */
  mimeType: string;
  /** Absolute path to the persisted attachment file on disk. */
  filePath: string;
  /** File size in bytes. */
  byteSize: number;
}

/**
 * Enumerates the supported chat message roles.
 */
export type ChatMessageRole = "system" | "user" | "assistant" | "tool";

/**
 * Represents a single persisted chat message row.
 */
export interface ChatMessageRecord {
  /** Stable identifier for the message row. */
  id: string;
  /** Parent chat identifier. */
  chatId: string;
  /** Zero-based sequence number within the chat. */
  sequence: number;
  /** The message role rendered to or from the model. */
  role: ChatMessageRole;
  /** The user-visible textual content of the message. */
  content: string;
  /** Persisted attachment metadata referenced by this message. */
  mediaAttachments: MediaAttachmentRecord[];
  /** Optional structured reasoning content captured separately from visible text. */
  reasoningContent?: string;
  /** Indicates whether reasoning content was truncated mid-stream. */
  reasoningTruncated?: boolean;
  /** RFC 3339 timestamp of when the message was created. */
  createdAt: string;
  /** Additional backend-only metadata associated with the message. */
  metadata: Record<string, unknown>;
}

/**
 * Represents a chat summary shown in navigation and history lists.
 */
export interface ChatSummary {
  /** Stable identifier for the chat. */
  id: string;
  /** Human-readable chat title. */
  title: string;
  /** RFC 3339 creation timestamp. */
  createdAt: string;
  /** RFC 3339 timestamp of the last update. */
  updatedAt: string;
  /** Optional last-used model hint retained at the chat level. */
  lastUsedModelId?: string;
}

/**
 * Represents the raw fallback reasoning tag pair used by a preset.
 */
export interface ThinkingTagSettings {
  /** Opening tag string for raw reasoning capture. */
  startString: string;
  /** Closing tag string for raw reasoning capture. */
  endString: string;
}

/**
 * Represents a persisted system prompt preset.
 */
export interface SystemPromptPreset {
  /** Stable identifier for the preset. */
  id: string;
  /** The model identifier this preset is associated with. */
  modelId: string;
  /** User-facing preset name. */
  name: string;
  /** The system instruction text applied ahead of chat history. */
  systemPrompt: string;
  /** Optional Jinja template override persisted for this preset. */
  jinjaTemplateOverride?: string;
  /** The raw reasoning tags to use when server-native reasoning is unavailable. */
  thinkingTags: ThinkingTagSettings;
  /** Indicates whether this is the model's generated default preset. */
  isDefault: boolean;
  /** RFC 3339 creation timestamp. */
  createdAt: string;
  /** RFC 3339 last-update timestamp. */
  updatedAt: string;
}

/**
 * Represents inference defaults extracted from a GGUF header.
 */
export interface ModelSamplingDefaults {
  /** Optional GGUF-provided default top-k value. */
  topK?: number;
  /** Optional GGUF-provided default top-p value. */
  topP?: number;
  /** Optional GGUF-provided default temperature value. */
  temperature?: number;
  /** Optional GGUF-provided default min-p value. */
  minP?: number;
  /** Optional GGUF-provided default repeat-penalty value. */
  repeatPenalty?: number;
}

/**
 * Represents the fully editable load and inference preset settings.
 */
export interface LoadInferenceSettings {
  /** Spawn-time context length. */
  contextLength: number;
  /** Spawn-time GPU layer offload count. */
  gpuLayers: number;
  /** Spawn-time CPU thread count. */
  cpuThreads: number;
  /** Spawn-time evaluation batch size. */
  batchSize: number;
  /** Spawn-time micro-batch size. */
  ubatchSize: number;
  /** Optional K-cache quantization mode. */
  kvCacheTypeK?: KvCacheType;
  /** Optional V-cache quantization mode. */
  kvCacheTypeV?: KvCacheType;
  /** Enables unified KV cache mode. */
  unifiedKvCache: boolean;
  /** Indicates whether KV cache offload remains enabled. */
  offloadKvCache: boolean;
  /** Indicates whether memory-mapped model loading is enabled. */
  useMmap: boolean;
  /** Indicates whether the model should be memory-locked. */
  keepModelInMemory: boolean;
  /** Enables flash attention when supported. */
  flashAttention: boolean;
  /** Enables the full SWA cache mode when supported. */
  fullSwaCache: boolean;
  /** Optional RoPE frequency base override. */
  ropeFrequencyBase?: number;
  /** Optional RoPE frequency scale override. */
  ropeFrequencyScale?: number;
  /** Enables spawn-time context shifting. */
  contextShift: boolean;
  /** Optional minimum image token budget. */
  imageMinTokens?: number;
  /** Optional maximum image token budget. */
  imageMaxTokens?: number;
  /** Seed passed to `llama-server`; `-1` keeps randomness. */
  seed: number;
  /** Enables template-driven thinking mode when the template supports it. */
  thinkingEnabled: boolean;
  /** Optional response length cap. */
  responseLengthLimit?: number;
  /** Active context overflow strategy. */
  overflowStrategy: ContextOverflowStrategy;
  /** Additional stop strings injected per request. */
  stopStrings: string[];
  /** Per-request sampling temperature. */
  temperature: number;
  /** Per-request top-k setting. */
  topK: number;
  /** Per-request top-p setting. */
  topP: number;
  /** Per-request min-p setting. */
  minP: number;
  /** Per-request presence penalty. */
  presencePenalty: number;
  /** Per-request repeat penalty. */
  repeatPenalty: number;
  /** Structured-output mode applied per request. */
  structuredOutputMode: StructuredOutputMode;
  /** Optional structured-output JSON schema string used in `json_schema` mode. */
  structuredOutputSchema?: string;
}

/**
 * Represents a persisted load and inference preset.
 */
export interface LoadInferencePreset {
  /** Stable identifier for the preset. */
  id: string;
  /** The model identifier this preset is associated with. */
  modelId: string;
  /** User-facing preset name. */
  name: string;
  /** The persisted load and inference settings bundle. */
  settings: LoadInferenceSettings;
  /** Indicates whether this is the model's generated default preset. */
  isDefault: boolean;
  /** RFC 3339 creation timestamp. */
  createdAt: string;
  /** RFC 3339 last-update timestamp. */
  updatedAt: string;
}

/**
 * Represents a discovered GGUF model entry exposed to the frontend.
 */
export interface ModelRecord {
  /** Stable identifier derived from publisher, model folder, and file name. */
  id: string;
  /** Publisher directory name. */
  publisher: string;
  /** Model directory name. */
  modelName: string;
  /** GGUF filename. */
  fileName: string;
  /** Absolute path to the base GGUF file. */
  modelPath: string;
  /** Optional absolute path to the associated MMPROJ GGUF file. */
  mmprojPath?: string;
  /** Base GGUF file size in bytes. */
  fileSizeBytes: number;
  /** Optional GGUF-reported architecture. */
  architecture?: string;
  /** Optional GGUF-reported context length. */
  contextLength?: number;
  /** Optional GGUF-reported parameter count. */
  parameterCount?: number;
  /** Optional GGUF-reported transformer block count. */
  layerCount?: number;
  /** Optional quantization label inferred from metadata or filename. */
  quantization?: string;
  /** Optional embedded chat template string. */
  chatTemplate?: string;
  /** Whether the associated multimodal stack reports audio support. */
  supportsAudio: boolean;
  /** GGUF-provided default sampling values. */
  defaultSampling: ModelSamplingDefaults;
}

/**
 * Enumerates the high-level lifecycle states of the managed `llama-server` process.
 */
export type RuntimeStatus = "idle" | "loading" | "ready" | "error";

/**
 * Represents the current managed runtime snapshot exposed through the backend.
 */
export interface RuntimeSnapshot {
  /** Current lifecycle status for the managed runtime. */
  status: RuntimeStatus;
  /** Active model identifier, when loaded. */
  activeModelId: string | null;
  /** Active base GGUF path, when loaded. */
  activeModelPath: string | null;
  /** Local base URL for the managed `llama-server` instance. */
  llamaServerBaseUrl: string | null;
  /** Latest model-load progress percentage, when loading. */
  loadProgress: number | null;
  /** Latest derived context token count, when available. */
  contextTokens: number | null;
  /** Active runtime context ceiling in tokens, when known. */
  contextLimitTokens?: number | null;
  /** Latest predicted tokens-per-second value, when available. */
  tokensPerSecond: number | null;
  /** Whether the runtime currently exposes multimodal capability. */
  multimodal: boolean;
  /** Whether the runtime currently exposes audio capability. */
  audio: boolean;
  /** Most recent runtime error message, when present. */
  lastError: string | null;
  /** RFC 3339 timestamp of the most recent snapshot update. */
  updatedAt: string;
}

/**
 * Enumerates the detected llama.cpp accelerator backend families.
 */
export type HardwareBackendType = "cpu" | "cuda" | "metal" | "rocm" | "unknown" | "vulkan";

/**
 * Represents a single detected GPU memory snapshot.
 */
export interface GpuMemorySnapshot {
  /** Optional GPU adapter name. */
  name?: string;
  /** Total VRAM capacity in bytes. */
  totalVramBytes: number;
  /** Currently free VRAM in bytes. */
  freeVramBytes: number;
}

/**
 * Represents the scanned host hardware profile used by the optimizer.
 */
export interface HardwareProfile {
  /** Detected llama.cpp backend family. */
  backend: HardwareBackendType;
  /** Best-effort raw help output from the configured llama-server binary. */
  backendDetails?: string;
  /** Detected logical CPU core count. */
  logicalCpuCount: number;
  /** Best-effort GPU memory scan results. */
  gpus: GpuMemorySnapshot[];
  /** Whether the current backend can offload layers to a GPU. */
  supportsGpuOffload: boolean;
  /** Total system RAM in bytes. */
  totalRamBytes: number;
}

/**
 * Represents the optimizer's recommended load settings for a model.
 */
export interface HardwareOptimizerRecommendation {
  /** Estimated CPU-resident model bytes after offload. */
  estimatedModelRamBytes: number;
  /** Estimated KV/context bytes at the recommended context length. */
  estimatedContextRamBytes: number;
  /** Estimated GPU VRAM bytes consumed by offloaded layers. */
  estimatedGpuUsageBytes: number;
  /** Estimated total RAM usage for the recommendation. */
  estimatedTotalRamBytes: number;
  /** Indicates that the requested context length would exceed safe RAM limits. */
  exceedsSystemRam: boolean;
  /** Maximum number of layers that can be offloaded with the current VRAM budget. */
  maxOffloadableLayers: number;
  /** Human-readable reasoning lines shown in the optimizer UI. */
  reasoning: string[];
  /** Recommended context length after RAM safety clamping. */
  recommendedContextLength: number;
  /** Recommended CPU thread count. */
  recommendedCpuThreads: number;
  /** Recommended GPU offload layer count. */
  recommendedGpuLayers: number;
}

/**
 * Represents a complete hardware optimizer response.
 */
export interface HardwareOptimizerResult {
  /** The scanned host hardware profile. */
  hardware: HardwareProfile;
  /** The calculated recommendation for the selected model and context size. */
  recommendation: HardwareOptimizerRecommendation;
}

/**
 * Enumerates the supported debug log sources.
 */
export type DebugLogSource = "process:stdout" | "process:stderr" | "server:log";

/**
 * Represents a single debug log entry emitted to the frontend.
 */
export interface DebugLogEntry {
  /** Stable identifier for the log entry. */
  id: string;
  /** RFC 3339 timestamp of when the entry was created. */
  timestamp: string;
  /** Logical source category for the entry. */
  source: DebugLogSource;
  /** Raw log message content. */
  message: string;
}
