// Type surface of config-file-lock.mjs for the server's TypeScript.  The
// implementation stays plain JavaScript so the packaged Electron process
// can load it without a build step; keep this file in step with it.

export const CONFIG_LOCK_STALE_MS: number;
export const CONFIG_LOCK_TIMEOUT_MS: number;

export interface ConfigLockOptions {
  /** Reclaim a lock older than this many milliseconds even if its pid is alive. */
  staleMs?: number;
  /** Give up (throw) after waiting this many milliseconds for the lock. */
  timeoutMs?: number;
}

export interface UpdateConfigFileOptions extends ConfigLockOptions {
  /** Mode for the written file (default 0o600). */
  mode?: number;
}

export type ConfigFileObject = Record<string, unknown>;

export interface ConfigFileLock {
  /** Release the lock; a no-op if a peer has since reclaimed it. */
  release(): void;
  /** Throw unless this handle still owns the lock and its lease has not expired. */
  assertHeld(): void;
}

export function lockPathFor(configPath: string): string;
export function acquireConfigFileLock(configPath: string, options?: ConfigLockOptions): ConfigFileLock;
export function withConfigFileLock<T>(configPath: string, fn: (lock: ConfigFileLock) => T, options?: ConfigLockOptions): T;
export function readConfigFile(configPath: string): ConfigFileObject;
export function writeFileAtomic(path: string, data: string, options?: { mode?: number }): void;
export function updateConfigFile(
  configPath: string,
  mutate: (disk: ConfigFileObject) => ConfigFileObject | null | undefined,
  options?: UpdateConfigFileOptions,
): ConfigFileObject;
