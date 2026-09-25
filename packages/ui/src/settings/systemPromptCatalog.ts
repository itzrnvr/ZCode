// System-prompt section catalog: what the model sees, where it lives, what feeds it.
// New file — no upstream merge conflict risk.
//
// Static metadata for the settings inspector. Live content for dynamic sections
// (env, git, date, skills, AGENTS.md) resolves per-session in the agent process;
// the UI shows the source path + how each section is fed, plus the static text
// inline where it is a hardcoded const. Custom-text overrides for the two
// editable sections live in settings; AGENTS.md stays file-sourced.

export interface PromptSectionMeta {
  /** Stable key used by the settings UI. */
  key: string;
  /** Display name shown in the inspector. */
  name: string;
  /** Short description of what the section does. */
  description: string;
  /** Repo-relative source file owning the text. */
  sourceFile: string;
  /** How the live content is produced. */
  contentSource:
    | "static-const"
    | "settings-override"
    | "runtime-live"
    | "files-on-disk"
    | "config-passthrough";
  /** Injection target in the assembled prompt. */
  injection: "system-stable" | "system-dynamic" | "meta-user";
  /** Whether the section can be toggled or edited from settings. */
  control: "kill-switch" | "editor" | "kill-switch+editor" | "none";
}

export const SYSTEM_PROMPT_SECTION_CATALOG: readonly PromptSectionMeta[] = [
  {
    key: "cli-prefix",
    name: "CLI Prefix",
    description: "Short leading identity block: You are ZCode, an interactive coding agent.",
    sourceFile: "apps/zcode-cli/packages/core/src/context/sections/cli-prefix.ts",
    contentSource: "static-const",
    injection: "system-stable",
    control: "none",
  },
  {
    key: "identity",
    name: "Agent Identity + Security Notice",
    description:
      "Intro line plus the IMPORTANT refusal block (authorized testing vs destructive techniques). The block tripping jailbreak-refusals on cybersec-flavored prompts lives here; workflow-actor subagents reuse it verbatim.",
    sourceFile: "apps/zcode-cli/packages/core/src/context/sections/identity.ts",
    contentSource: "static-const",
    injection: "system-stable",
    control: "kill-switch+editor",
  },
  {
    key: "harness",
    name: "# Harness",
    description: "Stable runtime constraints (markdown output, permission modes, hook output).",
    sourceFile: "apps/zcode-cli/packages/core/src/context/sections/identity.ts",
    contentSource: "static-const",
    injection: "system-stable",
    control: "none",
  },
  {
    key: "desktop-context",
    name: "Desktop Context",
    description: "File/URL/link rules for the desktop surface. Desktop sessions only.",
    sourceFile: "apps/zcode-cli/packages/core/src/context/sections/desktop.ts",
    contentSource: "static-const",
    injection: "system-dynamic",
    control: "none",
  },
  {
    key: "dynamic-behavior",
    name: "Dynamic Behavior",
    description: "Communication style: lead with the outcome, complete sentences, final-message rule.",
    sourceFile: "apps/zcode-cli/packages/core/src/context/dynamic-sections.ts",
    contentSource: "static-const",
    injection: "system-dynamic",
    control: "none",
  },
  {
    key: "session-guidance",
    name: "Session Guidance",
    description: "Tool/skill hints for this session. Absent when no tools or skills apply.",
    sourceFile: "apps/zcode-cli/packages/core/src/context/dynamic-sections.ts",
    contentSource: "runtime-live",
    injection: "system-dynamic",
    control: "none",
  },
  {
    key: "memory",
    name: "# Memory",
    description:
      "File-based memory usage instructions. Not the memory content itself — only how to use it.",
    sourceFile: "apps/zcode-cli/packages/core/src/context/sections/memory.ts",
    contentSource: "static-const",
    injection: "system-dynamic",
    control: "kill-switch",
  },
  {
    key: "env-info",
    name: "# Environment",
    description: "Live per-session facts: cwd, platform, shell, OS version.",
    sourceFile: "apps/zcode-cli/packages/core/src/context/sections/env-info.ts",
    contentSource: "runtime-live",
    injection: "system-dynamic",
    control: "none",
  },
  {
    key: "output-style",
    name: "Output Style",
    description: "Active output-style prompt. Absent when no style is set.",
    sourceFile: "apps/zcode-cli/packages/core/src/context/dynamic-sections.ts",
    contentSource: "config-passthrough",
    injection: "system-dynamic",
    control: "none",
  },
  {
    key: "context-management",
    name: "Context Management",
    description: "Compaction/summarization rules for long conversations.",
    sourceFile: "apps/zcode-cli/packages/core/src/context/dynamic-sections.ts",
    contentSource: "static-const",
    injection: "system-dynamic",
    control: "none",
  },
  {
    key: "git-context",
    name: "Git System Context",
    description: "Branch/status/commits snapshot at session start. Repo workspaces only.",
    sourceFile: "apps/zcode-cli/packages/core/src/context/sections/env-info.ts",
    contentSource: "runtime-live",
    injection: "system-dynamic",
    control: "none",
  },
  {
    key: "skills",
    name: "Skills Listing",
    description: "Invocable skills for this session, as a meta-user attachment.",
    sourceFile: "apps/zcode-cli/packages/core/src/context/sections/skills.ts",
    contentSource: "runtime-live",
    injection: "meta-user",
    control: "none",
  },
  {
    key: "agents-md",
    name: "# agentsMd",
    description:
      "Workspace AGENTS.md (walk-up from cwd) plus ~/.zcode/AGENTS.md plus the MEMORY.md project index. Files on disk are the source of truth — edit them in place.",
    sourceFile:
      "apps/zcode-cli/packages/core/src/context/sections/request-user-context.ts + apps/zcode-cli/packages/adapters/src/context/index.ts",
    contentSource: "files-on-disk",
    injection: "meta-user",
    control: "kill-switch",
  },
  {
    key: "current-date",
    name: "Current Date",
    description: "Today's date, resolved per session.",
    sourceFile: "apps/zcode-cli/packages/core/src/context/sections/current-date.ts",
    contentSource: "runtime-live",
    injection: "meta-user",
    control: "none",
  },
  {
    key: "custom-prompt",
    name: "Custom System Prompt (full override)",
    description:
      "When set, replaces the whole stable body and skips the dynamic stack. Same semantics as runtimeConfig.systemPrompt, now settable from settings.",
    sourceFile: "apps/zcode-cli/packages/core/src/context/builder.ts (customSystemPrompt path)",
    contentSource: "config-passthrough",
    injection: "system-stable",
    control: "editor",
  },
];

/** AGENTS.md resolution order, mirroring adapters/src/context/index.ts. */
export const AGENTS_MD_RESOLUTION_ORDER: readonly string[] = [
  "<workspace>/AGENTS.md (walk-up from session cwd to project root)",
  "~/.zcode/AGENTS.md (user default)",
  "<memoryRoot>/MEMORY.md (project memory index, appended in the same section)",
] as const;
