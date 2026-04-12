import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PersistentSessionOwnershipRegistry } from "../src/sessionOwnership.js";

test("PersistentSessionOwnershipRegistry survives process recreation", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-anywhere-session-ownership-"));
  const filePath = path.join(tempDir, "session-ownership.json");

  const registryA = new PersistentSessionOwnershipRegistry(filePath);
  assert.deepEqual(registryA.claim("bot-a", "thread-1"), { ok: true });

  const registryB = new PersistentSessionOwnershipRegistry(filePath);
  assert.equal(registryB.ownerOf("thread-1"), "bot-a");
  assert.deepEqual(registryB.claim("bot-b", "thread-1"), {
    ok: false,
    ownerBotId: "bot-a",
  });

  registryB.release("bot-a", "thread-1");

  const registryC = new PersistentSessionOwnershipRegistry(filePath);
  assert.equal(registryC.ownerOf("thread-1"), null);
});
