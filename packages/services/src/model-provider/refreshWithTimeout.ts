// Provider settings refresh timeout guard.
// New file — no upstream merge conflict risk.
//
// facade.refresh() hits account providers on zcode.z.ai. When that host is
// slow/unreachable the call blocks for ~9s (HTTP timeout), freezing session
// switches. This wrapper caps the wait: after timeoutMs it resolves with the
// current (stale) view while the real refresh keeps running in the background
// and fires facade.onDidChange when it eventually completes.

export const PROVIDER_REFRESH_TIMEOUT_MS = 2000;

export function refreshWithTimeout<T>(
  refreshFn: () => Promise<T>,
  fallbackFn: () => T | Promise<T>,
  timeoutMs: number = PROVIDER_REFRESH_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      // Resolve with stale data now; the in-flight refresh continues and
      // publishes via onDidChange when it lands.
      void Promise.resolve()
        .then(fallbackFn)
        .then(
          (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
          },
          () => {
            // fallback failed too — leave settled=false so the original
            // refresh promise settles the caller whenever it finishes.
          },
        );
    }, timeoutMs);
    refreshFn().then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
