import type { SandboxMode } from "./types.js";

export interface ParsedTelegramSlashCommand {
  name: string;
  args: string;
}

const SUPPORTED_CODEX_COMMANDS = new Set([
  "approvals",
  "account",
  "agent",
  "apps",
  "clear",
  "collab",
  "compact",
  "continue",
  "copy",
  "diff",
  "esc",
  "experimental",
  "ese",
  "fast",
  "feedback",
  "fork",
  "goal",
  "init",
  "logout",
  "mcp",
  "mention",
  "model",
  "new",
  "personality",
  "plan",
  "permissions",
  "sandbox",
  "plugins",
  "quit",
  "rename",
  "reload",
  "resume",
  "review",
  "rollout",
  "skills",
  "status",
  "stop",
  "subagents",
  "upgrade",
  "verbose",
  "version",
  "clean",
  "exit",
]);

const SANDBOX_MODE_ALIASES = new Map<string, SandboxMode>([
  ["read-only", "read-only"],
  ["readonly", "read-only"],
  ["read_only", "read-only"],
  ["workspace-write", "workspace-write"],
  ["workspacewrite", "workspace-write"],
  ["workspace_write", "workspace-write"],
  ["danger-full-access", "danger-full-access"],
  ["danger", "danger-full-access"],
  ["dangerfullaccess", "danger-full-access"],
  ["danger_full_access", "danger-full-access"],
]);

const KNOWN_BUT_UNSUPPORTED_COMMANDS = new Set([
  "debug-config",
  "ps",
  "realtime",
  "sandbox-add-read-dir",
  "settings",
  "setup-default-sandbox",
  "statusline",
  "test-approval",
  "theme",
  "title",
  "debug-m-drop",
  "debug-m-update",
]);

const APPROVAL_POLICY_ALIASES = new Map<string, string>([
  ["untrusted", "untrusted"],
  ["unless-trusted", "untrusted"],
  ["unless_trusted", "untrusted"],
  ["on-failure", "on-failure"],
  ["onfailure", "on-failure"],
  ["on_failure", "on-failure"],
  ["on-request", "on-request"],
  ["onrequest", "on-request"],
  ["on_request", "on-request"],
  ["never", "never"],
]);

export function parseTelegramSlashCommand(text: string): ParsedTelegramSlashCommand | null {
  const trimmed = text.trim();
  const match = /^\/([^\s@]+)(?:@[^\s]+)?(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) {
    return null;
  }
  return {
    name: match[1]!.toLowerCase(),
    args: (match[2] ?? "").trim(),
  };
}

export function isRecognizedCodexSlashCommand(name: string): boolean {
  return SUPPORTED_CODEX_COMMANDS.has(name) || KNOWN_BUT_UNSUPPORTED_COMMANDS.has(name);
}

export function isSupportedCodexSlashCommand(name: string): boolean {
  return SUPPORTED_CODEX_COMMANDS.has(name);
}

export function isUnsupportedTelegramOnlyCodexCommand(name: string): boolean {
  return KNOWN_BUT_UNSUPPORTED_COMMANDS.has(name);
}

export function isTaskBlockingSlashCommand(name: string): boolean {
  return new Set([
    "approvals",
    "account",
    "clear",
    "compact",
    "experimental",
    "fast",
    "fork",
    "init",
    "logout",
    "model",
    "new",
    "continue",
    "personality",
    "plan",
    "permissions",
    "sandbox",
    "rename",
    "resume",
    "review",
    "upgrade",
  ]).has(name);
}

export function normalizeApprovalPolicy(value: string): string | null {
  return APPROVAL_POLICY_ALIASES.get(value.trim().toLowerCase()) ?? null;
}

export function normalizeSandboxMode(value: string): SandboxMode | null {
  return SANDBOX_MODE_ALIASES.get(value.trim().toLowerCase()) ?? null;
}

export function normalizeReasoningEffort(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (["minimal", "low", "medium", "high"].includes(normalized)) {
    return normalized;
  }
  return null;
}

export function codexSlashHelpText(): string {
  return [
    "Codex Anywhere commands:",
    "/start, /help, /new, /resume, /continue, /reload, /interrupt, /cancel, /status, /version, /upgrade, /workspace <path>, /addbot, /download <path>, /omx <args>, /computer <task>",
    "Telegram will also show the registered command list when you type /",
    "",
    "Bridge-managed commands and bridged Codex slash commands:",
    "/account [status|login|switch|logout]",
    "/goal [status|set <objective>|clear]",
    "/model [status|reset|<model> [effort]]",
    "/fast [status|on|off]",
    "/personality [friendly|pragmatic|none]",
    "/permissions [status|untrusted|on-failure|on-request|never]",
    "/sandbox [status|read-only|workspace-write|danger-full-access]",
    "/plan [task]",
    "/collab [mode]",
    "/agent, /subagents",
    "/resume, /continue [session-id], /reload, /upgrade",
    "/review [base <branch>|commit <sha>|<custom instructions>]",
    "/rename <name>, /fork, /compact, /clear",
    "/diff, /copy, /mention <query>, /skills, /mcp, /apps, /plugins, /feedback, /verbose [on|off|status]",
    "/experimental [status|<feature> on|off], /rollout, /version, /logout, /quit, /exit, /stop",
    "/esc (/ese alias) to interrupt the current turn",
    "/omx [args] to run supported oh-my-codex CLI commands",
    "/computer <task> to run a Computer Use task through the bundled plugin",
    "/download [auto|file|photo|zip|list|info] <path> to send workspace files to Telegram",
    "Note: Computer Use must be enabled from the Codex app before /computer can control the desktop.",
    "",
    "Interactive prompts:",
    "- approvals and file changes appear as Telegram buttons",
    "- choice prompts are rendered as Telegram cards",
    "- freeform prompts ask you to reply in chat",
    "- some slash commands open Telegram pickers when invoked without args",
    "- send a photo with an optional caption to include image + text in one turn",
    "- while a turn is active, sending a message steers it; use Queue Next to hold the next message",
    "- send /cancel to cancel an active prompt",
    "",
    "Recognized but not meaningful in Telegram yet:",
    "/ps, /theme, /title, /statusline, /realtime, /settings",
  ].join("\n");
}
