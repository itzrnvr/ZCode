// Side-pane state persistence layer.
// New file — no upstream merge conflict risk.
// All localStorage read/write logic lives here; the existing
// taskSidePaneMemory.ts only needs a 1-line import + call.

import type { TaskSidePaneMemoryState } from "./taskSidePaneMemory.js";

const STORAGE_PREFIX = "zc-sp:";

/**
 * Try reading persisted side-pane state from localStorage.
 * Returns null if not found or on error (SSR, quota, corrupted JSON).
 */
export function readPersistedSidePaneState(
  key: string,
): TaskSidePaneMemoryState | null {
  try {
    const stored = localStorage.getItem(STORAGE_PREFIX + key);
    if (stored) {
      return JSON.parse(stored) as TaskSidePaneMemoryState;
    }
  } catch {
    // localStorage unavailable or corrupted JSON — silent fallback
  }
  return null;
}

/**
 * Mirror side-pane state to localStorage so it survives renderer reloads.
 */
export function persistSidePaneState(
  key: string,
  state: TaskSidePaneMemoryState,
): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(state));
  } catch {
    // Quota exceeded or serialization error — in-memory state is still valid
  }
}
