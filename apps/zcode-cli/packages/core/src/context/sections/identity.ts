// ============================================================
// Identity Section Builder
// ============================================================

import type { ContextSection } from "../types.js";
import type { OutputStylePromptConfig } from "../types.js";
import { estimateTokens } from "../utils.js";
// Fork: system-prompt kill-switch integration (single import line).
import { getSectionTextOverride, getSystemPromptSwitches } from "../system-prompt-switches.js";

const SECURITY_NOTICE =
  "IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.";

/** 安全 IMPORTANT 行：交互式身份与工作流子代理身份共用。Off = 空串；非空自定义文本替换原文。 */
export function buildSecurityNotice(): string {
  const switches = getSystemPromptSwitches();
  if (!switches.securityNoticeEnabled) return "";
  const custom = switches.securityNoticeText?.trim();
  return custom ? custom : SECURITY_NOTICE;
}
/** Fork: default text for preview/reset in settings UI. */
export function getDefaultSecurityNotice(): string {
  return SECURITY_NOTICE;
}

/**
 * `# Harness` 块：稳定运行时约束，不属于 output style 可替换的 coding instructions，
 * 也是工作流子代理身份（sections/workflow-actor.ts）逐字复用的那一段。
 */
export function buildHarnessBlock(): string {
  // Fork: per-section override. Non-empty settings text replaces the block verbatim.
  const override = getSectionTextOverride("harness");
  if (override) return override;
  return [
    "# Harness",
    "- Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.",
    "- Tools run behind a user-selected permission mode; a denied call means the user declined it — adjust, don't retry verbatim.",
    "- The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results. Hooks may intercept tool calls; treat hook output as user feedback.",
    "- Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.",
    "- Reference code as `file_path:line_number` — it's clickable.",
  ].join("\n");
}
function buildIdentityPrompt(outputStyle?: OutputStylePromptConfig): string {
  const intro = outputStyle
    ? "You respond to the user according to the active Output Style below while using ZCode's tools and instructions."
    : "You are an interactive ZCode agent that helps users with software engineering tasks.";

  // Fork: security-notice kill-switch + custom text. Off = intro only; non-empty
  // custom text replaces the default notice (buildSecurityNotice() honors both).
  const notice = buildSecurityNotice();
  const identityLines = notice ? ["", intro, "", notice].join("\n") : ["", intro].join("\n");

  return [identityLines, "", buildHarnessBlock()].join("\n");
}

export function buildIdentitySection(outputStyle?: OutputStylePromptConfig): ContextSection {
  const content = buildIdentityPrompt(outputStyle);

  return {
    name: "Agent Identity",
    source: "identity",
    injectionTarget: "system",
    cacheHint: "stable",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
