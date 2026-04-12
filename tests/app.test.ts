import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { bootstrapCodexAnywhere } from "../src/app.js";
import { CodexAnywhereBridge } from "../src/bridge.js";
import { getSessionOwnershipPath } from "../src/paths.js";
import { saveConfig, saveState } from "../src/persistence.js";
import { PersistentSessionOwnershipRegistry } from "../src/sessionOwnership.js";
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

  async getUpdates(): Promise<TelegramUpdate[]> {
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

class FakeCodex {
  startCalls = 0;
  initializeCalls = 0;

  async start(): Promise<void> {
    this.startCalls += 1;
  }

  async initialize(): Promise<void> {
    this.initializeCalls += 1;
  }

  async call(): Promise<JsonObject> {
    throw new Error("not used");
  }

  async notify(): Promise<void> {}
  async respond(): Promise<void> {}
  async nextMessage(): Promise<JsonObject> {
    throw new Error("not used");
  }
  async close(): Promise<void> {}
}

class FakeCodexWithThreadRead extends FakeCodex {
  readonly #threads: Record<string, { cwd: string }>;

  constructor(threads: Record<string, { cwd: string }>) {
    super();
    this.#threads = threads;
  }

  override async call(method: string, params?: JsonObject): Promise<JsonObject> {
    if (method === "thread/read") {
      const threadId = typeof params?.threadId === "string" ? params.threadId : "";
      const thread = this.#threads[threadId];
      if (!thread) {
        throw new Error("missing thread");
      }
      return {
        thread: {
          id: threadId,
          cwd: thread.cwd,
          status: { type: "idle" },
        },
      };
    }
    return await super.call();
  }
}

function chatState(threadId: string | null): ChatSessionState {
  return {
    threadId,
    freshThread: false,
    activeTurnId: threadId ? "turn-1" : null,
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
  };
}

test("bootstrapCodexAnywhere initializes one bridge lane per configured bot", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-anywhere-app-multibot-"));
  const configPath = path.join(tempDir, "config.json");
  const statePath = path.join(tempDir, "state.json");
  const workspaceA = path.join(tempDir, "workspace-a");
  const workspaceB = path.join(tempDir, "workspace-b");
  await fs.mkdir(workspaceA, { recursive: true });
  await fs.mkdir(workspaceB, { recursive: true });

  const config: StoredConfig = {
    version: 2,
    bots: [
      {
        id: "bot-a",
        label: "Bot A",
        telegramBotToken: "token-a",
        workspaceCwd: workspaceA,
        ownerUserId: 1,
        pollTimeoutSeconds: 1,
        streamEditIntervalMs: 100,
      },
      {
        id: "bot-b",
        label: "Bot B",
        telegramBotToken: "token-b",
        workspaceCwd: workspaceB,
        ownerUserId: 1,
        pollTimeoutSeconds: 1,
        streamEditIntervalMs: 100,
      },
    ],
  };
  await saveConfig(configPath, config);

  const telegramByBot = new Map<string, FakeTelegram>([
    ["bot-a", new FakeTelegram()],
    ["bot-b", new FakeTelegram()],
  ]);
  const codexByBot = new Map<string, FakeCodex>([
    ["bot-a", new FakeCodex()],
    ["bot-b", new FakeCodex()],
  ]);
  const capturedStatePaths = new Map<string, string>();

  const runtime = await bootstrapCodexAnywhere({
    storagePaths: { configPath, statePath },
    runPreflightChecks: async () => {},
    printStartupHelp: false,
    createBridge: (botConfig, bootConfigPath, bootStatePath, deps) => {
      capturedStatePaths.set(botConfig.id, bootStatePath);
      return new CodexAnywhereBridge(botConfig, bootConfigPath, bootStatePath, {
        ...deps,
        telegram: telegramByBot.get(botConfig.id)!,
        codex: codexByBot.get(botConfig.id)!,
      });
    },
  });

  assert.equal(runtime.getStatus().length, 2);
  assert.equal(capturedStatePaths.get("bot-a"), path.join(tempDir, "bots", "bot-a", "state.json"));
  assert.equal(capturedStatePaths.get("bot-b"), path.join(tempDir, "bots", "bot-b", "state.json"));
  assert.equal(codexByBot.get("bot-a")!.startCalls, 1);
  assert.equal(codexByBot.get("bot-b")!.initializeCalls, 1);
  assert.equal(telegramByBot.get("bot-a")!.commands.length, 1);
  assert.equal(telegramByBot.get("bot-b")!.commands.length, 1);
});

test("bootstrapCodexAnywhere hydrates persisted session ownership from bot state", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-anywhere-app-lock-hydration-"));
  const configPath = path.join(tempDir, "config.json");
  const statePath = path.join(tempDir, "state.json");
  const workspaceA = path.join(tempDir, "workspace-a");
  const workspaceB = path.join(tempDir, "workspace-b");
  await fs.mkdir(workspaceA, { recursive: true });
  await fs.mkdir(workspaceB, { recursive: true });

  const config: StoredConfig = {
    version: 2,
    bots: [
      {
        id: "bot-a",
        label: "Bot A",
        telegramBotToken: "token-a",
        workspaceCwd: workspaceA,
        ownerUserId: 1,
        pollTimeoutSeconds: 1,
        streamEditIntervalMs: 100,
      },
      {
        id: "bot-b",
        label: "Bot B",
        telegramBotToken: "token-b",
        workspaceCwd: workspaceB,
        ownerUserId: 1,
        pollTimeoutSeconds: 1,
        streamEditIntervalMs: 100,
      },
    ],
  };
  await saveConfig(configPath, config);
  await saveState(path.join(tempDir, "bots", "bot-a", "state.json"), {
    version: 1,
    lastUpdateId: null,
    chats: {
      "42": chatState("thread-seeded"),
    },
  } satisfies StoredState);

  await bootstrapCodexAnywhere({
    storagePaths: { configPath, statePath },
    runPreflightChecks: async () => {},
    printStartupHelp: false,
    createBridge: (botConfig, bootConfigPath, bootStatePath, deps) =>
      new CodexAnywhereBridge(botConfig, bootConfigPath, bootStatePath, {
        ...deps,
        telegram: new FakeTelegram(),
        codex: new FakeCodexWithThreadRead({
          "thread-seeded": { cwd: workspaceA },
        }),
      }),
  });

  const registry = new PersistentSessionOwnershipRegistry(
    getSessionOwnershipPath({ configPath, statePath }),
  );
  assert.equal(registry.ownerOf("thread-seeded"), "bot-a");
});

test("bootstrapCodexAnywhere drops stale persisted threads during reconciliation", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-anywhere-app-stale-thread-"));
  const configPath = path.join(tempDir, "config.json");
  const statePath = path.join(tempDir, "state.json");
  const workspace = path.join(tempDir, "workspace-a");
  await fs.mkdir(workspace, { recursive: true });

  const config: StoredConfig = {
    version: 2,
    bots: [
      {
        id: "bot-a",
        label: "Bot A",
        telegramBotToken: "token-a",
        workspaceCwd: workspace,
        ownerUserId: 1,
        pollTimeoutSeconds: 1,
        streamEditIntervalMs: 100,
      },
    ],
  };
  await saveConfig(configPath, config);
  await saveState(path.join(tempDir, "bots", "bot-a", "state.json"), {
    version: 1,
    lastUpdateId: null,
    chats: {
      "42": chatState("thread-stale"),
    },
  } satisfies StoredState);

  await bootstrapCodexAnywhere({
    storagePaths: { configPath, statePath },
    runPreflightChecks: async () => {},
    printStartupHelp: false,
    createBridge: (botConfig, bootConfigPath, bootStatePath, deps) =>
      new CodexAnywhereBridge(botConfig, bootConfigPath, bootStatePath, {
        ...deps,
        telegram: new FakeTelegram(),
        codex: new FakeCodexWithThreadRead({}),
      }),
  });

  const persistedState = JSON.parse(
    await fs.readFile(path.join(tempDir, "bots", "bot-a", "state.json"), "utf8"),
  ) as StoredState;
  const registry = new PersistentSessionOwnershipRegistry(
    getSessionOwnershipPath({ configPath, statePath }),
  );

  assert.equal(persistedState.chats["42"]?.threadId, null);
  assert.equal(registry.ownerOf("thread-stale"), null);
});

test("primary Telegram bot can hot-add a new bot into the running supervisor", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-anywhere-app-hot-add-"));
  const configPath = path.join(tempDir, "config.json");
  const statePath = path.join(tempDir, "state.json");
  const workspaceA = path.join(tempDir, "workspace-a");
  const workspaceB = path.join(tempDir, "workspace-b");
  await fs.mkdir(workspaceA, { recursive: true });
  await fs.mkdir(workspaceB, { recursive: true });

  const config: StoredConfig = {
    version: 2,
    bots: [
      {
        id: "bot-a",
        label: "Bot A",
        telegramBotToken: "token-a",
        workspaceCwd: workspaceA,
        ownerUserId: 1,
        pollTimeoutSeconds: 1,
        streamEditIntervalMs: 100,
      },
    ],
  };
  await saveConfig(configPath, config);

  const telegramByBot = new Map<string, FakeTelegram>();
  const codexByBot = new Map<string, FakeCodex>();

  const runtime = await bootstrapCodexAnywhere({
    storagePaths: { configPath, statePath },
    runPreflightChecks: async () => {},
    printStartupHelp: false,
    createBridge: (botConfig, bootConfigPath, bootStatePath, deps) => {
      const telegram = telegramByBot.get(botConfig.id) ?? new FakeTelegram();
      const codex = codexByBot.get(botConfig.id) ?? new FakeCodexWithThreadRead({});
      telegramByBot.set(botConfig.id, telegram);
      codexByBot.set(botConfig.id, codex);
      return new CodexAnywhereBridge(botConfig, bootConfigPath, bootStatePath, {
        ...deps,
        telegram,
        codex,
      });
    },
  });

  await runtime.primaryBridge.handleUpdateForTest(telegramMessageUpdate(1, "/addbot"));
  await runtime.primaryBridge.handleUpdateForTest(telegramMessageUpdate(2, "bot-b"));
  await runtime.primaryBridge.handleUpdateForTest(telegramMessageUpdate(3, "Bot B"));
  await runtime.primaryBridge.handleUpdateForTest(telegramMessageUpdate(4, "token-b"));
  await runtime.primaryBridge.handleUpdateForTest(telegramMessageUpdate(5, workspaceB));

  const savedConfig = JSON.parse(await fs.readFile(configPath, "utf8")) as StoredConfig;
  assert.equal(savedConfig.version, 2);
  assert.equal(savedConfig.bots.length, 2);
  assert.equal(savedConfig.bots[1]!.id, "bot-b");
  assert.equal(runtime.getStatus().length, 2);
  assert.equal(telegramByBot.get("bot-b")!.commands.length, 1);
  assert.match(telegramByBot.get("bot-a")!.sentMessages.at(-1)!.text, /Added bot bot-b\./);
});
