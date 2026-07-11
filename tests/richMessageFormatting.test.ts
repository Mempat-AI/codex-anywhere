import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAssistantRichDraft,
  buildAssistantRichFinalParts,
  buildAssistantRichProgress,
  normalizeAssistantRichMarkdown,
  richMessageDraftId,
  RICH_MESSAGE_TEXT_LIMIT,
} from "../src/richMessageFormatting.js";

test("normalizeAssistantRichMarkdown preserves native rich Markdown features", () => {
  const source = [
    "# Result",
    "",
    "- [x] tests",
    "- formula: $E = mc^2$",
    "",
    "| Model | Role |",
    "| --- | --- |",
    "| sol | **flagship** |",
    "",
    "![chart](https://example.com/chart.png)",
    "",
    "<details><summary>More</summary>Native details</details>",
  ].join("\n");

  assert.equal(normalizeAssistantRichMarkdown(source), source);
});

test("normalizeAssistantRichMarkdown compacts local links and escapes unsupported tags", () => {
  const source = [
    "See [page.tsx](/Users/test/app/page.tsx:42).",
    "Slack <@U123> and generic <T> stay literal.",
    "Code: `<T>`.",
  ].join("\n");
  const markdown = normalizeAssistantRichMarkdown(source);

  assert.match(markdown, /`page\.tsx:42`/);
  assert.match(markdown, /Slack &lt;@U123&gt;/);
  assert.match(markdown, /generic &lt;T&gt;/);
  assert.match(markdown, /Code: `<T>`/);
  assert.doesNotMatch(markdown, /Users\/test/);
});

test("buildAssistantRichDraft collapses prior work as soon as the final answer starts", () => {
  const draft = buildAssistantRichDraft({
    text: "## Answer\n\nPartial <T>",
    status: "Running tests",
    trace: [{ label: "Tool", text: "pnpm test\n174 passed" }],
  });

  assert.ok(draft.markdown);
  assert.match(draft.markdown, /^## Answer/);
  assert.match(draft.markdown, /Partial &lt;T&gt;/);
  assert.match(draft.markdown, /<tg-thinking>Running tests<\/tg-thinking>/);
  assert.match(draft.markdown, /<details><summary>Work details<\/summary>/);
  assert.match(draft.markdown, /<summary><b>Tool<\/b> pnpm test<\/summary>/);
  assert.match(draft.markdown, /<li><b>Tool<\/b> pnpm test<br>174 passed<\/li>/);
  assert.doesNotMatch(draft.markdown, /<pre>/);
  assert.ok(draft.markdown.length < RICH_MESSAGE_TEXT_LIMIT);
});

test("buildAssistantRichDraft keeps every tool in the current preamble loop", () => {
  const draft = buildAssistantRichDraft({
    text: null,
    status: "Thinking",
    trace: [
      { label: "Preamble", text: "I will inspect the implementation." },
      ...Array.from(
        { length: 8 },
        (_, index) => ({ label: "Tool", text: `step ${index + 1}` }),
      ),
    ],
  });

  const markdown = draft.markdown ?? "";
  assert.match(markdown, /^I will inspect the implementation\./);
  assert.match(markdown, /<tg-thinking>Working on the task<\/tg-thinking>/);
  assert.match(markdown, /<summary><b>Tool<\/b> step 8<\/summary>/);
  assert.equal(markdown.match(/<li>/g)?.length, 8);
  assert.match(markdown, /step 1/);
  assert.match(markdown, /step 8/);
  assert.doesNotMatch(markdown, /Work details/);
});

test("buildAssistantRichDraft appends preamble loops and gives each loop its own tool disclosure", () => {
  const draft = buildAssistantRichDraft({
    text: null,
    status: "Preparing the response",
    trace: [
      { label: "Preamble", text: "First I will inspect the code." },
      { label: "Tool", text: "read package.json" },
      { label: "Tool", text: "read src/bridge.ts" },
      { label: "Preamble", text: "The event flow is clear; now I will test it." },
      { label: "Tool", text: "run focused tests" },
      { label: "Tool", text: "run full tests" },
    ],
  });

  const markdown = draft.markdown ?? "";
  const firstPreamble = markdown.indexOf("First I will inspect the code.");
  const firstLoop = markdown.indexOf("<summary><b>Tool</b> read src/bridge.ts</summary>");
  const secondPreamble = markdown.indexOf("The event flow is clear; now I will test it.");
  const secondLoop = markdown.indexOf("<summary><b>Tool</b> run full tests</summary>");
  assert.ok(firstPreamble >= 0);
  assert.ok(firstPreamble < firstLoop);
  assert.ok(firstLoop < secondPreamble);
  assert.ok(secondPreamble < secondLoop);
  assert.equal(markdown.match(/<details>/g)?.length, 2);
  assert.equal(markdown.match(/<li>/g)?.length, 4);
});

test("buildAssistantRichProgress uses editable rich blocks without draft-only thinking", () => {
  const progress = buildAssistantRichProgress({
    text: "Partial answer",
    status: "Running tests",
    trace: [{ label: "Tool", text: "pnpm test" }],
  });

  assert.ok(progress.markdown);
  assert.match(progress.markdown, /^Partial answer/);
  assert.match(progress.markdown, /<blockquote>Running tests<\/blockquote>/);
  assert.match(progress.markdown, /<details>/);
  assert.doesNotMatch(progress.markdown, /tg-thinking/);
});

test("buildAssistantRichFinalParts keeps the answer and execution details together", () => {
  const parts = buildAssistantRichFinalParts({
    text: "| Model | Role |\n| --- | --- |\n| sol | flagship |",
    trace: [{ label: "Files", text: "Updated src/bridge.ts" }],
  });

  assert.equal(parts.length, 1);
  assert.ok(parts[0]!.richMessage.markdown);
  assert.match(parts[0]!.richMessage.markdown, /^\| Model \| Role \|/);
  assert.match(parts[0]!.richMessage.markdown, /<summary>Work details<\/summary>/);
  assert.equal(parts[0]!.fallbackMarkdown, "| Model | Role |\n| --- | --- |\n| sol | flagship |");
});

test("buildAssistantRichFinalParts nests every preamble and its tool disclosure under work details", () => {
  const parts = buildAssistantRichFinalParts({
    text: "Done.",
    trace: [
      { label: "Preamble", text: "I will inspect the project." },
      { label: "Tool", text: "read src/bridge.ts" },
      { label: "Tool", text: "pnpm test passed" },
      { label: "Preamble", text: "The tests pass; I will summarize." },
      { label: "Files", text: "Updated src/bridge.ts" },
    ],
  });

  const markdown = parts[0]!.richMessage.markdown ?? "";
  assert.match(markdown, /^Done\.\n\n<details><summary>Work details<\/summary>/);
  assert.match(markdown, /I will inspect the project\./);
  assert.match(markdown, /The tests pass; I will summarize\./);
  assert.match(markdown, /read src\/bridge\.ts/);
  assert.match(markdown, /pnpm test passed/);
  assert.match(markdown, /Updated src\/bridge\.ts/);
  assert.equal(markdown.match(/<details>/g)?.length, 3);
  assert.equal(markdown.match(/<li>/g)?.length, 3);
});

test("buildAssistantRichFinalParts splits oversized fenced code into valid rich messages", () => {
  const body = "const value = 1;\n".repeat(3_000);
  const parts = buildAssistantRichFinalParts({
    text: `\`\`\`ts\n${body}\`\`\``,
    trace: [],
  });

  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.ok(part.richMessage.markdown);
    assert.match(part.richMessage.markdown, /^```ts\n/);
    assert.match(part.richMessage.markdown, /\n```$/);
    assert.ok(part.richMessage.markdown.length < RICH_MESSAGE_TEXT_LIMIT);
  }
});

test("buildAssistantRichFinalParts respects Telegram block limits for long lists", () => {
  const text = Array.from({ length: 850 }, (_, index) => `- item ${index + 1}`).join("\n");
  const parts = buildAssistantRichFinalParts({ text, trace: [] });

  assert.ok(parts.length >= 3);
  for (const part of parts) {
    const markdown = part.richMessage.markdown ?? "";
    assert.ok((markdown.match(/^- item /gm)?.length ?? 0) <= 400);
  }
});

test("buildAssistantRichFinalParts reserves block capacity for execution details", () => {
  const text = Array.from({ length: 380 }, (_, index) => `- item ${index + 1}`).join("\n");
  const trace = Array.from(
    { length: 40 },
    (_, index) => ({ label: `Tool ${index + 1}`, text: "done" }),
  );
  const parts = buildAssistantRichFinalParts({ text, trace });

  assert.equal(parts.length, 1);
  const markdown = parts[0]!.richMessage.markdown ?? "";
  const estimatedBlocks = (markdown.match(/^- item /gm)?.length ?? 0)
    + (markdown.match(/<li>/g)?.length ?? 0)
    + (markdown.match(/<ul>/g)?.length ?? 0)
    + (markdown.match(/<details>/g)?.length ?? 0);
  assert.ok(estimatedBlocks < 500);
  assert.match(markdown, /<summary>Work details<\/summary>/);
  assert.equal(markdown.match(/<li>/g)?.length, 40);
  assert.match(markdown, /Tool 1/);
  assert.match(markdown, /Tool 40/);
});

test("buildAssistantRichFinalParts repeats table headers when a large table is split", () => {
  const rows = Array.from({ length: 850 }, (_, index) => `| ${index + 1} | value |`);
  const text = ["| ID | Value |", "| --- | --- |", ...rows].join("\n");
  const parts = buildAssistantRichFinalParts({ text, trace: [] });

  assert.ok(parts.length >= 3);
  for (const part of parts) {
    const markdown = part.richMessage.markdown ?? "";
    assert.match(markdown, /^\| ID \| Value \|\n\| --- \| --- \|/);
    assert.ok(markdown.split("\n").length <= 400);
  }
});

test("buildAssistantRichFinalParts caps media blocks per rich message", () => {
  const text = Array.from(
    { length: 90 },
    (_, index) => `![image ${index + 1}](https://example.com/${index + 1}.png)`,
  ).join("\n");
  const parts = buildAssistantRichFinalParts({ text, trace: [] });

  assert.ok(parts.length >= 3);
  for (const part of parts) {
    const markdown = part.richMessage.markdown ?? "";
    assert.ok((markdown.match(/!\[image /g)?.length ?? 0) <= 40);
  }
});

test("richMessageDraftId is deterministic, positive, and turn-specific", () => {
  const first = richMessageDraftId("thread-1", "turn-1");
  assert.equal(first, richMessageDraftId("thread-1", "turn-1"));
  assert.notEqual(first, richMessageDraftId("thread-1", "turn-2"));
  assert.ok(first > 0);
});
