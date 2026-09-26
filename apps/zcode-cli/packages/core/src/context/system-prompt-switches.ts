// System-prompt kill-switch state + custom texts + per-section overrides.
// New file — no upstream merge conflict risk.
//
// Three independent global switches controlling the default prompt stack.
// All default true (full upstream behavior); each can be flipped at runtime
// via the settings page without touching upstream files.
//
// - securityNoticeEnabled: the stable identity SECURITY_NOTICE block.
//   False removes it from identity + workflow-actor sections alike.
// - autoMemoryEnabled: the whole "# Memory" section.
//   False drops the section (distinct from features.memory use toggle).
// - agentsMdEnabled: the "# agentsMd" section (AGENTS.md + project memory index).
//   False drops the section even when userInstructions resolved.
//
// Two custom texts (empty/absent = upstream default):
// - securityNoticeText: replaces SECURITY_NOTICE verbatim when non-empty.
// - customText: full-override body. When non-empty it flows into the existing
//   customSystemPrompt builder path (replaces stable body + skips dynamic
//   sections) — the same path runtimeConfig.systemPrompt feeds, now settable
//   from settings instead of only bootstrap code.
//
// Per-section overrides (absent/empty per key = upstream default text):
// - sectionTexts: Record keyed by section key
//   (cli-prefix, harness, desktop-context, dynamic-behavior, context-management).
//   A non-empty value replaces that section's default text verbatim, so each
//   prompt block is individually editable instead of requiring a full override.
//
// Wiring (single integration points, documented in CLAUDE.md):
// - sections/identity.ts: reads getSystemPromptSwitches() before emitting the block
// - builder.ts step 3: reads getSystemPromptSwitches() before memory section
// - request-user-context.ts: reads getSystemPromptSwitches() before body
// - record create path seeds values; settings apply propagates live same as memoryEnabled.
//
// Call sites read keys off getSystemPromptSwitches() directly (one shared getter,
// three-plus call sites staying in lockstep); no per-key wrappers.

export type SystemPromptSectionKey =
  | "cli-prefix"
  | "harness"
  | "desktop-context"
  | "dynamic-behavior"
  | "context-management";

export interface SystemPromptSwitches {
  securityNoticeEnabled: boolean;
  autoMemoryEnabled: boolean;
  agentsMdEnabled: boolean;
  securityNoticeText?: string;
  customText?: string;
  sectionTexts?: Partial<Record<SystemPromptSectionKey, string>>;
}

const state: SystemPromptSwitches = {
  securityNoticeEnabled: true,
  autoMemoryEnabled: true,
  agentsMdEnabled: true,
};

export function getSystemPromptSwitches(): SystemPromptSwitches {
  return state;
}

/** Non-empty override for one static section, or undefined when default. */
export function getSectionTextOverride(key: SystemPromptSectionKey): string | undefined {
  const raw = state.sectionTexts?.[key];
  const text = raw?.trim();
  return text ? raw : undefined;
}

export function setSystemPromptSwitches(patch: Partial<SystemPromptSwitches>): void {
  if (typeof patch.securityNoticeEnabled === "boolean") {
    state.securityNoticeEnabled = patch.securityNoticeEnabled;
  }
  if (typeof patch.autoMemoryEnabled === "boolean") {
    state.autoMemoryEnabled = patch.autoMemoryEnabled;
  }
  if (typeof patch.agentsMdEnabled === "boolean") {
    state.agentsMdEnabled = patch.agentsMdEnabled;
  }
  if (typeof patch.securityNoticeText === "string" || patch.securityNoticeText === undefined) {
    if (patch.securityNoticeText === undefined) {
      delete state.securityNoticeText;
    } else {
      state.securityNoticeText = patch.securityNoticeText;
    }
  }
  if (typeof patch.customText === "string" || patch.customText === undefined) {
    if (patch.customText === undefined) {
      delete state.customText;
    } else {
      state.customText = patch.customText;
    }
  }
  if (patch.sectionTexts !== undefined) {
    const cleaned: Partial<Record<SystemPromptSectionKey, string>> = {};
    for (const [key, value] of Object.entries(patch.sectionTexts)) {
      if (typeof value === "string" && value.trim()) {
        (cleaned as Record<string, string>)[key] = value;
      }
    }
    if (Object.keys(cleaned).length > 0) {
      state.sectionTexts = { ...state.sectionTexts, ...cleaned };
    } else if (patch.sectionTexts && Object.keys(patch.sectionTexts).length === 0) {
      delete state.sectionTexts;
    }
  }
}
