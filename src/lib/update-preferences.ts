export const UPDATE_NOTIFICATIONS_KEY = "botfleet.updateNotifications";

export function loadUpdateNotificationsEnabled(): boolean {
  try {
    const val = globalThis.localStorage?.getItem(UPDATE_NOTIFICATIONS_KEY);
    if (val === "false") return false;
    return true;
  } catch {
    return true;
  }
}

export function saveUpdateNotificationsEnabled(enabled: boolean): void {
  try {
    globalThis.localStorage?.setItem(UPDATE_NOTIFICATIONS_KEY, enabled ? "true" : "false");
  } catch {}
}
