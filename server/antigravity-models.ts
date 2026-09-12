import type { ModelCatalog } from "./contracts.ts";

// model catalog from `agy models` (agy 1.1.23)
export const STATIC_ANTIGRAVITY_MODELS: ModelCatalog = {
  default: "gemini-3.8-flash-high",
  options: [
    { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
    { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
    { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
    { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" },
    { id: "gemini-3.7-flash-medium", label: "Gemini 3.7 Flash (Medium)" },
    { id: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash (Low)" },
    { id: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (High)" },
    { id: "gemini-3.6-flash-medium", label: "Gemini 3.6 Flash (Medium)" },
    { id: "gemini-3.6-flash-low", label: "Gemini 3.6 Flash (Low)" },
    { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" },
    { id: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low)" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
    { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
    { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
  ],
};


/** Match reported names to catalog identities; opaque upstream IDs are not routes. */
export function antigravityQuotaCatalogId(model: { modelId: string; label: string }): string | undefined {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const id = normalize(model.modelId);
  const label = normalize(model.label);
  return STATIC_ANTIGRAVITY_MODELS.options.find((option) =>
    normalize(option.id) === id || normalize(option.label) === label || normalize(option.id) === label
  )?.id;
}
