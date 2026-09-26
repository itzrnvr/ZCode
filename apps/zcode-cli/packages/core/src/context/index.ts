// ============================================================
// Context Builder exports
// ============================================================

export * from "./types.js";
export * from "./builder.js";
export * from "./utils.js";
// Fork: system-prompt kill-switch state (single export line).
export { getSystemPromptSwitches, setSystemPromptSwitches } from "./system-prompt-switches.js";

export { buildIdentitySection } from "./sections/identity.js";
// Fork: default notice text for settings preview/reset (single export line).
export { getDefaultSecurityNotice } from "./sections/identity.js";
export { buildCliPrefixSection } from "./sections/cli-prefix.js";
export { buildWorkflowActorIdentitySection } from "./sections/workflow-actor.js";
export { buildEnvInfoSection, buildGitSystemContextSection } from "./sections/env-info.js";
export { buildSkillsSection } from "./sections/skills.js";
export { buildCurrentDateSection } from "./sections/current-date.js";
export { buildMemorySection } from "./sections/memory.js";
export { buildDesktopContextSection } from "./sections/desktop.js";
