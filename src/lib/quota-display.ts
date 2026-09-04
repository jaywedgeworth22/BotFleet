/** Settings → Usage quota row: full per-model / per-window lines for hover and click. */

export type QuotaDisplayModel = {
  label: string;
  modelId: string;
  remainingPercentage?: number;
  isExhausted: boolean;
  isAutocompleteOnly?: boolean;
};

export type QuotaDisplayLine = {
  label: string;
  value: string;
  exhausted: boolean;
  group: "gemini" | "external" | "window";
};

export function isGeminiQuotaModel(model: Pick<QuotaDisplayModel, "label" | "modelId">): boolean {
  return /gemini/i.test(`${model.label} ${model.modelId}`);
}

export function isQuotaModelExhausted(model: QuotaDisplayModel): boolean {
  if (model.isAutocompleteOnly) return false;
  if (model.isExhausted) return true;
  if (typeof model.remainingPercentage !== "number") return true;
  return model.remainingPercentage <= 0;
}

export function remainingPercentLabel(model: QuotaDisplayModel): string {
  if (isQuotaModelExhausted(model)) return "exhausted";
  return `${Math.round((model.remainingPercentage ?? 0) * 100)}%`;
}

export function antigravityQuotaLines(models: QuotaDisplayModel[]): QuotaDisplayLine[] {
  const lines = models
    .filter((model) => !model.isAutocompleteOnly)
    .map((model) => {
      const exhausted = isQuotaModelExhausted(model);
      return {
        label: model.label,
        value: remainingPercentLabel(model),
        exhausted,
        group: isGeminiQuotaModel(model) ? "gemini" : "external",
      } as const;
    });
  return lines.sort((a, b) => {
    if (a.group !== b.group) return a.group === "gemini" ? -1 : 1;
    if (a.exhausted !== b.exhausted) return a.exhausted ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
}

export function quotaLinesSummary(lines: QuotaDisplayLine[]): string {
  return lines.map((line) => `${line.label}: ${line.value}`).join(" · ");
}

export type QuotaWindowDisplay = {
  label: string;
  window?: string | null;
  remainingPercent?: number | null;
  skip: boolean;
};

export function usageWindowLines(windows: QuotaWindowDisplay[]): QuotaDisplayLine[] {
  return windows.map((window) => ({
    label: window.window ? `${window.label} (${window.window})` : window.label,
    value: window.remainingPercent == null ? "not reported" : `${window.remainingPercent}%`,
    exhausted: window.skip,
    group: "window" as const,
  }));
}
