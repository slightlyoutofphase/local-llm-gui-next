"use client";

import { Template } from "@huggingface/jinja";
import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import type {
  ContextOverflowStrategy,
  HardwareOptimizerRecommendation,
  KvCacheType,
  LoadInferencePreset,
  ModelRecord,
  StructuredOutputMode,
  SystemPromptPreset,
  ToolSummary,
} from "@/lib/contracts";
import {
  LOAD_INFERENCE_LIMITS,
  validateLoadInferenceSettings,
} from "@/lib/loadInferenceValidation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { HardwareOptimizer } from "@/components/Settings/HardwareOptimizer";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

const KV_CACHE_OPTIONS: KvCacheType[] = [
  "f32",
  "f16",
  "bf16",
  "q8_0",
  "q4_0",
  "q4_1",
  "iq4_nl",
  "q5_0",
  "q5_1",
];
const OVERFLOW_OPTIONS: Array<{ label: string; value: ContextOverflowStrategy }> = [
  { label: "Truncate middle", value: "truncate-middle" },
  { label: "Rolling window", value: "rolling-window" },
  { label: "Stop at limit", value: "stop-at-limit" },
];
const STRUCTURED_OUTPUT_OPTIONS: Array<{ label: string; value: StructuredOutputMode }> = [
  { label: "Off", value: "off" },
  { label: "Any JSON Object", value: "json_object" },
  { label: "JSON Schema", value: "json_schema" },
];

export interface PresetEditorDialogProps {
  loadPresets: LoadInferencePreset[];
  model: ModelRecord | null;
  onCreateLoadPreset: (
    input: Pick<LoadInferencePreset, "name" | "settings">,
  ) => Promise<LoadInferencePreset | null>;
  onCreateSystemPreset: (
    input: Pick<SystemPromptPreset, "name" | "systemPrompt" | "thinkingTags"> & {
      jinjaTemplateOverride?: string;
    },
  ) => Promise<SystemPromptPreset | null>;
  onDeleteLoadPreset: (presetId: string) => Promise<void>;
  onDeleteSystemPreset: (presetId: string) => Promise<void>;
  onOpenChange: (open: boolean) => void;
  onSelectLoadPreset: (presetId: string) => void;
  onSelectSystemPreset: (presetId: string) => void;
  onSetDefaultLoadPreset: (presetId: string) => Promise<void>;
  onSetDefaultSystemPreset: (presetId: string) => Promise<void>;
  onUpdateLoadPreset: (
    presetId: string,
    input: Pick<LoadInferencePreset, "name" | "settings">,
  ) => Promise<LoadInferencePreset | null>;
  onUpdateSystemPreset: (
    presetId: string,
    input: Pick<SystemPromptPreset, "name" | "systemPrompt" | "thinkingTags"> & {
      jinjaTemplateOverride?: string;
    },
  ) => Promise<SystemPromptPreset | null>;
  open: boolean;
  presetsSaving: boolean;
  selectedLoadPresetId: string | undefined;
  selectedSystemPresetId: string | undefined;
  systemPresets: SystemPromptPreset[];
  tools: ToolSummary[];
}

/**
 * Renders the preset editor dialog for system-prompt and load/inference presets.
 */
export function PresetEditorDialog({
  loadPresets,
  model,
  onCreateLoadPreset,
  onCreateSystemPreset,
  onDeleteLoadPreset,
  onDeleteSystemPreset,
  onOpenChange,
  onSelectLoadPreset,
  onSelectSystemPreset,
  onSetDefaultLoadPreset,
  onSetDefaultSystemPreset,
  onUpdateLoadPreset,
  onUpdateSystemPreset,
  open,
  presetsSaving,
  selectedLoadPresetId,
  selectedSystemPresetId,
  systemPresets,
  tools,
}: PresetEditorDialogProps): ReactElement {
  const selectedSystemPreset = useMemo(
    () =>
      systemPresets.find((preset) => preset.id === selectedSystemPresetId) ??
      systemPresets[0] ??
      null,
    [selectedSystemPresetId, systemPresets],
  );
  const selectedLoadPreset = useMemo(
    () =>
      loadPresets.find((preset) => preset.id === selectedLoadPresetId) ?? loadPresets[0] ?? null,
    [loadPresets, selectedLoadPresetId],
  );
  const [systemDraft, setSystemDraft] = useState<SystemPromptPreset | null>(selectedSystemPreset);
  const [loadDraft, setLoadDraft] = useState<LoadInferencePreset | null>(selectedLoadPreset);

  useEffect(() => {
    setSystemDraft(selectedSystemPreset);
  }, [selectedSystemPreset]);

  useEffect(() => {
    setLoadDraft(selectedLoadPreset);
  }, [selectedLoadPreset]);

  const enabledTools = useMemo(() => tools.filter((tool) => tool.enabled), [tools]);
  const activeTemplateText =
    systemDraft?.jinjaTemplateOverride?.trim() || model?.chatTemplate?.trim() || "";
  const templateError = useMemo(() => {
    if (!systemDraft?.jinjaTemplateOverride?.trim()) {
      return null;
    }

    try {
      void new Template(systemDraft.jinjaTemplateOverride);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "Invalid Jinja template.";
    }
  }, [systemDraft?.jinjaTemplateOverride]);
  const toolTemplateSupported = useMemo(() => {
    const normalizedTemplate = activeTemplateText.toLowerCase();

    return (
      normalizedTemplate.includes("tool_calls") ||
      normalizedTemplate.includes("tool_call_id") ||
      normalizedTemplate.includes("tools")
    );
  }, [activeTemplateText]);
  const loadSettingsError = useMemo(
    () => (loadDraft ? validateLoadInferenceSettings(loadDraft.settings) : null),
    [loadDraft],
  );

  if (!model) {
    return (
      <Dialog onOpenChange={onOpenChange} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Preset editor</DialogTitle>
            <DialogDescription>Select a model before editing presets.</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="flex flex-col h-[min(92vh,72rem)] w-[min(96vw,96rem)] max-w-none overflow-hidden p-0 sm:max-w-none sm:resize">
        <DialogHeader className="shrink-0 border-b border-border/70 px-5 pt-5 pb-4 sm:px-6 sm:pt-6">
          <DialogTitle>Preset editor</DialogTitle>
          <DialogDescription>
            Edit the system prompt, Jinja template, thinking tags, and load/inference settings for{" "}
            {model.publisher} / {model.modelName}. Drag the lower-right corner to resize.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 flex-1 px-5 py-5 sm:px-6">
          <div className="grid gap-6 xl:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
            <section className="min-w-0 space-y-4 rounded-[1.5rem] border border-border/70 bg-card/80 p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold">System prompt presets</p>
                  <p className="text-sm text-muted-foreground">
                    System prompt text, Jinja overrides, and thinking tags.
                  </p>
                </div>
                <Button
                  disabled={!systemDraft || presetsSaving}
                  onClick={() => {
                    if (!systemDraft) {
                      return;
                    }

                    void onCreateSystemPreset({
                      ...(systemDraft.jinjaTemplateOverride
                        ? { jinjaTemplateOverride: systemDraft.jinjaTemplateOverride }
                        : {}),
                      name: `${systemDraft.name} copy`,
                      systemPrompt: systemDraft.systemPrompt,
                      thinkingTags: systemDraft.thinkingTags,
                    });
                  }}
                  type="button"
                  variant="outline">
                  Duplicate
                </Button>
              </div>

              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
                <select
                  className="h-10 rounded-xl border border-border/80 bg-background px-3 text-sm"
                  onChange={(event) => {
                    onSelectSystemPreset(event.target.value);
                  }}
                  value={selectedSystemPreset?.id ?? ""}>
                  {systemPresets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name}
                      {preset.isDefault ? " (default)" : ""}
                    </option>
                  ))}
                </select>
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={
                      !selectedSystemPreset || selectedSystemPreset.isDefault || presetsSaving
                    }
                    onClick={() => {
                      if (selectedSystemPreset) {
                        void onSetDefaultSystemPreset(selectedSystemPreset.id);
                      }
                    }}
                    type="button"
                    variant="outline">
                    Make default
                  </Button>
                  <Button
                    disabled={systemPresets.length <= 1 || !selectedSystemPreset || presetsSaving}
                    onClick={() => {
                      if (selectedSystemPreset) {
                        void onDeleteSystemPreset(selectedSystemPreset.id);
                      }
                    }}
                    type="button"
                    variant="outline">
                    Delete
                  </Button>
                </div>
              </div>

              <div className="space-y-3">
                <Field label="Preset name">
                  <Input
                    onChange={(event) => {
                      setSystemDraft((currentDraft) =>
                        currentDraft
                          ? {
                              ...currentDraft,
                              name: event.target.value,
                            }
                          : currentDraft,
                      );
                    }}
                    value={systemDraft?.name ?? ""}
                  />
                </Field>

                <Field label="System prompt">
                  <Textarea
                    className="min-h-48 resize-y"
                    onChange={(event) => {
                      setSystemDraft((currentDraft) =>
                        currentDraft
                          ? {
                              ...currentDraft,
                              systemPrompt: event.target.value,
                            }
                          : currentDraft,
                      );
                    }}
                    value={systemDraft?.systemPrompt ?? ""}
                  />
                </Field>

                <Field label="Jinja template override">
                  <Textarea
                    className="min-h-52 resize-y font-mono text-xs"
                    onChange={(event) => {
                      setSystemDraft((currentDraft) =>
                        currentDraft
                          ? {
                              ...currentDraft,
                              jinjaTemplateOverride: event.target.value,
                            }
                          : currentDraft,
                      );
                    }}
                    value={systemDraft?.jinjaTemplateOverride ?? ""}
                  />
                </Field>

                {templateError ? <p className="text-sm text-destructive">{templateError}</p> : null}
                {enabledTools.length > 0 && !toolTemplateSupported ? (
                  <p className="text-sm text-amber-700">
                    Enabled tools require a tool-capable Jinja template override before they can be
                    sent to the model.
                  </p>
                ) : null}

                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="Thinking start tag">
                    <Input
                      onChange={(event) => {
                        setSystemDraft((currentDraft) =>
                          currentDraft
                            ? {
                                ...currentDraft,
                                thinkingTags: {
                                  ...currentDraft.thinkingTags,
                                  startString: event.target.value,
                                },
                              }
                            : currentDraft,
                        );
                      }}
                      value={systemDraft?.thinkingTags.startString ?? ""}
                    />
                  </Field>
                  <Field label="Thinking end tag">
                    <Input
                      onChange={(event) => {
                        setSystemDraft((currentDraft) =>
                          currentDraft
                            ? {
                                ...currentDraft,
                                thinkingTags: {
                                  ...currentDraft.thinkingTags,
                                  endString: event.target.value,
                                },
                              }
                            : currentDraft,
                        );
                      }}
                      value={systemDraft?.thinkingTags.endString ?? ""}
                    />
                  </Field>
                </div>

                <div className="flex justify-end">
                  <Button
                    disabled={
                      !systemDraft ||
                      !!templateError ||
                      presetsSaving ||
                      systemDraft.name.trim().length === 0
                    }
                    onClick={() => {
                      if (!selectedSystemPreset || !systemDraft || templateError) {
                        return;
                      }

                      void onUpdateSystemPreset(selectedSystemPreset.id, {
                        ...(systemDraft.jinjaTemplateOverride?.trim()
                          ? { jinjaTemplateOverride: systemDraft.jinjaTemplateOverride }
                          : {}),
                        name: systemDraft.name,
                        systemPrompt: systemDraft.systemPrompt,
                        thinkingTags: systemDraft.thinkingTags,
                      });
                    }}
                    type="button">
                    {presetsSaving ? "Saving..." : "Save system preset"}
                  </Button>
                </div>
              </div>
            </section>

            <section className="min-w-0 space-y-4 rounded-[1.5rem] border border-border/70 bg-card/80 p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold">Load & inference presets</p>
                  <p className="text-sm text-muted-foreground">
                    Hardware, inference, and structured-output settings.
                  </p>
                </div>
                <Button
                  disabled={!loadDraft || presetsSaving}
                  onClick={() => {
                    if (!loadDraft) {
                      return;
                    }

                    void onCreateLoadPreset({
                      name: `${loadDraft.name} copy`,
                      settings: loadDraft.settings,
                    });
                  }}
                  type="button"
                  variant="outline">
                  Duplicate
                </Button>
              </div>

              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
                <select
                  className="h-10 rounded-xl border border-border/80 bg-background px-3 text-sm"
                  onChange={(event) => {
                    onSelectLoadPreset(event.target.value);
                  }}
                  value={selectedLoadPreset?.id ?? ""}>
                  {loadPresets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name}
                      {preset.isDefault ? " (default)" : ""}
                    </option>
                  ))}
                </select>
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={!selectedLoadPreset || selectedLoadPreset.isDefault || presetsSaving}
                    onClick={() => {
                      if (selectedLoadPreset) {
                        void onSetDefaultLoadPreset(selectedLoadPreset.id);
                      }
                    }}
                    type="button"
                    variant="outline">
                    Make default
                  </Button>
                  <Button
                    disabled={loadPresets.length <= 1 || !selectedLoadPreset || presetsSaving}
                    onClick={() => {
                      if (selectedLoadPreset) {
                        void onDeleteLoadPreset(selectedLoadPreset.id);
                      }
                    }}
                    type="button"
                    variant="outline">
                    Delete
                  </Button>
                </div>
              </div>

              <div className="space-y-4">
                <Field label="Preset name">
                  <Input
                    onChange={(event) => {
                      setLoadDraft((currentDraft) =>
                        currentDraft
                          ? {
                              ...currentDraft,
                              name: event.target.value,
                            }
                          : currentDraft,
                      );
                    }}
                    value={loadDraft?.name ?? ""}
                  />
                </Field>

                {loadDraft ? (
                  <HardwareOptimizer
                    currentContextLength={loadDraft.settings.contextLength}
                    disabled={presetsSaving}
                    model={model}
                    onApply={(recommendation) => {
                      applyOptimizerRecommendation(setLoadDraft, recommendation);
                    }}
                  />
                ) : null}

                <div className="grid gap-3 md:grid-cols-2">
                  <NumberField
                    label={`Context length${model.contextLength ? ` (model: ${model.contextLength.toLocaleString()})` : ""}`}
                    max={LOAD_INFERENCE_LIMITS.contextLength.max}
                    min={LOAD_INFERENCE_LIMITS.contextLength.min}
                    onChange={(nextValue) => {
                      setRequiredNumber(loadDraft, setLoadDraft, "contextLength", nextValue);
                    }}
                    value={loadDraft?.settings.contextLength}
                  />
                  <NumberField
                    label="GPU layers"
                    max={LOAD_INFERENCE_LIMITS.gpuLayers.max}
                    min={LOAD_INFERENCE_LIMITS.gpuLayers.min}
                    onChange={(nextValue) => {
                      setRequiredNumber(loadDraft, setLoadDraft, "gpuLayers", nextValue);
                    }}
                    value={loadDraft?.settings.gpuLayers}
                  />
                  <NumberField
                    label="CPU threads"
                    max={LOAD_INFERENCE_LIMITS.cpuThreads.max}
                    min={LOAD_INFERENCE_LIMITS.cpuThreads.min}
                    onChange={(nextValue) => {
                      setRequiredNumber(loadDraft, setLoadDraft, "cpuThreads", nextValue);
                    }}
                    value={loadDraft?.settings.cpuThreads}
                  />
                  <NumberField
                    label="Batch size"
                    max={LOAD_INFERENCE_LIMITS.batchSize.max}
                    min={LOAD_INFERENCE_LIMITS.batchSize.min}
                    onChange={(nextValue) => {
                      setRequiredNumber(loadDraft, setLoadDraft, "batchSize", nextValue);
                    }}
                    value={loadDraft?.settings.batchSize}
                  />
                  <NumberField
                    label="Micro-batch size"
                    max={LOAD_INFERENCE_LIMITS.ubatchSize.max}
                    min={LOAD_INFERENCE_LIMITS.ubatchSize.min}
                    onChange={(nextValue) => {
                      setRequiredNumber(loadDraft, setLoadDraft, "ubatchSize", nextValue);
                    }}
                    value={loadDraft?.settings.ubatchSize}
                  />
                  <NumberField
                    label="Seed"
                    onChange={(nextValue) => {
                      setRequiredNumber(loadDraft, setLoadDraft, "seed", nextValue);
                    }}
                    value={loadDraft?.settings.seed}
                  />
                </div>

                <Separator />

                <div className="grid gap-3 md:grid-cols-2">
                  <ToggleField
                    checked={loadDraft?.settings.unifiedKvCache ?? false}
                    label="Unified KV cache"
                    onCheckedChange={(checked) => {
                      setBooleanSetting(loadDraft, setLoadDraft, "unifiedKvCache", checked);
                    }}
                  />
                  <ToggleField
                    checked={loadDraft?.settings.offloadKvCache ?? false}
                    label="Offload KV cache"
                    onCheckedChange={(checked) => {
                      setBooleanSetting(loadDraft, setLoadDraft, "offloadKvCache", checked);
                    }}
                  />
                  <ToggleField
                    checked={loadDraft?.settings.useMmap ?? false}
                    label="Try mmap()"
                    onCheckedChange={(checked) => {
                      setBooleanSetting(loadDraft, setLoadDraft, "useMmap", checked);
                    }}
                  />
                  <ToggleField
                    checked={loadDraft?.settings.keepModelInMemory ?? false}
                    label="Keep model in memory"
                    onCheckedChange={(checked) => {
                      setBooleanSetting(loadDraft, setLoadDraft, "keepModelInMemory", checked);
                    }}
                  />
                  <ToggleField
                    checked={loadDraft?.settings.flashAttention ?? false}
                    label="Flash attention"
                    onCheckedChange={(checked) => {
                      setBooleanSetting(loadDraft, setLoadDraft, "flashAttention", checked);
                    }}
                  />
                  <ToggleField
                    checked={loadDraft?.settings.fullSwaCache ?? false}
                    label="Full SWA cache"
                    onCheckedChange={(checked) => {
                      setBooleanSetting(loadDraft, setLoadDraft, "fullSwaCache", checked);
                    }}
                  />
                  <ToggleField
                    checked={loadDraft?.settings.contextShift ?? false}
                    label="Context shift"
                    onCheckedChange={(checked) => {
                      setBooleanSetting(loadDraft, setLoadDraft, "contextShift", checked);
                    }}
                  />
                  <ToggleField
                    checked={loadDraft?.settings.thinkingEnabled ?? false}
                    label="Thinking enabled"
                    onCheckedChange={(checked) => {
                      setBooleanSetting(loadDraft, setLoadDraft, "thinkingEnabled", checked);
                    }}
                  />
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <SelectField<KvCacheType | "">
                    label="K cache quantization"
                    onChange={(nextValue) => {
                      setOptionalSetting(
                        loadDraft,
                        setLoadDraft,
                        "kvCacheTypeK",
                        nextValue || undefined,
                      );
                    }}
                    options={KV_CACHE_OPTIONS.map((option) => ({ label: option, value: option }))}
                    value={loadDraft?.settings.kvCacheTypeK ?? ""}
                  />
                  <SelectField<KvCacheType | "">
                    label="V cache quantization"
                    onChange={(nextValue) => {
                      setOptionalSetting(
                        loadDraft,
                        setLoadDraft,
                        "kvCacheTypeV",
                        nextValue || undefined,
                      );
                    }}
                    options={KV_CACHE_OPTIONS.map((option) => ({ label: option, value: option }))}
                    value={loadDraft?.settings.kvCacheTypeV ?? ""}
                  />
                  <OptionalNumberField
                    label="RoPE frequency base"
                    min={0.000001}
                    onChange={(nextValue) => {
                      setOptionalSetting(loadDraft, setLoadDraft, "ropeFrequencyBase", nextValue);
                    }}
                    value={loadDraft?.settings.ropeFrequencyBase}
                  />
                  <OptionalNumberField
                    label="RoPE frequency scale"
                    min={0.000001}
                    onChange={(nextValue) => {
                      setOptionalSetting(loadDraft, setLoadDraft, "ropeFrequencyScale", nextValue);
                    }}
                    value={loadDraft?.settings.ropeFrequencyScale}
                  />
                  <OptionalNumberField
                    label="Image min tokens"
                    max={LOAD_INFERENCE_LIMITS.imageTokens.max}
                    min={LOAD_INFERENCE_LIMITS.imageTokens.min}
                    onChange={(nextValue) => {
                      setOptionalSetting(loadDraft, setLoadDraft, "imageMinTokens", nextValue);
                    }}
                    value={loadDraft?.settings.imageMinTokens}
                  />
                  <OptionalNumberField
                    label="Image max tokens"
                    max={LOAD_INFERENCE_LIMITS.imageTokens.max}
                    min={LOAD_INFERENCE_LIMITS.imageTokens.min}
                    onChange={(nextValue) => {
                      setOptionalSetting(loadDraft, setLoadDraft, "imageMaxTokens", nextValue);
                    }}
                    value={loadDraft?.settings.imageMaxTokens}
                  />
                </div>

                <Separator />

                <div className="grid gap-3 md:grid-cols-2">
                  <SelectField<ContextOverflowStrategy>
                    label="Context overflow strategy"
                    onChange={(nextValue) => {
                      setLoadDraft((currentDraft) =>
                        currentDraft
                          ? {
                              ...currentDraft,
                              settings: {
                                ...currentDraft.settings,
                                contextShift:
                                  nextValue === "rolling-window"
                                    ? true
                                    : currentDraft.settings.contextShift,
                                overflowStrategy: nextValue,
                              },
                            }
                          : currentDraft,
                      );
                    }}
                    options={OVERFLOW_OPTIONS}
                    value={loadDraft?.settings.overflowStrategy ?? "truncate-middle"}
                  />
                  <OptionalNumberField
                    label="Response length limit"
                    max={LOAD_INFERENCE_LIMITS.responseLengthLimit.max}
                    min={LOAD_INFERENCE_LIMITS.responseLengthLimit.min}
                    onChange={(nextValue) => {
                      setOptionalSetting(loadDraft, setLoadDraft, "responseLengthLimit", nextValue);
                    }}
                    value={loadDraft?.settings.responseLengthLimit}
                  />
                  <NumberField
                    label="Temperature"
                    max={LOAD_INFERENCE_LIMITS.temperature.max}
                    min={LOAD_INFERENCE_LIMITS.temperature.min}
                    onChange={(nextValue) => {
                      setRequiredNumber(loadDraft, setLoadDraft, "temperature", nextValue);
                    }}
                    step="0.01"
                    value={loadDraft?.settings.temperature}
                  />
                  <NumberField
                    label="Top-K"
                    max={LOAD_INFERENCE_LIMITS.topK.max}
                    min={LOAD_INFERENCE_LIMITS.topK.min}
                    onChange={(nextValue) => {
                      setRequiredNumber(loadDraft, setLoadDraft, "topK", nextValue);
                    }}
                    value={loadDraft?.settings.topK}
                  />
                  <NumberField
                    label="Top-P"
                    max={LOAD_INFERENCE_LIMITS.topP.max}
                    min={LOAD_INFERENCE_LIMITS.topP.min}
                    onChange={(nextValue) => {
                      setRequiredNumber(loadDraft, setLoadDraft, "topP", nextValue);
                    }}
                    step="0.01"
                    value={loadDraft?.settings.topP}
                  />
                  <NumberField
                    label="Min-P"
                    max={LOAD_INFERENCE_LIMITS.minP.max}
                    min={LOAD_INFERENCE_LIMITS.minP.min}
                    onChange={(nextValue) => {
                      setRequiredNumber(loadDraft, setLoadDraft, "minP", nextValue);
                    }}
                    step="0.01"
                    value={loadDraft?.settings.minP}
                  />
                  <NumberField
                    label="Presence penalty"
                    max={LOAD_INFERENCE_LIMITS.penalties.max}
                    min={LOAD_INFERENCE_LIMITS.penalties.min}
                    onChange={(nextValue) => {
                      setRequiredNumber(loadDraft, setLoadDraft, "presencePenalty", nextValue);
                    }}
                    step="0.01"
                    value={loadDraft?.settings.presencePenalty}
                  />
                  <NumberField
                    label="Repeat penalty"
                    max={LOAD_INFERENCE_LIMITS.repeatPenalty.max}
                    min={LOAD_INFERENCE_LIMITS.repeatPenalty.min}
                    onChange={(nextValue) => {
                      setRequiredNumber(loadDraft, setLoadDraft, "repeatPenalty", nextValue);
                    }}
                    step="0.01"
                    value={loadDraft?.settings.repeatPenalty}
                  />
                </div>

                <Field label="Stop strings (one per line)">
                  <Textarea
                    className="min-h-28 resize-y"
                    onChange={(event) => {
                      setLoadDraft((currentDraft) =>
                        currentDraft
                          ? {
                              ...currentDraft,
                              settings: {
                                ...currentDraft.settings,
                                stopStrings: event.target.value
                                  .split(/\r?\n/)
                                  .map((value) => value.trim())
                                  .filter((value) => value.length > 0),
                              },
                            }
                          : currentDraft,
                      );
                    }}
                    value={loadDraft?.settings.stopStrings.join("\n") ?? ""}
                  />
                </Field>

                <Separator />

                <div className="space-y-3 rounded-[1.25rem] border border-border/70 bg-background/70 p-4">
                  <p className="text-sm font-semibold">Structured output</p>
                  <SelectField<StructuredOutputMode>
                    label="Mode"
                    onChange={(nextValue) => {
                      setLoadDraft((currentDraft) =>
                        currentDraft
                          ? {
                              ...currentDraft,
                              settings: {
                                ...currentDraft.settings,
                                structuredOutputMode: nextValue,
                              },
                            }
                          : currentDraft,
                      );
                    }}
                    options={STRUCTURED_OUTPUT_OPTIONS}
                    value={loadDraft?.settings.structuredOutputMode ?? "off"}
                  />

                  {loadDraft?.settings.structuredOutputMode === "json_schema" ? (
                    <Field label="JSON schema">
                      <Textarea
                        className="min-h-44 resize-y font-mono text-xs"
                        onChange={(event) => {
                          setLoadDraft((currentDraft) =>
                            currentDraft
                              ? {
                                  ...currentDraft,
                                  settings: {
                                    ...currentDraft.settings,
                                    structuredOutputSchema: event.target.value,
                                  },
                                }
                              : currentDraft,
                          );
                        }}
                        value={loadDraft.settings.structuredOutputSchema ?? ""}
                      />
                    </Field>
                  ) : null}

                  {loadSettingsError &&
                  loadDraft?.settings.structuredOutputMode === "json_schema" ? (
                    <p className="text-sm text-destructive">{loadSettingsError}</p>
                  ) : null}
                </div>

                {loadSettingsError && loadDraft?.settings.structuredOutputMode !== "json_schema" ? (
                  <p className="text-sm text-destructive">{loadSettingsError}</p>
                ) : null}

                <div className="flex justify-end">
                  <Button
                    disabled={
                      !loadDraft ||
                      !!loadSettingsError ||
                      presetsSaving ||
                      loadDraft.name.trim().length === 0
                    }
                    onClick={() => {
                      if (!selectedLoadPreset || !loadDraft || loadSettingsError) {
                        return;
                      }

                      void onUpdateLoadPreset(selectedLoadPreset.id, {
                        name: loadDraft.name,
                        settings: loadDraft.settings,
                      });
                    }}
                    type="button">
                    {presetsSaving ? "Saving..." : "Save load preset"}
                  </Button>
                </div>
              </div>
            </section>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

/** Renders a labeled form field wrapper. */
function Field({ children, label }: { children: ReactElement; label: string }): ReactElement {
  return (
    <label className="grid gap-2 text-sm">
      <span className="font-medium text-foreground">{label}</span>
      {children}
    </label>
  );
}

/** Renders a labeled numeric input field. */
function NumberField({
  label,
  max,
  min,
  onChange,
  step,
  value,
}: {
  label: string;
  max?: number;
  min?: number;
  onChange: (nextValue: number) => void;
  step?: string;
  value: number | undefined;
}): ReactElement {
  return (
    <Field label={label}>
      <Input
        max={max}
        min={min}
        onChange={(event) => {
          onChange(Number(event.target.value));
        }}
        step={step}
        type="number"
        value={typeof value === "number" ? value : ""}
      />
    </Field>
  );
}

/** Renders an optional numeric input field that supports blank values. */
function OptionalNumberField({
  label,
  max,
  min,
  onChange,
  value,
}: {
  label: string;
  max?: number;
  min?: number;
  onChange: (nextValue: number | undefined) => void;
  value: number | undefined;
}): ReactElement {
  return (
    <Field label={label}>
      <Input
        max={max}
        min={min}
        onChange={(event) => {
          const nextValue = event.target.value.trim();

          onChange(nextValue.length === 0 ? undefined : Number(nextValue));
        }}
        type="number"
        value={typeof value === "number" ? value : ""}
      />
    </Field>
  );
}

/** Renders a labeled select dropdown field. */
function SelectField<TValue extends string>({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (nextValue: TValue) => void;
  options: Array<{ label: string; value: TValue }>;
  value: TValue;
}): ReactElement {
  return (
    <Field label={label}>
      <select
        className="h-10 rounded-xl border border-border/80 bg-background px-3 text-sm"
        onChange={(event) => {
          onChange(event.target.value as TValue);
        }}
        value={value}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** Renders a labeled toggle field with a switch control. */
function ToggleField({
  checked,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}): ReactElement {
  return (
    <div className="flex items-center justify-between rounded-xl border border-border/70 bg-background/70 px-3 py-2">
      <span className="text-sm font-medium text-foreground">{label}</span>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

/** Updates a boolean setting on the load-inference draft. */
function setBooleanSetting<TKey extends keyof LoadInferencePreset["settings"]>(
  loadDraft: LoadInferencePreset | null,
  setLoadDraft: (
    updater: (currentDraft: LoadInferencePreset | null) => LoadInferencePreset | null,
  ) => void,
  key: TKey,
  checked: boolean,
): void {
  if (!loadDraft) {
    return;
  }

  setLoadDraft((currentDraft) =>
    currentDraft
      ? {
          ...currentDraft,
          settings: {
            ...currentDraft.settings,
            [key]: checked,
          },
        }
      : currentDraft,
  );
}

/** Updates a required numeric setting on the load-inference draft. */
function setRequiredNumber<TKey extends keyof LoadInferencePreset["settings"]>(
  loadDraft: LoadInferencePreset | null,
  setLoadDraft: (
    updater: (currentDraft: LoadInferencePreset | null) => LoadInferencePreset | null,
  ) => void,
  key: TKey,
  nextValue: number,
): void {
  if (!loadDraft || !Number.isFinite(nextValue)) {
    return;
  }

  setLoadDraft((currentDraft) =>
    currentDraft
      ? {
          ...currentDraft,
          settings: {
            ...currentDraft.settings,
            [key]: nextValue,
          },
        }
      : currentDraft,
  );
}

/** Updates an optional setting on the load-inference draft. */
function setOptionalSetting<TKey extends keyof LoadInferencePreset["settings"]>(
  loadDraft: LoadInferencePreset | null,
  setLoadDraft: (
    updater: (currentDraft: LoadInferencePreset | null) => LoadInferencePreset | null,
  ) => void,
  key: TKey,
  nextValue: LoadInferencePreset["settings"][TKey],
): void {
  if (!loadDraft) {
    return;
  }

  setLoadDraft((currentDraft) =>
    currentDraft
      ? {
          ...currentDraft,
          settings: {
            ...currentDraft.settings,
            [key]: nextValue,
          },
        }
      : currentDraft,
  );
}

/** Applies a hardware-optimizer recommendation to the load-inference draft. */
function applyOptimizerRecommendation(
  setLoadDraft: (
    updater: (currentDraft: LoadInferencePreset | null) => LoadInferencePreset | null,
  ) => void,
  recommendation: HardwareOptimizerRecommendation,
): void {
  setLoadDraft((currentDraft) =>
    currentDraft
      ? {
          ...currentDraft,
          settings: {
            ...currentDraft.settings,
            contextLength: recommendation.recommendedContextLength,
            cpuThreads: recommendation.recommendedCpuThreads,
            gpuLayers: recommendation.recommendedGpuLayers,
          },
        }
      : currentDraft,
  );
}
