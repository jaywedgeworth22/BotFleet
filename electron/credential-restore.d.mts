export function planCredentialRestore(values: unknown, config: object): {
  env: Record<string, string>;
  restored: string[];
  retained: string[];
};
