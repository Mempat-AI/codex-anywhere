import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TelegramBotApi } from "../src/telegram.js";

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
    const result = await api.sendPhoto(42, filePath, "image");

    assert.equal(result.message_id, 8);
    assert.equal(requestedUrl, "https://api.telegram.org/bottoken/sendPhoto");
    assert.ok(requestedBody instanceof FormData);
    assert.equal(requestedBody.get("chat_id"), "42");
    assert.equal(requestedBody.get("caption"), "image");
    const photo = requestedBody.get("photo");
    assert.ok(photo instanceof Blob);
    assert.equal((photo as File).name, "image.png");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
