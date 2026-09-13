// Provider instance registry — port of upstream's ProviderInstanceRegistryLive
// behavior, minus Effect: config map → live instances; unknown driver or
// config-decode failure becomes an UNAVAILABLE SHADOW SNAPSHOT instead of a
// startup failure (that behavior is what makes settings forward/backward
// compatible — do not remove it); dispose tears an instance down without
// touching its siblings.
import { lastAntigravityQuotaSnapshot, quotaModelsFromSnapshot } from "../antigravity-quota.ts";
import { findCliCandidates } from "../env-path.ts";
import { quotaCooldowns } from "../model-fallback.ts";
import type {
  AnyProviderDriver,
  InstanceConfig,
  InstanceConfigMap,
  InstanceId,
  ProviderInstance,
  ProviderSnapshot,
} from "../contracts.ts";

export interface ShadowInstance {
  instanceId: InstanceId;
  driverKind: string;
  displayName: string | undefined;
  /** Raw `config.cli` from disk — an override exists only if this is set. */
  cli: string | undefined;
  shadow: true;
  reason: string;
}

export type RegistryEntry =
  | { instanceId: InstanceId; live: ProviderInstance; shadow?: undefined }
  | { instanceId: InstanceId; live?: undefined; shadow: ShadowInstance };

/** The `cli` field off a driver's default config, when it has one — the
 * placeholder an override input shows when nothing is set. */
function cliDefaultOf(driver: AnyProviderDriver | undefined): string | undefined {
  if (!driver) return undefined;
  try {
    const cfg = driver.defaultConfig() as { cli?: unknown };
    return typeof cfg?.cli === "string" ? cfg.cli : undefined;
  } catch {
    return undefined;
  }
}

/** Raw `config.cli` straight from disk — shadow snapshots can't decode, so
 * this is the only faithful way to echo back what was configured. */
function cliOfRaw(raw: unknown): string | undefined {
  const cli = (raw as { cli?: unknown } | undefined)?.cli;
  return typeof cli === "string" && cli ? cli : undefined;
}

function fullAutoOfRaw(raw: unknown): boolean {
  return (raw as { fullAuto?: unknown } | undefined)?.fullAuto === true;
}

export interface DescribedInstance {
  instanceId: InstanceId;
  driverKind: string;
  displayName: string;
  enabled?: boolean;
  snapshot: ProviderSnapshot;
  models: { default: string; options: Array<{ id: string; name?: string; contextWindow?: number }> };
  capabilities: {
    computerMcp: boolean;
    agentsMcp: boolean;
    localComputerMcp: boolean;
    composioMcp?: boolean;
    phoneMcp?: boolean;
    images?: boolean;
    effortLevels?: readonly string[];
    queueing?: boolean;
    approvalReview?: boolean;
  };
  access: string;
  install: unknown;
  cli: string | undefined;
  cliDefault: string | undefined;
  cliCandidates: string[];
  fullAuto: boolean;
  iconUrl?: string;
  isCustom?: boolean;
}

export class ProviderRegistry {
  private byId = new Map<InstanceId, RegistryEntry>();
  /** decoded per-instance `cli` overrides, for describe() — drivers spawn
   * from their own config; this map only reports what was configured */
  private cliByInstance = new Map<InstanceId, string>();
  private fullAutoByInstance = new Map<InstanceId, boolean>();
  private enabledByInstance = new Map<InstanceId, boolean>();
  private driversByKind: Map<string, AnyProviderDriver>;

  constructor(drivers: readonly AnyProviderDriver[]) {
    this.driversByKind = new Map(drivers.map((d) => [d.driverKind, d]));
  }

  private async loadEntry(instanceId: InstanceId, entry: InstanceConfig): Promise<ProviderInstance | null> {
    const isFullAuto = fullAutoOfRaw(entry.config);
    if (isFullAuto) this.fullAutoByInstance.set(instanceId, true);
    else this.fullAutoByInstance.delete(instanceId);

    const driver = this.driversByKind.get(entry.driver);
    if (!driver) {
      this.byId.set(instanceId, {
        instanceId,
        shadow: {
          instanceId,
          driverKind: entry.driver,
          displayName: entry.displayName,
          cli: cliOfRaw(entry.config),
          shadow: true,
          reason: `unknown driver "${entry.driver}" — kept as configured, unavailable here`,
        },
      });
      return null;
    }
    try {
      const config = entry.config === undefined ? driver.defaultConfig() : driver.decodeConfig(entry.config);
      // Override detection is on the RAW config, never the decoded one:
      // decodeConfig fills in the driver default ("claude", "codex", …),
      // so reading `cli` there would flag every instance as overridden.
      const rawCli = cliOfRaw(entry.config);
      if (rawCli) this.cliByInstance.set(instanceId, rawCli);
      else this.cliByInstance.delete(instanceId);
      const enabled = entry.enabled !== false;
      this.enabledByInstance.set(instanceId, enabled);
      const live = await driver.create({
        instanceId,
        displayName: entry.displayName ?? driver.metadata.displayName,
        environment: entry.environment ?? {},
        enabled,
        config,
      });
      this.byId.set(instanceId, { instanceId, live });
      return live;
    } catch (e) {
      this.byId.set(instanceId, {
        instanceId,
        shadow: {
          instanceId,
          driverKind: entry.driver,
          displayName: entry.displayName ?? driver.metadata.displayName,
          cli: cliOfRaw(entry.config),
          shadow: true,
          reason: e instanceof Error ? e.message : String(e),
        },
      });
      return null;
    }
  }

  async load(configs: InstanceConfigMap) {
    this.lastDescribe = null;
    for (const [instanceId, entry] of Object.entries(configs)) {
      await this.loadEntry(instanceId, entry);
    }
  }

  /** Reload a single instance after an override/setting change without tearing
   * down the whole fleet. */
  async reloadInstance(instanceId: InstanceId, entry: InstanceConfig): Promise<ProviderInstance | null> {
    const existing = this.byId.get(instanceId);
    if (existing?.live) {
      await existing.live.dispose().catch(() => {});
    }
    return this.loadEntry(instanceId, entry);
  }

  /** Drop a single instance (deleted custom engine) without tearing down the
   * whole fleet. Mirrors reloadInstance's dispose-then-forget half, minus the
   * reload: deleting one unused custom engine must not settle every OTHER
   * bot's in-flight turn as interrupted, which a global reloadProviders()
   * would do by disposing the entire registry. */
  async removeInstance(instanceId: InstanceId): Promise<void> {
    const existing = this.byId.get(instanceId);
    if (existing?.live) {
      await existing.live.dispose().catch(() => {});
    }
    this.byId.delete(instanceId);
    this.cliByInstance.delete(instanceId);
    this.fullAutoByInstance.delete(instanceId);
    this.enabledByInstance.delete(instanceId);
    this.lastDescribe = null;
  }

  get(instanceId: InstanceId): ProviderInstance | null {
    return this.byId.get(instanceId)?.live ?? null;
  }

  entries(): RegistryEntry[] {
    return [...this.byId.values()];
  }

  instances(): ProviderInstance[] {
    return [...this.byId.values()].flatMap((e) => (e.live ? [e.live] : []));
  }

  /** instance snapshots for the model picker: id, driver, models, health */
  /** The last full describe(), shared with callers that accept a slightly
   * stale view. Probing every engine CLI (`--version`, auth status, model
   * discovery) costs seconds on a machine with many CLIs installed, and a
   * bot being created does not need a fresher answer than the rail did a
   * moment ago. In-flight describes are shared too, so a burst of callers
   * spawns one probe per engine, not one per caller. */
  private lastDescribe: { at: number; result: Promise<DescribedInstance[]> } | null = null;

  async describe(opts?: { maxAgeMs?: number; staleWhileRevalidate?: boolean }) {
    const maxAge = opts?.maxAgeMs ?? 0;
    const now = Date.now();
    const memo = this.lastDescribe;
    if (maxAge > 0 && memo && now - memo.at <= maxAge) return memo.result;

    // A caller that can live with a slightly old answer gets the previous one
    // immediately while a new probe runs behind it.  Probing every engine CLI
    // takes tens of seconds on a machine with many installed, which is longer
    // than the phone waits before giving up — so making every caller block on
    // it is what makes the model picker look empty rather than slow.
    if (opts?.staleWhileRevalidate && memo) {
      void this.refreshDescribe(now);
      return memo.result;
    }

    return this.refreshDescribe(now);
  }

  private refreshDescribe(at: number) {
    const result = this.describeFresh();
    this.lastDescribe = { at, result };
    // a failed probe must not be served from the memo
    result.catch(() => {
      if (this.lastDescribe?.result === result) this.lastDescribe = null;
    });
    return result;
  }

  async describeFresh(): Promise<DescribedInstance[]> {
    // Multiple instances may share a driver. Scan each default binary once
    // per response instead of repeating filesystem work for every row.
    const candidatesByName = new Map<string, string[]>();
    return Promise.all(
      this.entries().map((entry) => this.describeEntry(entry, candidatesByName)),
    );
  }

  private async describeEntry(
    entry: RegistryEntry,
    candidatesByName: Map<string, string[]>,
  ): Promise<DescribedInstance> {
    const driver = this.driversByKind.get(entry.shadow?.driverKind ?? entry.live!.driverKind);
    const candidatesFor = (d: AnyProviderDriver | undefined): string[] => {
      const name = cliDefaultOf(d);
      if (!name) return [];
      const cached = candidatesByName.get(name);
      if (cached) return cached;
      const found = findCliCandidates(name);
      candidatesByName.set(name, found);
      return found;
    };
    if (entry.shadow) {
      return {
        instanceId: entry.instanceId,
        driverKind: entry.shadow.driverKind,
        displayName: entry.shadow.displayName ?? entry.shadow.driverKind,
        snapshot: { state: "unavailable", reason: entry.shadow.reason } satisfies ProviderSnapshot,
        models: { default: "", options: [] },
        capabilities: { computerMcp: false, agentsMcp: false, localComputerMcp: false },
        // an unknown driver has no driver record, hence no install path
        access: driver?.metadata.access ?? "subscription",
        install: driver?.install,
        cli: entry.shadow.cli,
        cliDefault: cliDefaultOf(driver),
        // a shadow is exactly the "your CLI is broken, pick another"
        // case where the detected-path dropdown matters most
        cliCandidates: candidatesFor(driver),
        fullAuto: this.fullAutoByInstance.get(entry.instanceId) ?? false,
        iconUrl: undefined,
        isCustom: entry.shadow.driverKind === "openai-compat" && entry.instanceId !== "openaiCompat",
      };
    }
    const inst = entry.live!;
    const enabled = this.enabledByInstance.get(entry.instanceId) ?? true;
    let snapshot: ProviderSnapshot;
    if (!enabled || inst.enabled === false) {
      snapshot = { state: "unavailable", reason: "Disabled in settings" };
    } else {
      try {
        await inst.refreshModels?.();
        snapshot = await inst.snapshot();
        const wildcard = quotaCooldowns.get("*", inst.instanceId, "*")
          ?? quotaCooldowns.list().find((cd) => cd.instanceId === inst.instanceId && cd.model === "*");
        const perModel = quotaCooldowns.list().filter(
          (cd) => cd.instanceId === inst.instanceId && cd.model !== "*",
        );
        const models: NonNullable<ProviderSnapshot["quota"]>["models"] = {};
        for (const cd of perModel) {
          models[cd.model] = {
            capped: true,
            remainingPercent: null,
            resetsAt: cd.resetsAt,
            error: cd.error,
          };
        }
        let windowsLabel: string | undefined;
        if (inst.instanceId === "antigravity") {
          const agModels = quotaModelsFromSnapshot(lastAntigravityQuotaSnapshot());
          Object.assign(models, agModels);
          const dual = Object.values(agModels).find((m) => m.windowsLabel?.includes("/"));
          windowsLabel = dual?.windowsLabel ?? Object.values(agModels)[0]?.windowsLabel;
        }
        const catalogIds = inst.models?.options?.map((option) => option.id) ?? [];
        const allCatalogCapped =
          catalogIds.length > 0 && catalogIds.every((id) => models[id]?.capped === true);
        if (wildcard || Object.keys(models).length > 0 || windowsLabel) {
          snapshot.quota = {
            capped: Boolean(wildcard) || allCatalogCapped,
            resetsAt: wildcard?.resetsAt,
            error: wildcard?.error,
            ...(windowsLabel ? { windowsLabel } : {}),
            ...(Object.keys(models).length > 0 ? { models } : {}),
          };
        }
      } catch (e) {
        snapshot = { state: "unavailable", reason: e instanceof Error ? e.message : String(e) };
      }
    }
    return {
      instanceId: inst.instanceId,
      driverKind: inst.driverKind,
      displayName: inst.displayName ?? inst.driverKind,
      enabled,
      snapshot,
      models: inst.models,
      capabilities: {
        computerMcp: inst.adapter.capabilities.computerMcp === true,
        agentsMcp: inst.adapter.capabilities.agentsMcp === true,
        composioMcp: inst.adapter.capabilities.composioMcp === true,
        phoneMcp: inst.adapter.capabilities.phoneMcp === true,
        images: inst.adapter.capabilities.images === true,
        effortLevels: inst.adapter.capabilities.effortLevels,
        queueing: inst.adapter.capabilities.queueing === true,
        localComputerMcp: inst.adapter.capabilities.localComputerMcp === true,
        approvalReview: inst.reviewPermission !== undefined,
      },
      access: driver?.metadata.access ?? "subscription",
      install: driver?.install,
      cli: this.cliByInstance.get(inst.instanceId),
      cliDefault: cliDefaultOf(driver),
      // every copy of the driver's default binary on the augmented PATH —
      // the dropdown's "detected" entries. Snapshotted per describe() so a
      // newly installed CLI shows up on the next refresh.
      cliCandidates: candidatesFor(driver),
      fullAuto: this.fullAutoByInstance.get(inst.instanceId) ?? false,
      iconUrl: inst.iconUrl,
      isCustom: inst.driverKind === "openai-compat" && inst.instanceId !== "openaiCompat",
    };
  }

  /** Probes ONLY the modified instance and updates the cached describe
   * snapshot in place, avoiding cold sweeps across all unrelated engines. */
  async describeWithFreshInstance(instanceId: InstanceId): Promise<DescribedInstance[]> {
    const entry = this.byId.get(instanceId);
    if (!entry) return this.describe();

    const candidatesByName = new Map<string, string[]>();
    const freshInfo = await this.describeEntry(entry, candidatesByName);

    if (this.lastDescribe) {
      try {
        while (this.lastDescribe) {
          const current: { at: number; result: Promise<DescribedInstance[]> } = this.lastDescribe;
          const list: DescribedInstance[] = await current.result;
          if (this.lastDescribe !== current) {
            // A concurrent describe completed in the meantime; re-merge into the fresher snapshot
            continue;
          }
          const index = list.findIndex((item) => item.instanceId === instanceId);
          const nextList = [...list];
          if (index >= 0) {
            nextList[index] = freshInfo;
          } else {
            nextList.push(freshInfo);
          }
          this.lastDescribe = { at: Date.now(), result: Promise.resolve(nextList) };
          return nextList;
        }
      } catch {
        // Fall back to full describe if cached promise errored
      }
    }

    return this.refreshDescribe(Date.now());
  }

  async disposeAll() {
    await Promise.allSettled(this.instances().map((i) => i.dispose()));
    this.byId.clear();
    this.cliByInstance.clear();
    this.fullAutoByInstance.clear();
    this.enabledByInstance.clear();
  }
}
