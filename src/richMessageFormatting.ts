import { escapeTelegramHtml } from "./telegramFormatting.js";
import type { TelegramInputRichMessage } from "./types.js";

export const RICH_MESSAGE_TEXT_LIMIT = 32_768;

const RICH_MESSAGE_SAFE_LIMIT = RICH_MESSAGE_TEXT_LIMIT - 768;
const RICH_MESSAGE_SOURCE_CHUNK_LIMIT = 24_000;
const RICH_DRAFT_SOURCE_LIMIT = 18_000;
const RICH_DRAFT_RENDERED_LIMIT = 22_000;
// Reserve at least 100 of Telegram's 500 blocks for thinking and trace details.
const RICH_MESSAGE_BODY_BLOCK_LIMIT = 380;
const RICH_MESSAGE_MEDIA_SAFE_LIMIT = 40;
const LIVE_HISTORY_LIMIT = 20_000;
const STREAMING_FINAL_HISTORY_LIMIT = 5_000;
const FINAL_HISTORY_LIMIT = 20_000;

interface TraceLoop {
  preamble: RichMessageTraceEntry | null;
  tools: RichMessageTraceEntry[];
}

interface TraceRenderProfile {
  preambleLimit: number;
  toolSummaryLimit: number;
  toolDetailLimit: number;
}

const TRACE_RENDER_PROFILES: TraceRenderProfile[] = [
  { preambleLimit: 1_200, toolSummaryLimit: 180, toolDetailLimit: 480 },
  { preambleLimit: 600, toolSummaryLimit: 150, toolDetailLimit: 220 },
  { preambleLimit: 300, toolSummaryLimit: 120, toolDetailLimit: 100 },
];

const RICH_HTML_TAGS = new Set([
  "a",
  "aside",
  "audio",
  "b",
  "blockquote",
  "br",
  "caption",
  "cite",
  "code",
  "del",
  "details",
  "em",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "input",
  "ins",
  "li",
  "mark",
  "ol",
  "p",
  "pre",
  "s",
  "strike",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "td",
  "tg-collage",
  "tg-emoji",
  "tg-map",
  "tg-math",
  "tg-math-block",
  "tg-reference",
  "tg-slideshow",
  "tg-spoiler",
  "tg-time",
  "th",
  "tr",
  "u",
  "ul",
  "video",
]);

export interface RichMessageTraceEntry {
  label: string;
  text: string;
}

export interface AssistantRichMessagePart {
  richMessage: TelegramInputRichMessage;
  fallbackMarkdown: string | null;
}

export function buildAssistantRichDraft({
  text,
  status,
  trace,
}: {
  text: string | null;
  status: string;
  trace: RichMessageTraceEntry[];
}): TelegramInputRichMessage {
  const sourceChunks = text?.trim()
    ? buildRichMarkdownChunks(text, RICH_DRAFT_SOURCE_LIMIT, RICH_DRAFT_RENDERED_LIMIT, false)
    : [];
  const preview = sourceChunks[0]?.markdown ?? "";
  const previewWasTruncated = sourceChunks.length > 1;
  const thinkingText = formatLiveStatus(status, previewWasTruncated, trace);
  const history = renderTraceHistoryMarkdown(
    trace,
    preview ? "final" : "live",
    preview ? STREAMING_FINAL_HISTORY_LIMIT : LIVE_HISTORY_LIMIT,
  );
  const thinking = `<tg-thinking>${escapeTelegramHtml(thinkingText)}</tg-thinking>`;
  const blocks = preview ? [preview, thinking, history] : [history, thinking];

  return { markdown: blocks.filter(Boolean).join("\n\n") };
}

export function buildAssistantRichProgress({
  text,
  status,
  trace,
}: {
  text: string | null;
  status: string;
  trace: RichMessageTraceEntry[];
}): TelegramInputRichMessage {
  const sourceChunks = text?.trim()
    ? buildRichMarkdownChunks(text, RICH_DRAFT_SOURCE_LIMIT, RICH_DRAFT_RENDERED_LIMIT, false)
    : [];
  const preview = sourceChunks[0]?.markdown ?? "";
  const previewWasTruncated = sourceChunks.length > 1;
  const progressText = formatLiveStatus(status, previewWasTruncated, trace);
  const history = renderTraceHistoryMarkdown(
    trace,
    preview ? "final" : "live",
    preview ? STREAMING_FINAL_HISTORY_LIMIT : LIVE_HISTORY_LIMIT,
  );
  const progress = `<blockquote>${escapeTelegramHtml(progressText)}</blockquote>`;
  const blocks = preview ? [preview, progress, history] : [history, progress];

  return { markdown: blocks.filter(Boolean).join("\n\n") };
}

export function buildAssistantRichFinalParts({
  text,
  trace,
}: {
  text: string;
  trace: RichMessageTraceEntry[];
}): AssistantRichMessagePart[] {
  const source = text.trim() || "Done.";
  const chunks = buildRichMarkdownChunks(
    source,
    RICH_MESSAGE_SOURCE_CHUNK_LIMIT,
    RICH_MESSAGE_SAFE_LIMIT,
    true,
  );
  const parts: AssistantRichMessagePart[] = chunks.map((chunk) => ({
    richMessage: { markdown: chunk.markdown },
    fallbackMarkdown: chunk.source,
  }));
  const details = renderTraceHistoryMarkdown(trace, "final", FINAL_HISTORY_LIMIT);
  if (!details) {
    return parts;
  }

  const lastPart = parts.at(-1);
  if (lastPart?.richMessage.markdown !== undefined) {
    const combined = `${lastPart.richMessage.markdown}\n\n${details}`;
    if (combined.length <= RICH_MESSAGE_SAFE_LIMIT) {
      lastPart.richMessage = { markdown: combined };
      return parts;
    }
  }

  parts.push({
    richMessage: { markdown: details },
    fallbackMarkdown: null,
  });
  return parts;
}

export function normalizeAssistantRichMarkdown(
  text: string,
  options: { allowRichHtml?: boolean } = {},
): string {
  const allowRichHtml = options.allowRichHtml ?? true;
  let result = "";
  let cursor = 0;
  let fence: { char: "`" | "~"; length: number } | null = null;

  while (cursor < text.length) {
    const lineStart = text.lastIndexOf("\n", cursor - 1) + 1;
    const beforeCursor = text.slice(lineStart, cursor);
    const atFenceStart = /^ {0,3}$/.test(beforeCursor);
    const char = text[cursor]!;

    if (atFenceStart && (char === "`" || char === "~")) {
      const runLength = countRun(text, cursor, char);
      if (runLength >= 3) {
        if (!fence) {
          fence = { char, length: runLength };
        } else if (fence.char === char && runLength >= fence.length) {
          fence = null;
        }
        result += text.slice(cursor, cursor + runLength);
        cursor += runLength;
        continue;
      }
    }

    if (fence) {
      result += char;
      cursor += 1;
      continue;
    }

    if (char === "`") {
      const runLength = countRun(text, cursor, "`");
      const marker = "`".repeat(runLength);
      const close = text.indexOf(marker, cursor + runLength);
      if (close >= 0) {
        result += text.slice(cursor, close + runLength);
        cursor = close + runLength;
        continue;
      }
    }

    if (char === "[") {
      const link = parseMarkdownLink(text, cursor);
      if (link && isLocalPathTarget(link.target.trim())) {
        if (cursor > 0 && text[cursor - 1] === "!" && result.endsWith("!")) {
          result = result.slice(0, -1);
        }
        result += renderLocalPathMarkdown(link.label, link.target);
        cursor = link.nextIndex;
        continue;
      }
    }

    if (char === "<") {
      const token = readHtmlLikeToken(text, cursor);
      if (token) {
        if (allowRichHtml && isSupportedRichHtmlToken(token.value)) {
          result += token.value;
        } else {
          result += renderEscapedHtmlLikeToken(token.value);
        }
        cursor = token.nextIndex;
        continue;
      }
      result += "&lt;";
      cursor += 1;
      continue;
    }

    result += char;
    cursor += 1;
  }

  return result;
}

export function richMessageDraftId(threadId: string, turnId: string): number {
  let hash = 0x811c9dc5;
  const value = `${threadId}\0${turnId}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash & 0x7fffffff) || 1;
}

function buildRichMarkdownChunks(
  text: string,
  sourceLimit: number,
  renderedLimit: number,
  allowRichHtml: boolean,
): Array<{ source: string; markdown: string }> {
  const initialChunks = splitMarkdownSource(text, sourceLimit);
  const fittedSources = initialChunks.flatMap((chunk) =>
    fitRichMarkdownSource(chunk, renderedLimit, allowRichHtml),
  );
  return fittedSources.map((source) => {
    const allowSourceHtml = shouldAllowSourceRichHtml(source, allowRichHtml);
    return {
      source,
      markdown: normalizeAssistantRichMarkdown(source, { allowRichHtml: allowSourceHtml }),
    };
  });
}

function fitRichMarkdownSource(
  source: string,
  renderedLimit: number,
  allowRichHtml: boolean,
): string[] {
  const allowSourceHtml = shouldAllowSourceRichHtml(source, allowRichHtml);
  const rendered = normalizeAssistantRichMarkdown(source, { allowRichHtml: allowSourceHtml });
  if (rendered.length <= renderedLimit) {
    return [source];
  }
  const nextLimit = Math.max(1_000, Math.floor(source.length / 2));
  const split = splitMarkdownSource(source, nextLimit);
  if (split.length === 1 && split[0] === source) {
    return splitPlainText(source, nextLimit);
  }
  return split.flatMap((part) => fitRichMarkdownSource(part, renderedLimit, allowRichHtml));
}

function splitMarkdownSource(text: string, limit: number): string[] {
  const blocks = markdownBlocks(text);
  const chunks: string[] = [];
  let current = "";
  let currentBlockCount = 0;
  let currentMediaCount = 0;

  const flush = () => {
    const value = current.trim();
    if (value) {
      chunks.push(value);
    }
    current = "";
    currentBlockCount = 0;
    currentMediaCount = 0;
  };

  for (const block of blocks) {
    const lengthFitted = block.length > limit
      ? splitOversizedMarkdownBlock(block, limit)
      : [block];
    for (const fittedBlock of lengthFitted) {
      const units = structuralSourceUnits(fittedBlock);
      for (const [unitIndex, unit] of units.entries()) {
        let separator = current ? (unitIndex === 0 ? "\n\n" : "\n") : "";
        const candidate = `${current}${separator}${unit.text}`;
        const exceedsLimit = candidate.length > limit
          || currentBlockCount + unit.blockCount > RICH_MESSAGE_BODY_BLOCK_LIMIT
          || currentMediaCount + unit.mediaCount > RICH_MESSAGE_MEDIA_SAFE_LIMIT;
        if (current && exceedsLimit) {
          flush();
          separator = "";
        }
        current = `${current}${separator}${unit.text}`;
        currentBlockCount += unit.blockCount;
        currentMediaCount += unit.mediaCount;
      }
    }
  }
  flush();
  return chunks.length > 0 ? chunks : [text.slice(0, limit)];
}

function structuralSourceUnits(
  block: string,
): Array<{ text: string; blockCount: number; mediaCount: number }> {
  const unit = sourceUnit(block);
  if (
    unit.blockCount <= RICH_MESSAGE_BODY_BLOCK_LIMIT
    && unit.mediaCount <= RICH_MESSAGE_MEDIA_SAFE_LIMIT
  ) {
    return [unit];
  }
  if (parseFenceLine(block.split("\n", 1)[0] ?? "")) {
    return [{ text: block, blockCount: 1, mediaCount: 0 }];
  }
  const tableUnits = splitOversizedMarkdownTable(block);
  if (tableUnits) {
    return tableUnits.map(sourceUnit);
  }
  return block
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => splitMediaHeavyLine(line).map(sourceUnit));
}

function splitOversizedMarkdownTable(block: string): string[] | null {
  const lines = block.split("\n").filter((line) => line.trim());
  if (lines.length < 2 || !isMarkdownTableSeparator(lines[1]!)) {
    return null;
  }
  const header = lines.slice(0, 2);
  const rowsPerTable = RICH_MESSAGE_BODY_BLOCK_LIMIT - header.length;
  const tables: string[] = [];
  for (let cursor = 2; cursor < lines.length; cursor += rowsPerTable) {
    tables.push([...header, ...lines.slice(cursor, cursor + rowsPerTable)].join("\n"));
  }
  return tables;
}

function isMarkdownTableSeparator(line: string): boolean {
  let value = line.trim();
  if (value.startsWith("|")) {
    value = value.slice(1);
  }
  if (value.endsWith("|")) {
    value = value.slice(0, -1);
  }
  const cells = value.split("|").map((cell) => cell.trim());
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function sourceUnit(text: string): { text: string; blockCount: number; mediaCount: number } {
  if (parseFenceLine(text.split("\n", 1)[0] ?? "")) {
    return { text, blockCount: 1, mediaCount: 0 };
  }
  const nonEmptyLines = text.split("\n").filter((line) => line.trim()).length;
  return {
    text,
    blockCount: Math.max(1, nonEmptyLines),
    mediaCount: countMarkdownMedia(text) + countRichHtmlMedia(text),
  };
}

function splitMediaHeavyLine(line: string): string[] {
  if (countMarkdownMedia(line) <= RICH_MESSAGE_MEDIA_SAFE_LIMIT) {
    return [line];
  }
  const parts = line.split(/(?=!\[[^\]]*\]\()/).filter(Boolean);
  return parts.length > 1 ? parts : [line];
}

function shouldAllowSourceRichHtml(source: string, requested: boolean): boolean {
  if (!requested) {
    return false;
  }
  const explicitBlocks = countRichHtmlBlocks(source);
  const lineBlocks = sourceUnit(source).blockCount;
  return explicitBlocks + lineBlocks <= RICH_MESSAGE_BODY_BLOCK_LIMIT
    && countRichHtmlMedia(source) <= RICH_MESSAGE_MEDIA_SAFE_LIMIT;
}

function countMarkdownMedia(text: string): number {
  return text.match(/!\[[^\]]*\]\([^)]+\)/g)?.length ?? 0;
}

function countRichHtmlMedia(text: string): number {
  return text.match(/<(?:img|video|audio)\b/gi)?.length ?? 0;
}

function countRichHtmlBlocks(text: string): number {
  return text.match(
    /<(?:aside|blockquote|details|figure|footer|h[1-6]|hr|li|ol|p|pre|table|tr|ul|tg-collage|tg-map|tg-math-block|tg-slideshow)\b/gi,
  )?.length ?? 0;
}

function markdownBlocks(text: string): string[] {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const blocks: string[] = [];
  let cursor = 0;

  while (cursor < lines.length) {
    while (cursor < lines.length && !lines[cursor]!.trim()) {
      cursor += 1;
    }
    if (cursor >= lines.length) {
      break;
    }

    const opening = parseFenceLine(lines[cursor]!);
    const start = cursor;
    if (opening) {
      cursor += 1;
      while (cursor < lines.length) {
        const closing = parseFenceLine(lines[cursor]!);
        cursor += 1;
        if (closing && closing.char === opening.char && closing.length >= opening.length) {
          break;
        }
      }
    } else {
      cursor += 1;
      while (cursor < lines.length && lines[cursor]!.trim()) {
        cursor += 1;
      }
    }
    blocks.push(lines.slice(start, cursor).join("\n"));
  }
  return blocks;
}

function splitOversizedMarkdownBlock(block: string, limit: number): string[] {
  const lines = block.split("\n");
  const opening = parseFenceLine(lines[0] ?? "");
  if (!opening) {
    return splitPlainText(block, limit);
  }

  const lastFence = parseFenceLine(lines.at(-1) ?? "");
  const hasClosingFence = Boolean(
    lastFence && lastFence.char === opening.char && lastFence.length >= opening.length,
  );
  const content = lines.slice(1, hasClosingFence ? -1 : undefined).join("\n");
  const closingMarker = opening.char.repeat(opening.length);
  const overhead = lines[0]!.length + closingMarker.length + 2;
  const contentLimit = Math.max(1_000, limit - overhead);
  return splitPlainText(content, contentLimit).map(
    (part) => `${lines[0]}\n${part}\n${closingMarker}`,
  );
}

function splitPlainText(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    const newline = window.lastIndexOf("\n");
    const space = window.lastIndexOf(" ");
    const splitAt = newline > limit * 0.25
      ? newline
      : space > limit * 0.25
        ? space
        : limit;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).replace(/^\s+/, "");
  }
  if (remaining.trim()) {
    chunks.push(remaining.trim());
  }
  return chunks;
}

function renderTraceHistoryMarkdown(
  trace: RichMessageTraceEntry[],
  mode: "live" | "final",
  limit: number,
): string {
  const loops = groupTraceByPreamble(trace);
  if (loops.length === 0) {
    return "";
  }

  for (const profile of TRACE_RENDER_PROFILES) {
    const rendered = wrapTraceHistory(renderTraceLoopsMarkdown(loops, profile), mode);
    if (rendered.length <= limit) {
      return rendered;
    }
  }

  return renderBoundedTraceHistory(loops, mode, limit);
}

function groupTraceByPreamble(trace: RichMessageTraceEntry[]): TraceLoop[] {
  const loops: TraceLoop[] = [];
  let current: TraceLoop | null = null;
  for (const entry of trace) {
    if (!entry.text.trim()) {
      continue;
    }
    if (entry.label === "Preamble") {
      current = { preamble: entry, tools: [] };
      loops.push(current);
      continue;
    }
    if (!current) {
      current = { preamble: null, tools: [] };
      loops.push(current);
    }
    current.tools.push(entry);
  }
  return loops;
}

function renderTraceLoopsMarkdown(loops: TraceLoop[], profile: TraceRenderProfile): string {
  return loops
    .map((loop) => renderTraceLoopMarkdown(loop, profile))
    .filter(Boolean)
    .join("\n\n");
}

function renderTraceLoopMarkdown(loop: TraceLoop, profile: TraceRenderProfile): string {
  const preamble = loop.preamble
    ? normalizeAssistantRichMarkdown(
      truncateMultiline(loop.preamble.text, profile.preambleLimit),
      { allowRichHtml: false },
    )
    : "";
  const tools = renderToolLoopHtml(loop.tools, profile);
  return [preamble, tools].filter(Boolean).join("\n\n");
}

function renderToolLoopHtml(
  tools: RichMessageTraceEntry[],
  profile: TraceRenderProfile,
): string {
  const latest = tools.at(-1);
  if (!latest) {
    return "";
  }

  const summaryLabel = escapeTelegramHtml(displayToolLabel(latest.label));
  const summaryText = escapeTelegramHtml(
    firstTraceLine(latest.text, profile.toolSummaryLimit),
  );
  const items = tools.map((entry) => {
    const label = escapeTelegramHtml(displayToolLabel(entry.label));
    const text = escapeTelegramHtml(
      truncateMultiline(entry.text, profile.toolDetailLimit),
    ).replaceAll("\n", "<br>");
    return `<li><b>${label}</b> ${text}</li>`;
  });
  return [
    `<details><summary><b>${summaryLabel}</b> ${summaryText}</summary>`,
    "<ul>",
    ...items,
    "</ul>",
    "</details>",
  ].join("");
}

function renderBoundedTraceHistory(
  loops: TraceLoop[],
  mode: "live" | "final",
  limit: number,
): string {
  const profile = TRACE_RENDER_PROFILES.at(-1)!;
  const omittedNotice = "_Earlier execution history was omitted because this turn exceeded Telegram's rich-message limit._";
  const selected: string[] = [];

  for (let index = loops.length - 1; index >= 0; index -= 1) {
    let block = renderTraceLoopMarkdown(loops[index]!, profile);
    if (selected.length === 0 && wrapTraceHistory(block, mode).length > limit) {
      block = renderTraceLoopWithinLimit(loops[index]!, profile, limit, mode);
    }
    const candidate = [index > 0 ? omittedNotice : "", block, ...selected]
      .filter(Boolean)
      .join("\n\n");
    if (wrapTraceHistory(candidate, mode).length > limit) {
      break;
    }
    selected.unshift(block);
    if (index === 0) {
      return wrapTraceHistory(selected.join("\n\n"), mode);
    }
  }

  return wrapTraceHistory([omittedNotice, ...selected].join("\n\n"), mode);
}

function renderTraceLoopWithinLimit(
  loop: TraceLoop,
  profile: TraceRenderProfile,
  limit: number,
  mode: "live" | "final",
): string {
  let tools = loop.tools;
  let omitted = 0;
  while (tools.length > 1) {
    const candidateLoop: TraceLoop = {
      preamble: loop.preamble,
      tools: omitted > 0
        ? [{ label: "History", text: `${omitted} earlier tool calls omitted.` }, ...tools]
        : tools,
    };
    const rendered = renderTraceLoopMarkdown(candidateLoop, profile);
    if (wrapTraceHistory(rendered, mode).length <= limit) {
      return rendered;
    }
    tools = tools.slice(1);
    omitted += 1;
  }

  const compactLoop: TraceLoop = {
    preamble: loop.preamble
      ? { ...loop.preamble, text: truncateMultiline(loop.preamble.text, 120) }
      : null,
    tools: tools.length > 0
      ? [{ label: "History", text: `${omitted} earlier tool calls omitted.` }, ...tools]
      : [],
  };
  return renderTraceLoopMarkdown(compactLoop, {
    preambleLimit: 120,
    toolSummaryLimit: 80,
    toolDetailLimit: 60,
  });
}

function wrapTraceHistory(content: string, mode: "live" | "final"): string {
  if (!content || mode === "live") {
    return content;
  }
  return `<details><summary>Work details</summary>\n\n${content}\n\n</details>`;
}

function displayToolLabel(label: string): string {
  return truncateSingleLine(label, 40) || "Tool";
}

function firstTraceLine(text: string, limit: number): string {
  const first = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? text;
  return truncateSingleLine(first, limit);
}

function formatLiveStatus(
  status: string,
  previewWasTruncated: boolean,
  trace: RichMessageTraceEntry[],
): string {
  const normalized = truncateSingleLine(status, previewWasTruncated ? 145 : 180);
  const coveredByTrace = normalized
    ? statusMatchesLatestTrace(normalized, trace.at(-1))
    : false;
  const meaningful = !normalized
    || /^(?:thinking|working on it|working on the task)$/i.test(normalized)
    || coveredByTrace
    ? "Working on the task"
    : normalized;
  return previewWasTruncated ? `${meaningful} (preview capped)` : meaningful;
}

function statusMatchesLatestTrace(
  status: string,
  latest: RichMessageTraceEntry | undefined,
): boolean {
  if (!latest) {
    return false;
  }
  return latest.text
    .split(/\r?\n/)
    .map((line) => truncateSingleLine(line, status.length))
    .some((line) => line === status);
}

function parseFenceLine(line: string): { char: "`" | "~"; length: number } | null {
  const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
  if (!match) {
    return null;
  }
  return {
    char: match[1]![0] as "`" | "~",
    length: match[1]!.length,
  };
}

function countRun(text: string, start: number, char: string): number {
  let cursor = start;
  while (text[cursor] === char) {
    cursor += 1;
  }
  return cursor - start;
}

function parseMarkdownLink(
  text: string,
  start: number,
): { label: string; target: string; nextIndex: number } | null {
  const closeLabel = text.indexOf("](", start + 1);
  if (closeLabel <= start + 1) {
    return null;
  }

  let depth = 1;
  let cursor = closeLabel + 2;
  while (cursor < text.length) {
    if (text[cursor] === "(") {
      depth += 1;
    } else if (text[cursor] === ")") {
      depth -= 1;
      if (depth === 0) {
        return {
          label: text.slice(start + 1, closeLabel),
          target: text.slice(closeLabel + 2, cursor),
          nextIndex: cursor + 1,
        };
      }
    }
    cursor += 1;
  }
  return null;
}

function isLocalPathTarget(target: string): boolean {
  return /^(?:\/|~\/|\.{1,2}\/|[a-zA-Z]:[\\/])/.test(target);
}

function renderLocalPathMarkdown(label: string, target: string): string {
  const trimmedTarget = target.trim();
  const lineMatch = /:(\d+)(?::\d+)?$/.exec(trimmedTarget);
  const lineSuffix = lineMatch ? `:${lineMatch[1]}` : "";
  const display = lineSuffix && !label.endsWith(lineSuffix) ? `${label}${lineSuffix}` : label;
  return `\`${display.replaceAll("`", "'")}\``;
}

function readHtmlLikeToken(
  text: string,
  start: number,
): { value: string; nextIndex: number } | null {
  const end = text.indexOf(">", start + 1);
  if (end < 0 || end - start > 2_000 || text.slice(start, end).includes("\n")) {
    return null;
  }
  return { value: text.slice(start, end + 1), nextIndex: end + 1 };
}

function isSupportedRichHtmlToken(token: string): boolean {
  const match = /^<\/?\s*([a-z][a-z0-9-]*)\b/i.exec(token);
  return Boolean(match && RICH_HTML_TAGS.has(match[1]!.toLowerCase()));
}

function renderEscapedHtmlLikeToken(token: string): string {
  const value = token.slice(1, -1);
  if (/^https?:\/\/[^\s]+$/i.test(value)) {
    return `[${value}](${value})`;
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return `[${value}](mailto:${value})`;
  }
  return escapeTelegramHtml(token);
}

function truncateSingleLine(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3)}...`;
}

function truncateMultiline(text: string, limit: number): string {
  const normalized = text.trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3).trimEnd()}...`;
}
