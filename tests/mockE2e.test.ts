import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { bootstrapCodexAnywhere } from "../src/bootstrap.js";
import { CodexAnywhereBridge } from "../src/bridge.js";
import { loadState, saveConfig, saveState } from "../src/persistence.js";
import type {
  ChatSessionState,
  JsonObject,
  StoredConfig,
  StoredState,
  TelegramBotCommand,
  TelegramUpdate,
} from "../src/types.js";

class FakeTelegram {
  readonly commands: TelegramBotCommand[][] = [];
  readonly sentMessages: Array<{ chatId: number; text: string; parseMode?: string }> = [];
  getUpdatesCalls = 0;

  async getUpdates(): Promise<TelegramUpdate[]> {
    this.getUpdatesCalls += 1;
    return [];
  }

  async setMyCommands(commands: TelegramBotCommand[]): Promise<void> {
    this.commands.push(commands);
  }

  async getFile(): Promise<{ file_path: string }> {
    throw new Error("not used");
  }

  async downloadFile(): Promise<Buffer> {
    throw new Error("not used");
  }

  async sendChatAction(): Promise<void> {}

  async sendMessage(
    chatId: number,
    text: string,
    _replyMarkup?: JsonObject,
    parseMode?: string,
  ): Promise<{ message_id: number }> {
    this.sentMessages.push({ chatId, text, parseMode });
    return { message_id: this.sentMessages.length };
  }

  async editMessageText(): Promise<void> {}

  async answerCallbackQuery(): Promise<void> {}

  async deleteMessage(): Promise<void> {}
}

class FakeCodex {
  readonly calls: Array<{ method: string; params?: JsonObject }> = [];
  startCalls = 0;
  initializeCalls = 0;

  constructor(
    private readonly handler: (method: string, params?: JsonObject) => JsonObject | Promise<JsonObject>,
  ) {}

  async start(): Promise<void> {
    this.startCalls += 1;
  }

  async initialize(): Promise<void> {
    this.initializeCalls += 1;
  }

  async call(method: string, params?: JsonObject): Promise<JsonObject> {
    this.calls.push({ method, params });
    return await this.handler(method, params);
  }

  async notify(): Promise<void> {}

  async respond(): Promise<void> {}

  async nextMessage(): Promise<JsonObject> {
    throw new Error("not used");
  }

  async close(): Promise<void> {}
}

function testConfig(overrides: Partial<StoredConfig> = {}): StoredConfig {
  return {
    version: 1,
    telegramBotToken: "test-token",
    workspaceCwd: "/Users/twocode/works/agents/codex",
    ownerUserId: 1,
    pollTimeoutSeconds: 1,
    streamEditIntervalMs: 100,
    ...overrides,
  };
}

function defaultChatState(overrides: Partial<ChatSessionState> = {}): ChatSessionState {
  return {
    threadId: null,
    freshThread: false,
    activeTurnId: null,
    turnControlTurnId: null,
    turnControlMessageId: null,
    verbose: false,
    queueNextArmed: false,
    queuedTurnInput: null,
    pendingTurnInput: null,
    pendingMention: null,
    model: null,
    reasoningEffort: null,
    personality: null,
    collaborationModeName: null,
    collaborationMode: null,
    serviceTier: null,
    approvalPolicy: null,
    lastAssistantMessage: null,
    ...overrides,
  };
}

function telegramMessageUpdate(updateId: number, text: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: 42, type: "private" },
      from: { id: 1 },
      text,
    },
  };
}

async function createMockOmxBinary(tempDir: string): Promise<string> {
  const binDir = path.join(tempDir, "bin");
  await fs.mkdir(binDir, { recursive: true });
  const omxPath = path.join(binDir, "omx");
  await fs.writeFile(
    omxPath,
    "#!/bin/sh\nif [ \"$1\" = \"version\" ]; then\n  echo 'omx-test 1.2.3'\n  exit 0\nfi\necho unexpected >&2\nexit 2\n",
    { mode: 0o755 },
  );
  return binDir;
}

test("bootstrapCodexAnywhere runs a deterministic mocked E2E flow with persisted resume", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-anywhere-mock-e2e-"));
  const configPath = path.join(tempDir, "config.json");
  const statePath = path.join(tempDir, "state.json");
  await saveConfig(configPath, testConfig());

  const binDir = await createMockOmxBinary(tempDir);
  const originalPath = process.env.PATH ?? "";
  process.env.PATH = `${binDir}:${originalPath}`;

  try {
    const telegram1 = new FakeTelegram();
    const codex1 = new FakeCodex(async (method, params) => {
      if (method === "thread/start") {
        return { thread: { id: "thread-1" } };
      }
      if (method === "turn/start") {
        return { turn: { id: "turn-1" } };
      }
      throw new Error(`unexpected codex call during first boot: ${method} ${JSON.stringify(params)}`);
    });

    let preflightCalls = 0;
    const app1 = await bootstrapCodexAnywhere({
      getStoragePaths: () => ({ configPath, statePath }),
      runPreflightChecks: async () => {
        preflightCalls += 1;
      },
      createBridge: (config, bootConfigPath, bootStatePath) =>
        new CodexAnywhereBridge(config, bootConfigPath, bootStatePath, {
          telegram: telegram1,
          codex: codex1,
        }),
      log: () => {},
    });

    assert.equal(preflightCalls, 1);
    assert.equal(codex1.startCalls, 1);
    assert.equal(codex1.initializeCalls, 1);
    assert.equal(telegram1.getUpdatesCalls, 0);
    assert.equal(telegram1.commands.length, 1);

    await app1.bridge.handleUpdateForTest(telegramMessageUpdate(1, "fix tests"));

    assert.deepEqual(
      codex1.calls.map((call) => call.method),
      ["thread/start", "turn/start"],
    );
    assert.deepEqual(codex1.calls[1]!.params?.input, [{ type: "text", text: "fix tests" }]);

    const persistedAfterText = await loadState(statePath);
    assert.equal(persistedAfterText.chats["42"]?.threadId, "thread-1");
    assert.equal(persistedAfterText.chats["42"]?.activeTurnId, "turn-1");

    await app1.bridge.handleUpdateForTest(telegramMessageUpdate(2, "/omx version"));

    assert.equal(telegram1.sentMessages.length, 1);
    assert.match(telegram1.sentMessages[0]!.text, /<b>OMX<\/b>/);
    assert.match(telegram1.sentMessages[0]!.text, /omx version/);
    assert.match(telegram1.sentMessages[0]!.text, /omx-test 1\.2\.3/);
    assert.equal(telegram1.sentMessages[0]!.parseMode, "HTML");

    const telegram2 = new FakeTelegram();
    const codex2 = new FakeCodex(async (method, params) => {
      if (method === "thread/read") {
        return {
          thread: {
            status: { type: "idle" },
            turns: [{ id: "turn-1", status: "completed" }],
          },
        };
      }
      if (method === "thread/resume") {
        return {};
      }
      if (method === "turn/start") {
        return { turn: { id: "turn-2" } };
      }
      throw new Error(`unexpected codex call during second boot: ${method} ${JSON.stringify(params)}`);
    });

    const app2 = await bootstrapCodexAnywhere({
      getStoragePaths: () => ({ configPath, statePath }),
      runPreflightChecks: async () => {},
      createBridge: (config, bootConfigPath, bootStatePath) =>
        new CodexAnywhereBridge(config, bootConfigPath, bootStatePath, {
          telegram: telegram2,
          codex: codex2,
        }),
      log: () => {},
    });

    await app2.bridge.handleUpdateForTest(telegramMessageUpdate(3, "continue"));

    assert.deepEqual(
      codex2.calls.map((call) => call.method),
      ["thread/read", "thread/resume", "turn/start"],
    );
    assert.equal(codex2.calls[1]!.params?.threadId, "thread-1");
    assert.deepEqual(codex2.calls[2]!.params?.input, [{ type: "text", text: "continue" }]);
    assert.ok(!codex2.calls.some((call) => call.method === "thread/start"));

    const persistedAfterResume = await loadState(statePath);
    assert.equal(persistedAfterResume.chats["42"]?.threadId, "thread-1");
    assert.equal(persistedAfterResume.chats["42"]?.activeTurnId, "turn-2");
  } finally {
    process.env.PATH = originalPath;
  }
});

test("bootstrapCodexAnywhere keeps persisted state intact after a deterministic preflight failure", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-anywhere-mock-e2e-fail-"));
  const configPath = path.join(tempDir, "config.json");
  const statePath = path.join(tempDir, "state.json");

  const initialState: StoredState = {
    version: 1,
    lastUpdateId: 12,
    chats: {
      "42": defaultChatState({
        threadId: "thread-existing",
        activeTurnId: "turn-existing",
      }),
    },
  };

  await saveConfig(configPath, testConfig());
  await saveState(statePath, initialState);

  let createBridgeCalls = 0;
  await assert.rejects(
    bootstrapCodexAnywhere({
      getStoragePaths: () => ({ configPath, statePath }),
      runPreflightChecks: async () => {
        throw new Error("preflight failed for test");
      },
      createBridge: (config, bootConfigPath, bootStatePath) => {
        createBridgeCalls += 1;
        return new CodexAnywhereBridge(config, bootConfigPath, bootStatePath, {
          telegram: new FakeTelegram(),
          codex: new FakeCodex(async () => {
            throw new Error("bridge should not start when preflight fails");
          }),
        });
      },
      log: () => {},
    }),
    /preflight failed for test/,
  );

  assert.equal(createBridgeCalls, 0);
  const persistedAfterFailure = await loadState(statePath);
  assert.deepEqual(persistedAfterFailure, initialState);
});
