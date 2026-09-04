import type { Bot, InstanceInfo } from "@/state/store";

export function instanceSupportsLocalComputer(
  instances: InstanceInfo[],
  bot: Pick<Bot, "modelSelection">,
): boolean {
  const capabilities = instances.find(
    (instance) => instance.instanceId === bot.modelSelection.instanceId,
  )?.capabilities;
  return capabilities?.localComputerMcp === true || capabilities?.computerMcp === true;
}

/** Whether the Runs-on “This computer” control should be clickable.
 *  macOS keeps the destination available even before CUA has a grant, so
 *  the user can pick it and then approve Accessibility / Screen Recording
 *  instead of finding a grayed-out button. */
export function localComputerSelectable({
  capabilities,
  providerSupportsLocal,
}: {
  capabilities: DesktopCapabilities;
  providerSupportsLocal: boolean;
}): boolean {
  if (!providerSupportsLocal) return false;
  if (capabilities.localComputer.available) return true;
  return capabilities.host.platform === "darwin";
}

export function localComputerDisabledReason({
  capabilities,
  providerSupportsLocal,
}: {
  capabilities: DesktopCapabilities;
  providerSupportsLocal: boolean;
}): string | null {
  if (!providerSupportsLocal) {
    return "The selected provider cannot request approvals for local computer actions.";
  }
  if (capabilities.localComputer.available) return null;
  if (capabilities.host.platform === "linux") {
    if (capabilities.localComputer.reasonCode === "linux-wayland-seat-safety-blocked") {
      return "Local computer control is not available on Wayland yet. Sign out and choose Ubuntu on Xorg to use This computer.";
    }
    if (capabilities.localComputer.reasonCode === "wayland-compositor-unsupported") {
      return "Wayland local control is currently limited to GNOME. Xorg remains available on supported desktops.";
    }
    if (!capabilities.localComputer.enabled) {
      return "Enable the local control beta and complete the Cua Driver checks first.";
    }
    return capabilities.localComputer.message ?? "Cua Driver is not ready for local control.";
  }
  if (capabilities.host.label === "Browser") {
    return "Local computer control requires the desktop app.";
  }
  return "CUA Driver is not ready for local computer control.";
}

export function linuxAutoDescription(): string {
  return "Auto uses an ASCII.dev Box when one is configured; otherwise computer use stays off.";
}

export function autoSelectsLocalComputer({
  platform,
  computers,
  capabilitiesReady,
  localSelectable,
}: {
  platform: DesktopCapabilities["host"]["platform"];
  computers: Bot["computers"];
  capabilitiesReady: boolean;
  localSelectable: boolean;
}): boolean {
  return platform !== "linux" && !(computers ?? []).includes("cloud") && capabilitiesReady && localSelectable;
}

/** Can this bot's engine drive a Local VM?
 *
 * The server refuses at turn time (`server/index.ts`, the `wantsVm` gate),
 * and refusing there alone cost a real fleet 51 failed turns: the person
 * picked a destination the button offered, sent work, and found out when
 * the turn died.  contracts.ts states the rule the picker should have been
 * following all along — never show a knob the driver cannot turn — so the
 * same condition is answered here, before the choice is made.
 *
 * Box runs the agent on the remote box, so it does not mount a VM into a
 * local agent; that is why it is excluded despite having computerMcp. */
export function instanceSupportsLocalVm(
  instances: InstanceInfo[],
  bot: Pick<Bot, "modelSelection">,
): boolean {
  const instance = instances.find((candidate) => candidate.instanceId === bot.modelSelection.instanceId);
  if (!instance) return true; // unknown engine: let the server have the last word
  if (instance.driverKind === "boxAgent") return false;
  return instance.capabilities?.computerMcp === true;
}

/** Can this bot's engine mount a cloud computer at all?
 *
 * `boxAgent` runs the turn on the box itself, so it always can; every other
 * engine needs the computer MCP surface. */
export function instanceSupportsCloudComputer(
  instances: InstanceInfo[],
  bot: Pick<Bot, "modelSelection">,
): boolean {
  const instance = instances.find((candidate) => candidate.instanceId === bot.modelSelection.instanceId);
  if (!instance) return true;
  if (instance.driverKind === "boxAgent") return true;
  return instance.capabilities?.computerMcp === true;
}

/** Why a computer destination is not offered, in the words the picker shows.
 * `null` means it is available. */
export function computerDestinationDisabledReason(
  mode: "cloud" | "vm",
  instances: InstanceInfo[],
  bot: Pick<Bot, "modelSelection">,
): string | null {
  const supported = mode === "vm" ? instanceSupportsLocalVm(instances, bot) : instanceSupportsCloudComputer(instances, bot);
  if (supported) return null;
  const engine = instances.find((candidate) => candidate.instanceId === bot.modelSelection.instanceId);
  const name = engine?.displayName ?? "This engine";
  return mode === "vm"
    ? `${name} cannot drive a Local VM.  Choose Claude or an ACP engine, or another destination.`
    : `${name} cannot drive a remote desktop.  Choose Claude or an ACP engine, or another destination.`;
}
