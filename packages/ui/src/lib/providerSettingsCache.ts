// Provider settings cache — prevents 9.3s network timeout to zcode.z.ai
// on every session switch. New file — no upstream merge conflict risk.

const CACHE_KEY = "zcode:provider-settings-cache";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CachedSettings {
  view: unknown;
  timestamp: number;
}

export function getCachedProviderSettings(): unknown | null {
  try {
    const stored = localStorage.getItem(CACHE_KEY);
    if (!stored) return null;
    const cached = JSON.parse(stored) as CachedSettings;
    if (Date.now() - cached.timestamp > CACHE_TTL_MS) return null;
    return cached.view;
  } catch (_e) {
    return null;
  }
}

export function setCachedProviderSettings(view: unknown): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ view, timestamp: Date.now() }));
  } catch (_e) {
    // localStorage unavailable or quota exceeded
  }
}

export async function withSettingsCache<T>(
  refreshFn: () => Promise<T>,
): Promise<T> {
  const cached = getCachedProviderSettings() as T | null;
  if (cached) {
    // Return cached immediately, refresh in background
    void refreshFn().then(setCachedProviderSettings).then(undefined, function () {});
    return cached;
  }
  try {
    const view = await refreshFn();
    setCachedProviderSettings(view);
    return view;
  } catch (e) {
    throw new Error("provider-settings refresh failed and no cache available: " + (e instanceof Error ? e.message : String(e)));
  }
}
