export interface FeatureFlagConfig {
  features?: { skillRecorder?: boolean; showToolCalls?: boolean; summarizeToolCalls?: boolean };
}

/** Experimental features are available only after an explicit opt-in. */
export function skillRecorderEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.skillRecorder === true;
}

/** Tool-run chips in the transcript. Off by default — the mascot already
 * shows that work is happening. */
export function showToolCallsEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.showToolCalls === true;
}

/** Summarize consecutive tool actions into an expandable live summary progress card.
 * On by default when tool calls are shown. Set to false to show detailed stream. */
export function summarizeToolCallsEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.summarizeToolCalls !== false;
}
