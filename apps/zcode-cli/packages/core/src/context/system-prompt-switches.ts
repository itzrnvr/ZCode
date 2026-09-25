// System-prompt kill-switch state + custom texts.
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
// Wiring (single integration points, documented in CLAUDE.md):
// - sections/identity.ts: reads getSystemPromptSwitches() before emitting the block
// - builder.ts step 3: reads getSystemPromptSwitches() before memory section
// - request-user-context.ts: reads getSystemPromptSwitches() before body
// - record create path seeds values; settings apply propagates live same as memoryEnabled.
//
// Call sites read keys off getSystemPromptSwitches() directly (one shared getter,
// three-plus call sites staying in lockstep); no per-key wrappers.

export interface SystemPromptSwitches {
  securityNoticeEnabled: boolean;
  autoMemoryEnabled: boolean;
  agentsMdEnabled: boolean;
  securityNoticeText?: string;
  customText?: string;
}

const state: SystemPromptSwitches = {
  securityNoticeEnabled: true,
  autoMemoryEnabled: true,
  agentsMdEnabled: true,
};

export function getSystemPromptSwitches(): SystemPromptSwitches {
  return state;
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
}
