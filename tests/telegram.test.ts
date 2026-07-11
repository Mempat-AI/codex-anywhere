import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TelegramBotApi } from "../src/telegram.js";

test("sendMessage can reply to the source Telegram message", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedPayload: Record<string, unknown> | null = null;
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ ok: true, result: { message_id: 9 } });
  };
  try {
    const api = new TelegramBotApi("token");
    const result = await api.sendMessage(42, "working", undefined, "HTML", 123);

    assert.equal(result.message_id, 9);
    assert.equal(requestedUrl, "https://api.telegram.org/bottoken/sendMessage");
    assert.deepEqual(requestedPayload, {
      chat_id: 42,
      text: "working",
      parse_mode: "HTML",
      reply_parameters: {
        message_id: 123,
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendRichMessage sends InputRichMessage HTML", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedPayload: Record<string, unknown> | null = null;
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ ok: true, result: { message_id: 11 } });
  };
  try {
    const api = new TelegramBotApi("token");
    const result = await api.sendRichMessage(
      42,
      { html: "<table><tr><td>x</td></tr></table>" },
      undefined,
      123,
    );

    assert.equal(result.message_id, 11);
    assert.equal(requestedUrl, "https://api.telegram.org/bottoken/sendRichMessage");
    assert.deepEqual(requestedPayload, {
      chat_id: 42,
      rich_message: {
        html: "<table><tr><td>x</td></tr></table>",
      },
      reply_parameters: {
        message_id: 123,
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendRichMessageDraft streams InputRichMessage Markdown", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedPayload: Record<string, unknown> | null = null;
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ ok: true, result: true });
  };
  try {
    const api = new TelegramBotApi("token");
    const result = await api.sendRichMessageDraft(
      42,
      991,
      { markdown: "Working\n\n<tg-thinking>Thinking</tg-thinking>" },
      7,
      { retry: false },
    );

    assert.equal(result, true);
    assert.equal(requestedUrl, "https://api.telegram.org/bottoken/sendRichMessageDraft");
    assert.deepEqual(requestedPayload, {
      chat_id: 42,
      draft_id: 991,
      rich_message: {
        markdown: "Working\n\n<tg-thinking>Thinking</tg-thinking>",
      },
      message_thread_id: 7,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("editRichMessage edits a message using structured content", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedPayload: Record<string, unknown> | null = null;
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ ok: true, result: { message_id: 11 } });
  };
  try {
    const api = new TelegramBotApi("token");
    await api.editRichMessage(42, 11, { markdown: "# Updated" });

    assert.equal(requestedUrl, "https://api.telegram.org/bottoken/editMessageText");
    assert.deepEqual(requestedPayload, {
      chat_id: 42,
      message_id: 11,
      rich_message: { markdown: "# Updated" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendMessage retries once after Telegram retry_after", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return Response.json(
        {
          ok: false,
          description: "Too Many Requests: retry after 0.01",
          parameters: { retry_after: 0.01 },
        },
        { status: 429 },
      );
    }
    return Response.json({ ok: true, result: { message_id: 10 } });
  };
  try {
    const api = new TelegramBotApi("token");
    const result = await api.sendMessage(42, "working");

    assert.equal(result.message_id, 10);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("editMessageText can skip blocking retry for best-effort updates", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json(
      {
        ok: false,
        description: "Too Many Requests: retry after 5",
        parameters: { retry_after: 5 },
      },
      { status: 429 },
    );
  };
  try {
    const api = new TelegramBotApi("token");
    await assert.rejects(
      api.editMessageText(42, 1, "Thinking", undefined, "HTML", { retry: false }),
      /Too Many Requests/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("nonblocking rate limits still cool down later Telegram requests", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let getMeStartedAt = 0;
  globalThis.fetch = async (input) => {
    calls += 1;
    if (String(input).endsWith("/editMessageText")) {
      return Response.json(
        {
          ok: false,
          description: "Too Many Requests: retry after 0.03",
          parameters: { retry_after: 0.03 },
        },
        { status: 429 },
      );
    }
    getMeStartedAt = Date.now();
    return Response.json({ ok: true, result: { id: 1, is_bot: true, first_name: "bot" } });
  };
  try {
    const api = new TelegramBotApi("token");
    await assert.rejects(
      api.editMessageText(42, 1, "Thinking", undefined, "HTML", { retry: false }),
      /Too Many Requests/,
    );

    const beforeGetMe = Date.now();
    await api.getMe();

    assert.equal(calls, 2);
    assert.ok(getMeStartedAt - beforeGetMe >= 20);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendDocument uploads a local file with Telegram multipart form-data", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-anywhere-telegram-upload-"));
  const filePath = path.join(tempDir, "report.txt");
  await fs.writeFile(filePath, "hello", "utf8");
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedBody: BodyInit | null | undefined;
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedBody = init?.body;
    return Response.json({ ok: true, result: { message_id: 7 } });
  };
  try {
    const api = new TelegramBotApi("token");
    const result = await api.sendDocument(42, filePath, "report");

    assert.equal(result.message_id, 7);
    assert.equal(requestedUrl, "https://api.telegram.org/bottoken/sendDocument");
    assert.ok(requestedBody instanceof FormData);
    assert.equal(requestedBody.get("chat_id"), "42");
    assert.equal(requestedBody.get("caption"), "report");
    const document = requestedBody.get("document");
    assert.ok(document instanceof Blob);
    assert.equal((document as File).name, "report.txt");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendPhoto uploads a local image with Telegram multipart form-data", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-anywhere-telegram-photo-"));
  const filePath = path.join(tempDir, "image.png");
  await fs.writeFile(filePath, Buffer.from([137, 80, 78, 71]));
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedBody: BodyInit | null | undefined;
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedBody = init?.body;
    return Response.json({ ok: true, result: { message_id: 8 } });
  };
  try {
    const api = new TelegramBotApi("token");
    const result = await api.sendPhoto(42, filePath, "image", 99);

    assert.equal(result.message_id, 8);
    assert.equal(requestedUrl, "https://api.telegram.org/bottoken/sendPhoto");
    assert.ok(requestedBody instanceof FormData);
    assert.equal(requestedBody.get("chat_id"), "42");
    assert.equal(requestedBody.get("caption"), "image");
    assert.equal(requestedBody.get("reply_parameters"), JSON.stringify({ message_id: 99 }));
    const photo = requestedBody.get("photo");
    assert.ok(photo instanceof Blob);
    assert.equal((photo as File).name, "image.png");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
