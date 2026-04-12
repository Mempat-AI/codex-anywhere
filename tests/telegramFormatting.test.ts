import assert from "node:assert/strict";
import test from "node:test";

import {
  escapeTelegramHtml,
  formatApprovalPromptHtml,
  formatCommandCompletionHtml,
  formatFileChangeCompletionHtml,
  formatPendingInputActionHtml,
  formatTurnCompletionHtml,
  renderAssistantTextHtml,
} from "../src/telegramFormatting.js";

test("escapeTelegramHtml escapes reserved HTML characters", () => {
  assert.equal(escapeTelegramHtml("<a&b>"), "&lt;a&amp;b&gt;");
});

test("formatCommandCompletionHtml stays concise on success", () => {
  const html = formatCommandCompletionHtml({
    command: "rg -n 'stopTypingIndicator' codex-anywhere/src/bridge.ts",
    status: "completed",
    exitCode: 0,
    aggregatedOutput: "done <ok>",
  }, /*verbose*/ false);

  assert.match(html, /<b>Searched codebase<\/b>/);
  assert.match(html, /stopTypingIndicator/);
  assert.doesNotMatch(html, /rg -n/);
  assert.doesNotMatch(html, /done &lt;ok&gt;/);
  // No "details:" or "status:" labels on a compact success card
  assert.doesNotMatch(html, /details:/);
  assert.doesNotMatch(html, /status:/);
});

test("formatCommandCompletionHtml shows detail on failure", () => {
  const html = formatCommandCompletionHtml({
    command: "echo <hello>",
    status: "failed",
    exitCode: 1,
    aggregatedOutput: "done <ok>",
  }, /*verbose*/ false);

  assert.match(html, /<code>echo &lt;hello&gt;<\/code>/);
  assert.match(html, /<pre>done &lt;ok&gt;<\/pre>/);
});

test("formatFileChangeCompletionHtml stays concise on success", () => {
  const html = formatFileChangeCompletionHtml({
    status: "completed",
    changes: [{ path: "src/app.ts" }, { path: "README.md" }],
  }, /*verbose*/ false);

  // Compact success: just a bold summary, no labels
  assert.match(html, /<b>Updated src\/app\.ts and 1 more file<\/b>/);
  assert.doesNotMatch(html, /details:/);
  assert.doesNotMatch(html, /status:/);
  assert.doesNotMatch(html, /files:/);
});

test("formatFileChangeCompletionHtml keeps paths on non-success", () => {
  const html = formatFileChangeCompletionHtml({
    status: "failed",
    changes: [{ path: "src/app.ts" }, { path: "README.md" }],
  }, /*verbose*/ false);

  assert.match(html, /<code>src\/app\.ts<\/code>/);
  assert.match(html, /<code>README\.md<\/code>/);
});

test("formatApprovalPromptHtml escapes dangerous command text", () => {
  const html = formatApprovalPromptHtml(
    "item/commandExecution/requestApproval",
    { command: "cat <secret>", cwd: "/tmp", reason: "test" },
    new Map(),
  );

  assert.match(html, /Approve command\?/);
  assert.match(html, /<code>cat &lt;secret&gt;<\/code>/);
});

test("formatApprovalPromptHtml omits empty reason", () => {
  const html = formatApprovalPromptHtml(
    "item/commandExecution/requestApproval",
    { command: "ls", cwd: "/tmp", reason: "" },
    new Map(),
  );

  assert.doesNotMatch(html, /reason/);
});

test("formatTurnCompletionHtml returns null on success", () => {
  const result = formatTurnCompletionHtml("completed", null);
  assert.equal(result, null);
});

test("formatTurnCompletionHtml shows failure details", () => {
  const html = formatTurnCompletionHtml("failed", "boom <bad>");
  assert.ok(html !== null);
  assert.match(html, /Turn failed/);
  assert.match(html, /boom &lt;bad&gt;/);
});

test("formatTurnCompletionHtml shows non-completed status", () => {
  const html = formatTurnCompletionHtml("interrupted", null);
  assert.ok(html !== null);
  assert.match(html, /Turn interrupted/);
});

test("formatPendingInputActionHtml shows queued message preview", () => {
  const html = formatPendingInputActionHtml("queued", [
    { type: "text", text: "all good?" },
  ]);
  assert.match(html, /<b>Queued<\/b>/);
  assert.match(html, /all good\?/);
});

test("formatPendingInputActionHtml shows attachments summary", () => {
  const html = formatPendingInputActionHtml("starting", [
    { type: "text", text: "look at this" },
    { type: "localImage", path: "/tmp/x.png" },
    { type: "mention", name: "README.md", path: "/tmp/README.md" },
  ]);
  assert.match(html, /\+1 image, 1 mention/);
});

test("formatPendingInputActionHtml shows armed state without preview", () => {
  const html = formatPendingInputActionHtml("armed");
  assert.match(html, /<b>Queue Next armed<\/b>/);
});

test("renderAssistantTextHtml renders inline code spans", () => {
  const html = renderAssistantTextHtml("Use `pwd` here.");
  assert.equal(html, "Use <code>pwd</code> here.");
});

test("renderAssistantTextHtml renders fenced code blocks", () => {
  const html = renderAssistantTextHtml("```ts\nconst x = 1 < 2;\n```");
  assert.equal(html, "<pre>const x = 1 &lt; 2;\n</pre>");
});

test("renderAssistantTextHtml tolerates unfinished fences during streaming", () => {
  const html = renderAssistantTextHtml("```ts\nconst x = 1 < 2;");
  assert.equal(html, "<pre>const x = 1 &lt; 2;</pre>");
});

test("renderAssistantTextHtml renders bold markdown", () => {
  const html = renderAssistantTextHtml("This is **important** text.");
  assert.equal(html, "This is <b>important</b> text.");
});

test("renderAssistantTextHtml renders ATX headings as bold", () => {
  const html = renderAssistantTextHtml("## Summary\nsome text");
  assert.equal(html, "<b>Summary</b>\nsome text");
});

test("renderAssistantTextHtml does not bold inside code fences", () => {
  const html = renderAssistantTextHtml("```\n**not bold**\n```");
  assert.match(html, /\*\*not bold\*\*/);
  assert.doesNotMatch(html, /<b>/);
});

test("renderAssistantTextHtml escapes HTML in bold content", () => {
  const html = renderAssistantTextHtml("**<script>**");
  assert.equal(html, "<b>&lt;script&gt;</b>");
});
