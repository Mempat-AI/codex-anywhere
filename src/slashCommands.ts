export interface ParsedTelegramSlashCommand {
  name: string;
  args: string;
}

const SUPPORTED_CODEX_COMMANDS = new Set([
  "approvals",
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
  "init",
  "logout",
  "mcp",
  "mention",
  "model",
  "new",
  "personality",
  "plan",
  "permissions",
  "plugins",
  "quit",
  "rename",
  "resume",
  "review",
  "rollout",
  "skills",
  "status",
  "stop",
  "subagents",
  "verbose",
  "clean",
  "exit",
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
    "rename",
    "resume",
    "review",
  ]).has(name);
}

export function normalizeApprovalPolicy(value: string): string | null {
  return APPROVAL_POLICY_ALIASES.get(value.trim().toLowerCase()) ?? null;
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
    "/start, /help, /new, /resume, /continue, /interrupt, /cancel, /status, /sh <command>, /workspace <path>, /addbot",
    "Telegram will also show the registered command list when you type /",
    "",
    "Codex slash commands supported in Telegram:",
    "/model [status|reset|<model> [effort]]",
    "/fast [status|on|off]",
    "/personality [friendly|pragmatic|none]",
    "/permissions [status|untrusted|on-failure|on-request|never]",
    "/plan [task]",
    "/collab [mode]",
    "/agent, /subagents",
    "/resume",
    "/continue [session-id]",
    "/review [base <branch>|commit <sha>|<custom instructions>]",
    "/rename <name>, /fork, /compact, /clear",
    "/diff, /copy, /mention <query>, /skills, /mcp, /apps, /plugins, /feedback, /verbose [on|off|status]",
    "/experimental [status|<feature> on|off], /rollout, /logout, /quit, /exit, /stop",
    "/esc (/ese alias) to interrupt the current turn",
    "/omx [args] to run supported oh-my-codex CLI commands",
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
