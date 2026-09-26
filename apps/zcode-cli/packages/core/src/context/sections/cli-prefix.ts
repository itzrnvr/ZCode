// ============================================================
// CLI Prefix Section Builder
// ============================================================

import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";
// Fork: per-section override (single import line).
import { getSectionTextOverride } from "../system-prompt-switches.js";

const CLI_PREFIX_PROMPT = "You are ZCode, an interactive coding agent";
export function buildCliPrefixSection(): ContextSection {
  // Fork: per-section override. Non-empty settings text replaces the block verbatim.
  const content = getSectionTextOverride("cli-prefix") ?? CLI_PREFIX_PROMPT;

  return {
    name: "CLI Prefix",
    source: "cli_prefix",
    injectionTarget: "system",
    cacheHint: "stable",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
