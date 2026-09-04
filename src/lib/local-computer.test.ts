import { describe, expect, it } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import {
  autoSelectsLocalComputer,
  computerDestinationDisabledReason,
  instanceSupportsCloudComputer,
  instanceSupportsLocalVm,
  instanceSupportsLocalComputer,
  linuxAutoDescription,
  localComputerDisabledReason,
  localComputerSelectable,
} from "./local-computer";

describe("local computer UI eligibility", () => {
  it("requires the selected instance to advertise approval-capable local MCP", () => {
    const bot = {
      modelSelection: { instanceId: "claude", model: "test" },
    } satisfies Pick<Bot, "modelSelection">;
    const instances = [
      {
        instanceId: "claude",
        capabilities: { localComputerMcp: true },
      },
    ] satisfies Array<Pick<InstanceInfo, "instanceId" | "capabilities">>;
    expect(instanceSupportsLocalComputer(instances as InstanceInfo[], bot)).toBe(true);
    expect(
      instanceSupportsLocalComputer(
        [{ ...instances[0], capabilities: {} }] as InstanceInfo[],
        bot,
      ),
    ).toBe(false);
    expect(
      instanceSupportsLocalComputer(
        [{ ...instances[0], capabilities: { computerMcp: true } }] as InstanceInfo[],
        bot,
      ),
    ).toBe(true);
  });

  it("keeps This computer selectable on macOS before CUA is granted", () => {
    const capabilities = {
      host: { platform: "darwin" as const },
      localComputer: { available: false },
    } as DesktopCapabilities;
    expect(localComputerSelectable({ capabilities, providerSupportsLocal: true })).toBe(true);
    expect(localComputerSelectable({ capabilities, providerSupportsLocal: false })).toBe(false);
    expect(
      localComputerSelectable({
        capabilities: {
          host: { platform: "linux" as const },
          localComputer: { available: false },
        } as DesktopCapabilities,
        providerSupportsLocal: true,
      }),
    ).toBe(false);
  });

  it("states that Linux Auto never selects this computer", () => {
    expect(linuxAutoDescription()).toContain("otherwise computer use stays off");
    expect(
      autoSelectsLocalComputer({
        platform: "linux",
        computers: undefined,
        capabilitiesReady: true,
        localSelectable: true,
      }),
    ).toBe(false);
  });

  it("explains the Wayland seat-safety block and names the supported session", () => {
    const capabilities = {
      host: { platform: "linux" as const },
      localComputer: {
        available: false,
        enabled: false,
        reasonCode: "linux-wayland-seat-safety-blocked",
      },
    } as DesktopCapabilities;

    expect(
      localComputerDisabledReason({ capabilities, providerSupportsLocal: true }),
    ).toBe(
      "Local computer control is not available on Wayland yet. Sign out and choose Ubuntu on Xorg to use This computer.",
    );
  });

  it("preserves the ready local fallback on supported non-Linux hosts", () => {
    expect(
      autoSelectsLocalComputer({
        platform: "darwin",
        computers: undefined,
        capabilitiesReady: true,
        localSelectable: true,
      }),
    ).toBe(true);
    expect(
      autoSelectsLocalComputer({
        platform: "darwin",
        computers: ["cloud"],
        capabilitiesReady: true,
        localSelectable: true,
      }),
    ).toBe(false);
  });
});

describe("computer destination eligibility", () => {
  const bot = { modelSelection: { instanceId: "engine", model: "m" } } satisfies Pick<Bot, "modelSelection">;
  // SAFETY: the eligibility helpers read only these four fields, so a
  // partial instance is the whole contract they exercise.
  const engine = (
    capabilities: Partial<InstanceInfo["capabilities"]>,
    driverKind = "claudeAgent",
    displayName = "Claude",
  ): InstanceInfo[] =>
    [{ instanceId: "engine", driverKind, displayName, capabilities }] as InstanceInfo[];

  it("offers a Local VM only to an engine that can mount one", () => {
    // the real cost of not checking: 51 turns died on "this model engine
    // cannot use the Local VM" after the picker had offered it
    expect(instanceSupportsLocalVm(engine({ computerMcp: true }), bot)).toBe(true);
    expect(instanceSupportsLocalVm(engine({}), bot)).toBe(false);
    expect(instanceSupportsLocalVm(engine({ localComputerMcp: true }), bot)).toBe(false);
  });

  it("does not offer a Local VM to the Computer engine, which runs on the box itself", () => {
    expect(instanceSupportsLocalVm(engine({ computerMcp: true }, "boxAgent", "Computer"), bot)).toBe(false);
  });

  it("offers a remote desktop to the Computer engine and to anything with the computer surface", () => {
    expect(instanceSupportsCloudComputer(engine({}, "boxAgent", "Computer"), bot)).toBe(true);
    expect(instanceSupportsCloudComputer(engine({ computerMcp: true }), bot)).toBe(true);
    expect(instanceSupportsCloudComputer(engine({}), bot)).toBe(false);
  });

  it("lets the server have the last word on an engine the client does not know", () => {
    expect(instanceSupportsLocalVm([], bot)).toBe(true);
    expect(instanceSupportsCloudComputer([], bot)).toBe(true);
  });

  it("names the engine in the reason, so the fix is obvious from the tooltip", () => {
    const reason = computerDestinationDisabledReason("vm", engine({}, "grokAgent", "Grok"), bot);
    expect(reason).toContain("Grok");
    expect(reason).toContain("Local VM");
    expect(computerDestinationDisabledReason("vm", engine({ computerMcp: true }), bot)).toBeNull();
  });
});
