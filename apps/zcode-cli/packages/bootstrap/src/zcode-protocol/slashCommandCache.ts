// Custom slash-command discovery cache.
// New file — no upstream merge conflict risk.
//
// listZCodeCustomCommands scans plugin dirs + filesystem per workspace and
// takes ~5.5s on this box, blocking readWorkspacePresentation on every
// session switch. Command catalogs change rarely; cache per working
// directory with a short TTL and refresh in the background.

import type { CustomCommandLoadOutcome } from "@zcode/contracts";

type CustomCommandList = CustomCommandLoadOutcome["commands"];

const CACHE_TTL_MS = 30_000;

const cache = new Map<string, { commands: CustomCommandList; timestamp: number }>();

export function getCachedCustomCommands(key: string): CustomCommandList | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) return null;
  return entry.commands;
}

export function setCachedCustomCommands(key: string, commands: CustomCommandList): void {
  cache.set(key, { commands, timestamp: Date.now() });
}
