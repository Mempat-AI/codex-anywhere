import type { JsonObject } from "./types.js";

export type TelegramParseMode = "HTML";

export function formatApprovalPromptHtml(
  method: string,
  params: JsonObject,
  items: Map<string, JsonObject>,
): string {
  const reason = asString(params.reason) ?? "";
  if (method === "item/commandExecution/requestApproval") {
    const lines = [
      `<b>Approve command?</b>`,
      `<code>${escapeTelegramHtml(asString(params.command) ?? "<unknown>")}</code>`,
      `<code>${escapeTelegramHtml(asString(params.cwd) ?? "<unknown>")}</code>`,
    ];
    if (reason) lines.push(escapeTelegramHtml(reason));
    return lines.join("\n");
  }

  if (method === "item/fileChange/requestApproval") {
    const itemId = asString(params.itemId);
    const item = itemId ? items.get(itemId) : undefined;
    const paths = collectChangePaths(item).slice(0, 5);
    const lines = [
      `<b>Approve file changes?</b>`,
      paths.length > 0
        ? paths.map((p) => `<code>${escapeTelegramHtml(p)}</code>`).join("\n")
        : "(paths unavailable)",
    ];
    if (reason) lines.push(escapeTelegramHtml(reason));
    return lines.join("\n");
  }

  const permissions = escapeTelegramHtml(JSON.stringify(params.permissions ?? {}, null, 2));
  const lines = [`<b>Grant permissions?</b>`];
  if (reason) lines.push(escapeTelegramHtml(reason));
  lines.push("", `<pre>${permissions}</pre>`);
  return lines.join("\n");
}

export function formatCommandCompletionHtml(item: JsonObject, verbose = false): string {
  const command = asString(item.command) ?? "<unknown>";
  const status = asString(item.status) ?? "unknown";
  const exitCode = item.exitCode;
  const aggregatedOutput = asString(item.aggregatedOutput);
  const succeeded =
    status === "completed" && (typeof exitCode !== "number" || exitCode === 0);
  const summary = summarizeCommand(command);

  if (succeeded && !verbose) {
    const detail = summary.detail ? `  ${escapeTelegramHtml(summary.detail)}` : "";
    return `<b>${escapeTelegramHtml(summary.title)}</b>${detail}`;
  }

  const parts = [
    `<b>${escapeTelegramHtml(summary.title)}</b>`,
    `<code>${escapeTelegramHtml(command)}</code>`,
    `status: <code>${escapeTelegramHtml(status)}</code>`,
  ];
  if (typeof exitCode === "number") {
    parts.push(`exit code: <code>${exitCode}</code>`);
  }
  if (aggregatedOutput) {
    parts.push("", `<pre>${escapeTelegramHtml(aggregatedOutput.slice(-1500))}</pre>`);
  }
  return parts.join("\n");
}

export function formatFileChangeCompletionHtml(item: JsonObject, verbose = false): string {
  const status = asString(item.status) ?? "unknown";
  const paths = collectChangePaths(item).slice(0, 5);
  const totalChanges = Array.isArray(item.changes) ? item.changes.length : paths.length;
  const succeeded = status === "completed";

  if (succeeded && !verbose) {
    return `<b>${escapeTelegramHtml(summarizeFileChanges(paths, totalChanges))}</b>`;
  }

  return [
    `<b>File change ${escapeTelegramHtml(status)}</b>`,
    paths.length > 0
      ? paths.map((path) => `<code>${escapeTelegramHtml(path)}</code>`).join("\n")
      : "No paths reported.",
  ].join("\n");
}

export function formatTurnCompletionHtml(status: string, errorMessage: string | null): string | null {
  if (status === "completed") {
    return null;
  }
  if (status === "failed") {
    return [
      `<b>Turn failed</b>`,
      `error: ${escapeTelegramHtml(errorMessage ?? "unknown error")}`,
    ].join("\n");
  }
  return `<b>Turn ${escapeTelegramHtml(status)}</b>`;
}

export function formatPendingInputActionHtml(
  kind: "queued" | "starting" | "steered" | "armed",
  input?: JsonObject[] | null,
): string {
  if (kind === "armed") {
    return [
      "<b>Queue Next armed</b>",
      "Your next message will queue for a new turn.",
    ].join("\n");
  }

  const summary = summarizeInput(input ?? []);
  const title =
    kind === "queued"
      ? "Queued"
      : kind === "starting"
        ? "Starting queued turn"
        : "Steering turn";

  const lines = [`<b>${title}</b>`];
  if (summary.preview) {
    lines.push(escapeTelegramHtml(summary.preview));
  }
  if (summary.attachments) {
    lines.push(`+${escapeTelegramHtml(summary.attachments)}`);
  }
  return lines.join("\n");
}

export function renderAssistantTextHtml(text: string): string {
  const parts: string[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    if (text.startsWith("```", cursor)) {
      const rendered = renderCodeFence(text, cursor);
      parts.push(rendered.html);
      cursor = rendered.nextCursor;
      continue;
    }

    if (text[cursor] === "`") {
      const rendered = renderInlineCode(text, cursor);
      parts.push(rendered.html);
      cursor = rendered.nextCursor;
      continue;
    }

    const nextFence = text.indexOf("```", cursor);
    const nextInline = text.indexOf("`", cursor);
    const nextMarker = [nextFence, nextInline]
      .filter((index) => index >= 0)
      .reduce((smallest, index) => Math.min(smallest, index), text.length);
    parts.push(renderPlainMarkdown(text.slice(cursor, nextMarker)));
    cursor = nextMarker;
  }

  return parts.join("");
}

/** Telegram message text limit with safety margin (API max is 4096). */
export const TELEGRAM_TEXT_LIMIT = 3900;

/**
 * Split a long text into chunks that each fit within the Telegram message
 * limit.  Tries to break at section boundaries (headings, horizontal rules,
 * paragraph breaks, newlines) so each chunk reads naturally.
 */
export function splitTelegramChunks(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    let splitAt = -1;

    // Prefer heading boundary  (\n# )
    const headingIdx = window.lastIndexOf("\n#");
    if (headingIdx > limit * 0.2) {
      splitAt = headingIdx;
    }

    // Then horizontal rule  (\n---)
    if (splitAt === -1) {
      const hrIdx = window.lastIndexOf("\n---");
      if (hrIdx > limit * 0.2) splitAt = hrIdx;
    }

    // Then paragraph break  (\n\n)
    if (splitAt === -1) {
      const paraIdx = window.lastIndexOf("\n\n");
      if (paraIdx > limit * 0.2) splitAt = paraIdx;
    }

    // Then any newline
    if (splitAt === -1) {
      const nlIdx = window.lastIndexOf("\n");
      if (nlIdx > limit * 0.2) splitAt = nlIdx;
    }

    // Hard break as last resort
    if (splitAt === -1) splitAt = limit;

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }

  if (remaining.trim()) chunks.push(remaining.trim());
  return chunks;
}

export function escapeTelegramHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function collectChangePaths(item: JsonObject | undefined): string[] {
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  return changes
    .map((entry) =>
      entry && typeof entry === "object" && "path" in entry ? String(entry.path) : null,
    )
    .filter((entry): entry is string => Boolean(entry));
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function summarizeInput(input: JsonObject[]): { preview: string | null; attachments: string | null } {
  const texts = input
    .filter((entry) => entry.type === "text")
    .map((entry) => asString(entry.text))
    .filter((entry): entry is string => Boolean(entry))
    .join(" ")
    .trim();

  const imageCount = input.filter(
    (entry) => entry.type === "localImage" || entry.type === "image",
  ).length;
  const mentionCount = input.filter((entry) => entry.type === "mention").length;

  const attachmentParts = [];
  if (imageCount > 0) {
    attachmentParts.push(`${imageCount} image${imageCount === 1 ? "" : "s"}`);
  }
  if (mentionCount > 0) {
    attachmentParts.push(`${mentionCount} mention${mentionCount === 1 ? "" : "s"}`);
  }

  return {
    preview: texts ? truncateText(texts, 140) : null,
    attachments: attachmentParts.length > 0 ? attachmentParts.join(", ") : null,
  };
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}…`;
}

function summarizeCommand(command: string): { title: string; detail: string } {
  const normalized = command.trim();

  if (/\brg\b/.test(normalized)) {
    return {
      title: "Searched codebase",
      detail: summarizeQuotedArg(normalized) ?? "Searched repository text",
    };
  }

  if (/\bsed\b/.test(normalized) || /\bcat\b/.test(normalized) || /\bhead\b/.test(normalized) || /\btail\b/.test(normalized)) {
    return {
      title: "Read file content",
      detail: summarizePathLikeArg(normalized) ?? "Viewed file or log output",
    };
  }

  if (/\bgit\b/.test(normalized)) {
    return {
      title: "Checked git state",
      detail: summarizeGitCommand(normalized),
    };
  }

  if (/\b(test|vitest|jest|pytest|cargo test|go test)\b/.test(normalized)) {
    return {
      title: "Ran tests",
      detail: "Executed test command",
    };
  }

  if (/\b(tsc|typecheck|mypy|pyright)\b/.test(normalized)) {
    return {
      title: "Ran typecheck",
      detail: "Checked project types",
    };
  }

  if (/\b(build|compile)\b/.test(normalized)) {
    return {
      title: "Built project",
      detail: "Executed build command",
    };
  }

  return {
    title: "Command finished",
    detail: summarizeQuotedArg(normalized) ?? "Executed shell command",
  };
}

function summarizeFileChanges(paths: string[], totalChanges: number): string {
  if (paths.length === 0) {
    return totalChanges === 1 ? "Updated 1 file" : `Updated ${totalChanges} files`;
  }
  if (paths.length === 1) {
    return `Updated ${paths[0]}`;
  }
  return `Updated ${paths[0]} and ${totalChanges - 1} more file${totalChanges - 1 === 1 ? "" : "s"}`;
}

function summarizeGitCommand(command: string): string {
  if (command.includes("status")) {
    return "Read working tree status";
  }
  if (command.includes("diff")) {
    return "Inspected git diff";
  }
  if (command.includes("rev-parse")) {
    return "Resolved repository metadata";
  }
  return "Executed git command";
}

function summarizeQuotedArg(command: string): string | null {
  const quoted = /["']([^"']{1,120})["']/.exec(command);
  return quoted?.[1] ?? null;
}

function summarizePathLikeArg(command: string): string | null {
  const match = /([~/.A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.exec(command);
  return match?.[1] ?? null;
}

// Render a plain-text markdown segment (not inside code fences/spans).
// Handles ATX headings, horizontal rules, bullet lists, and **bold** markers.
function renderPlainMarkdown(text: string): string {
  const lines = text.split("\n");
  return lines
    .map((line, idx) => {
      // Horizontal rules: ---, ***, ___
      if (/^[\s]*[-*_]{3,}\s*$/.test(line)) {
        return "———";
      }
      // ATX headings: # … / ## … / ### …
      const headingMatch = /^(#{1,3}) (.+)$/.exec(line);
      if (headingMatch) {
        const prefix = idx > 0 ? "\n" : "";
        return `${prefix}<b>${renderBoldMarkdown(headingMatch[2]!)}</b>`;
      }
      // Unordered list items: - … / * …
      const bulletMatch = /^(\s*)[*-] (.+)$/.exec(line);
      if (bulletMatch) {
        const indent = bulletMatch[1]!.length > 0 ? "  " : "";
        return `${indent}• ${renderBoldMarkdown(bulletMatch[2]!)}`;
      }
      // Ordered list items: 1. …
      const orderedMatch = /^(\s*)(\d+)\. (.+)$/.exec(line);
      if (orderedMatch) {
        const indent = orderedMatch[1]!.length > 0 ? "  " : "";
        return `${indent}${orderedMatch[2]}. ${renderBoldMarkdown(orderedMatch[3]!)}`;
      }
      return renderBoldMarkdown(line);
    })
    .join("\n");
}

// Render **bold** markers within a single line of plain text.
function renderBoldMarkdown(text: string): string {
  let result = "";
  let i = 0;
  let plainStart = 0;

  const flush = (end: number) => {
    if (end > plainStart) {
      result += escapeTelegramHtml(text.slice(plainStart, end));
    }
  };

  while (i < text.length) {
    if (text[i] === "*" && text[i + 1] === "*") {
      const closeIdx = text.indexOf("**", i + 2);
      if (closeIdx > i + 1) {
        flush(i);
        result += `<b>${escapeTelegramHtml(text.slice(i + 2, closeIdx))}</b>`;
        i = closeIdx + 2;
        plainStart = i;
        continue;
      }
    }
    i++;
  }
  flush(i);
  return result;
}

function renderCodeFence(
  text: string,
  cursor: number,
): { html: string; nextCursor: number } {
  let contentStart = cursor + 3;
  while (contentStart < text.length && text[contentStart] !== "\n" && text[contentStart] !== "\r") {
    contentStart += 1;
  }
  if (contentStart < text.length) {
    if (text[contentStart] === "\r" && text[contentStart + 1] === "\n") {
      contentStart += 2;
    } else {
      contentStart += 1;
    }
  } else {
    contentStart = cursor + 3;
  }

  const fenceEnd = text.indexOf("```", contentStart);
  const end = fenceEnd >= 0 ? fenceEnd : text.length;
  return {
    html: `<pre>${escapeTelegramHtml(text.slice(contentStart, end))}</pre>`,
    nextCursor: fenceEnd >= 0 ? fenceEnd + 3 : text.length,
  };
}

function renderInlineCode(
  text: string,
  cursor: number,
): { html: string; nextCursor: number } {
  const end = text.indexOf("`", cursor + 1);
  const close = end >= 0 ? end : text.length;
  return {
    html: `<code>${escapeTelegramHtml(text.slice(cursor + 1, close))}</code>`,
    nextCursor: end >= 0 ? end + 1 : text.length,
  };
}
