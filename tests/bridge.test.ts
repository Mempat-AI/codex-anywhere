import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexAnywhereBridge } from "../src/bridge.js";
import { loadConfig, loadState, saveConfig, saveState } from "../src/persistence.js";
import { InMemorySessionOwnershipRegistry } from "../src/sessionOwnership.js";
import type {
  BotRuntimeConfig,
  ChatSessionState,
  JsonObject,
  StoredConfig,
  StoredState,
  TelegramBotCommand,
  TelegramUpdate,
} from "../src/types.js";

class FakeTelegram {
  readonly sentMessages: Array<{
    chatId: number;
    text: string;
    replyMarkup?: JsonObject;
    parseMode?: string;
    replyToMessageId?: number | null;
  }> = [];
  readonly sentDocuments: Array<{ chatId: number; filePath: string; caption?: string }> = [];
  readonly sentPhotos: Array<{ chatId: number; filePath: string; caption?: string }> = [];
  readonly editedMessages: Array<{
    chatId: number;
    messageId: number;
    text: string;
    replyMarkup?: JsonObject;
    parseMode?: string;
  }> = [];
  readonly callbackAnswers: string[] = [];

  async getUpdates(): Promise<TelegramUpdate[]> {
    return [];
  }

  async setMyCommands(_commands: TelegramBotCommand[]): Promise<void> {}

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
    replyMarkup?: JsonObject,
    parseMode?: string,
    replyToMessageId?: number | null,
  ): Promise<{ message_id: number }> {
    this.sentMessages.push({ chatId, text, replyMarkup, parseMode, replyToMessageId });
    return { message_id: this.sentMessages.length };
  }

  async sendDocument(chatId: number, filePath: string, caption?: string): Promise<{ message_id: number }> {
    this.sentDocuments.push({ chatId, filePath, caption });
    return { message_id: this.sentMessages.length + this.sentDocuments.length + this.sentPhotos.length };
  }

  async sendPhoto(chatId: number, filePath: string, caption?: string): Promise<{ message_id: number }> {
    this.sentPhotos.push({ chatId, filePath, caption });
    return { message_id: this.sentMessages.length + this.sentDocuments.length + this.sentPhotos.length };
  }

  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    replyMarkup?: JsonObject,
    parseMode?: string,
  ): Promise<void> {
    this.editedMessages.push({ chatId, messageId, text, replyMarkup, parseMode });
  }

  async answerCallbackQuery(_id: string, text: string): Promise<void> {
    this.callbackAnswers.push(text);
  }

  async deleteMessage(): Promise<void> {}
}

class FakeCodex {
  readonly calls: Array<{ method: string; params?: JsonObject }> = [];

  async start(): Promise<void> {}
  async initialize(): Promise<void> {}
  async call(method: string, params?: JsonObject): Promise<JsonObject> {
    this.calls.push({ method, params });
    if (method === "thread/start") {
      return { thread: { id: "thread-1" } };
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-1" } };
    }
    throw new Error(`unexpected codex call: ${method}`);
  }
  async notify(): Promise<void> {}
  async respond(): Promise<void> {}
  async nextMessage(): Promise<JsonObject> {
    throw new Error("not used");
  }
  async close(): Promise<void> {}
}

class FakeCodexWithFreshResumeFailure extends FakeCodex {
  override async call(method: string, params?: JsonObject): Promise<JsonObject> {
    this.calls.push({ method, params });
    if (method === "thread/start") {
      return { thread: { id: "thread-1" } };
    }
    if (method === "thread/resume") {
      throw new Error('{"code":-32600,"message":"no rollout found for thread id thread-1"}');
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-1" } };
    }
    throw new Error(`unexpected codex call: ${method}`);
  }
}

function testConfig(
  overrides: Partial<StoredConfig & BotRuntimeConfig> = {},
): StoredConfig & BotRuntimeConfig {
  return {
    version: 1,
    id: "default",
    label: "default",
    telegramBotToken: "test-token",
    workspaceCwd: process.cwd(),
    ownerUserId: 1,
    pollTimeoutSeconds: 1,
    streamEditIntervalMs: 100,
    ...overrides,
  };
}

function testState(): StoredState {
  return {
    version: 1,
    lastUpdateId: null,
    chats: {},
  };
}

function testChatState(overrides: Partial<ChatSessionState> = {}): ChatSessionState {
  return {
    threadId: null,
    freshThread: false,
    activeTurnId: null,
    turnControlTurnId: null,
    turnControlMessageId: null,
    verbose: false,
    queueNextArmed: false,
    queuedTurnInput: null,
    queuedTurnOriginMessageId: null,
    pendingTurnInput: null,
    pendingTurnOriginMessageId: null,
    pendingMention: null,
    model: null,
    reasoningEffort: null,
    personality: null,
    collaborationModeName: null,
    collaborationMode: null,
    serviceTier: null,
    approvalPolicy: null,
    sandboxMode: null,
    lastAssistantMessage: null,
    ...overrides,
  };
}

function computerUseInput(task: string): JsonObject[] {
  return [
    { type: "text", text: `@computer-use ${task}` },
    {
      type: "mention",
      name: "Computer Use",
      path: "plugin://computer-use@openai-bundled",
    },
  ];
}

function telegramMessageUpdate(text: string, messageId = 1): TelegramUpdate {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      chat: { id: 42, type: "private" },
      from: { id: 1 },
      text,
    },
  };
}

function telegramDocumentUpdate(document: {
  file_id: string;
  file_name?: string;
  mime_type?: string;
}, caption?: string): TelegramUpdate {
  return {
    update_id: 3,
    message: {
      message_id: 3,
      chat: { id: 42, type: "private" },
      from: { id: 1 },
      caption,
      document,
    },
  };
}

function telegramCallbackUpdate(data: string): TelegramUpdate {
  return {
    update_id: 2,
    callback_query: {
      id: "callback-1",
      from: { id: 1 },
      data,
      message: {
        message_id: 99,
        chat: { id: 42, type: "private" },
        from: { id: 1 },
        text: "callback",
      },
    },
  };
}

const serialTest = { concurrency: false } as const;
const runOmxCommandTest = process.env.SKIP_OMX_COMMAND_TESTS === "1" ? test.skip : test;

runOmxCommandTest("bridge routes /omx version through Telegram message output", serialTest, async () => {
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: testState(),
  });

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-anywhere-omx-test-"));
  const binDir = path.join(tempDir, "bin");
  await fs.mkdir(binDir, { recursive: true });
  const omxPath = path.join(binDir, "omx");
  await fs.writeFile(
    omxPath,
    "#!/bin/sh\nif [ \"$1\" = \"version\" ]; then\n  echo 'omx-test 1.2.3'\n  exit 0\nfi\necho unexpected >&2\nexit 2\n",
    { mode: 0o755 },
  );

  const originalPath = process.env.PATH ?? "";
  process.env.PATH = `${binDir}:${originalPath}`;
  try {
    await bridge.handleUpdateForTest(telegramMessageUpdate("/omx version"));
  } finally {
    process.env.PATH = originalPath;
  }

  assert.equal(telegram.sentMessages.length, 1);
  assert.match(telegram.sentMessages[0]!.text, /<b>OMX<\/b>/);
  assert.match(telegram.sentMessages[0]!.text, /omx version/);
  assert.match(telegram.sentMessages[0]!.text, /omx-test 1\.2\.3/);
  assert.equal(telegram.sentMessages[0]!.parseMode, "HTML");
});

test("bridge shows a friendly message when omx is not installed", serialTest, async () => {
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: testState(),
  });

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-anywhere-omx-missing-"));
  const binDir = path.join(tempDir, "bin");
  await fs.mkdir(binDir, { recursive: true });

  const originalPath = process.env.PATH ?? "";
  process.env.PATH = binDir;
  try {
    await bridge.handleUpdateForTest(telegramMessageUpdate("/omx status"));
  } finally {
    process.env.PATH = originalPath;
  }

  assert.equal(telegram.sentMessages.length, 1);
  assert.match(telegram.sentMessages[0]!.text, /OMX is not installed in this environment/);
  assert.match(telegram.sentMessages[0]!.text, /omx setup/);
  assert.equal(telegram.sentMessages[0]!.parseMode, undefined);
});

test("bridge maps skill-first OMX workflows back into the current thread", async () => {
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: testState(),
  });

  await bridge.handleUpdateForTest(
    telegramMessageUpdate('/omx deep-interview "clarify requirements"'),
  );

  assert.equal(telegram.sentMessages.length, 0);
  assert.equal(codex.calls.length, 2);
  assert.equal(codex.calls[0]!.method, "thread/start");
  assert.equal(codex.calls[1]!.method, "turn/start");
  assert.deepEqual(codex.calls[1]!.params?.input, [
    { type: "text", text: "$deep-interview clarify requirements" },
  ]);
});

test("final agent message chunks are sent from the turn card only once", async () => {
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: testState(),
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("hello"));

  const longText = "a".repeat(8000);
  await bridge.handleNotificationForTest("item/completed", {
    threadId: "thread-1",
    turnId: "turn-1",
    item: {
      id: "item-1",
      type: "agentMessage",
      text: longText,
      phase: "final",
    },
  });

  assert.equal(telegram.sentMessages.length, 1);
  assert.equal(telegram.sentMessages[0]!.replyToMessageId, 1);
  assert.match(telegram.sentMessages[0]!.text, /Run details/);
  assert.match(telegram.sentMessages[0]!.text, /^<b>T<\/b>hinking\n/);
  assert.equal(telegram.editedMessages.length, 1);
  assert.equal(telegram.editedMessages[0]!.messageId, 1);

  await bridge.handleNotificationForTest("turn/completed", {
    threadId: "thread-1",
    turn: {
      id: "turn-1",
      status: "completed",
    },
  });

  assert.equal(telegram.sentMessages.length, 4);
  assert.match(telegram.sentMessages[0]!.text, /Run details/);
  assert.doesNotMatch(telegram.sentMessages[0]!.text, /^a+$/);
  assert.equal(telegram.sentMessages[1]!.replyToMessageId, 1);
  assert.equal(telegram.sentMessages[2]!.replyToMessageId, 1);
  assert.equal(telegram.sentMessages[3]!.replyToMessageId, 1);
  assert.equal(telegram.sentMessages[1]!.parseMode, "HTML");
  assert.equal(telegram.sentMessages[2]!.parseMode, "HTML");
  assert.equal(telegram.sentMessages[3]!.parseMode, "HTML");
  assert.equal(telegram.editedMessages.length, 2);
  assert.equal(telegram.editedMessages[1]!.messageId, 1);
  assert.match(telegram.editedMessages[1]!.text, /Run details/);
  assert.doesNotMatch(telegram.editedMessages[1]!.text, /^a+$/);
});

test("turn card keeps run details above a fresh final answer message", async () => {
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: testState(),
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("optimize Telegram UX"));
  await bridge.handleNotificationForTest("item/started", {
    threadId: "thread-1",
    turnId: "turn-1",
    item: {
      id: "preamble-1",
      type: "agentMessage",
      phase: "commentary",
    },
  });
  await bridge.handleNotificationForTest("item/agentMessage/delta", {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "preamble-1",
    delta: "I will inspect the Telegram bridge.",
  });
  await bridge.handleNotificationForTest("item/completed", {
    threadId: "thread-1",
    turnId: "turn-1",
    item: {
      id: "preamble-1",
      type: "agentMessage",
      text: "I will inspect the Telegram bridge.",
      phase: "commentary",
    },
  });
  await bridge.handleNotificationForTest("item/completed", {
    threadId: "thread-1",
    turnId: "turn-1",
    item: {
      id: "cmd-1",
      type: "commandExecution",
      command: "pnpm test",
      status: "completed",
      exitCode: 0,
    },
  });
  const afterToolEdit = telegram.editedMessages.at(-1)!;
  assert.equal(afterToolEdit.messageId, 1);
  assert.match(afterToolEdit.text, /^Command completed, exit 0: pnpm test/);
  assert.match(afterToolEdit.text, /<blockquote expandable>/);
  assert.match(afterToolEdit.text, /Run details/);
  assert.match(afterToolEdit.text, /I will inspect the Telegram bridge\./);
  assert.match(afterToolEdit.text, /Command completed, exit 0: pnpm test/);
  assert.doesNotMatch(afterToolEdit.text, /Preamble:/);
  assert.doesNotMatch(afterToolEdit.text, /Tool:/);
  await bridge.handleNotificationForTest("item/completed", {
    threadId: "thread-1",
    turnId: "turn-1",
    item: {
      id: "final-1",
      type: "agentMessage",
      text: "Done.",
      phase: "final",
    },
  });
  await bridge.handleNotificationForTest("turn/completed", {
    threadId: "thread-1",
    turn: {
      id: "turn-1",
      status: "completed",
    },
  });

  assert.equal(telegram.sentMessages.length, 2);
  assert.equal(telegram.sentMessages[0]!.replyToMessageId, 1);
  assert.equal(telegram.sentMessages[0]!.parseMode, "HTML");
  assert.match(telegram.sentMessages[0]!.text, /<blockquote expandable>/);
  assert.match(telegram.sentMessages[0]!.text, /Run details/);
  assert.match(telegram.sentMessages[0]!.text, /^<b>T<\/b>hinking\n/);
  assert.equal(telegram.sentMessages[1]!.replyToMessageId, 1);
  assert.equal(telegram.sentMessages[1]!.parseMode, "HTML");
  assert.equal(telegram.sentMessages[1]!.text, "Done.");
  assert.ok(telegram.editedMessages.length >= 1);
  const finalEdit = telegram.editedMessages.at(-1)!;
  assert.equal(finalEdit.messageId, 1);
  assert.match(finalEdit.text, /<blockquote expandable>/);
  assert.match(finalEdit.text, /Run details/);
  assert.match(finalEdit.text, /I will inspect the Telegram bridge\./);
  assert.match(finalEdit.text, /Command completed, exit 0: pnpm test/);
  assert.doesNotMatch(finalEdit.text, /Preamble:/);
  assert.doesNotMatch(finalEdit.text, /Tool:/);
  assert.match(finalEdit.text, /pnpm test/);
  assert.doesNotMatch(finalEdit.text, /^Done\./);
  assert.doesNotMatch(finalEdit.text, /Working on:/);
  assert.doesNotMatch(finalEdit.text, /Current:/);
});

test("queued turn cards reply to the queued Telegram request", async () => {
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  let startedTurnCount = 0;
  codex.call = async function (method: string, params?: JsonObject): Promise<JsonObject> {
    this.calls.push({ method, params });
    if (method === "thread/read") {
      return {
        thread: {
          id: "thread-1",
          status: { type: "active" },
          turns: [{ id: "turn-1", status: "inProgress" }],
        },
      };
    }
    if (method === "thread/resume") {
      return {};
    }
    if (method === "turn/start") {
      startedTurnCount += 1;
      return { turn: { id: `turn-${startedTurnCount + 1}` } };
    }
    throw new Error(`unexpected codex call: ${method}`);
  };
  const state = testState();
  state.chats["42"] = testChatState({
    threadId: "thread-1",
    activeTurnId: "turn-1",
  });
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: state,
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("queued follow-up", 7));
  const queueCallbackData = (telegram.sentMessages[0]!.replyMarkup as { inline_keyboard: Array<Array<{ callback_data?: string }>> })
    .inline_keyboard[0]![1]!.callback_data!;
  await bridge.handleUpdateForTest(telegramCallbackUpdate(queueCallbackData));

  assert.equal(state.chats["42"]!.queuedTurnOriginMessageId, 7);
  assert.match(telegram.sentMessages[0]!.text, /queued follow-up/);
  assert.equal(telegram.sentMessages[0]!.replyToMessageId, 7);
  assert.match(telegram.sentMessages[1]!.text, /Queued/);
  assert.equal(telegram.sentMessages[1]!.replyToMessageId, 7);

  await bridge.handleNotificationForTest("turn/completed", {
    threadId: "thread-1",
    turn: {
      id: "turn-1",
      status: "completed",
    },
  });
  await bridge.handleNotificationForTest("turn/started", {
    threadId: "thread-1",
    turn: {
      id: "turn-2",
    },
  });
  await bridge.handleNotificationForTest("item/completed", {
    threadId: "thread-1",
    turnId: "turn-2",
    item: {
      id: "final-2",
      type: "agentMessage",
      text: "Queued response.",
      phase: "final",
    },
  });
  await bridge.handleNotificationForTest("turn/completed", {
    threadId: "thread-1",
    turn: {
      id: "turn-2",
      status: "completed",
    },
  });

  const queuedDetailsCard = telegram.sentMessages.find((message) =>
    message.replyToMessageId === 7 && /Run details/.test(message.text)
  );
  const queuedFinalCard = telegram.sentMessages.find((message) =>
    message.replyToMessageId === 7 && message.text === "Queued response."
  );
  assert.ok(queuedDetailsCard);
  assert.ok(queuedFinalCard);
});

test("polled updates are acknowledged only after handling succeeds", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-anywhere-polled-update-"));
  const state = testState();
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  codex.call = async function (method: string, params?: JsonObject): Promise<JsonObject> {
    this.calls.push({ method, params });
    throw new Error(`boom during ${method}`);
  };
  const bridge = new CodexAnywhereBridge(
    testConfig(),
    path.join(tempDir, "config.json"),
    path.join(tempDir, "state.json"),
    {
      telegram,
      codex,
      initialState: state,
    },
  );

  await assert.rejects(
    bridge.handlePolledUpdateForTest(telegramMessageUpdate("start a failing turn", 10)),
    /boom during thread\/start/,
  );
  assert.equal(state.lastUpdateId, null);

  await bridge.handlePolledUpdateForTest(telegramMessageUpdate("/version", 11));
  assert.equal(state.lastUpdateId, 11);
  assert.match(telegram.sentMessages.at(-1)?.text ?? "", /^codex-anywhere /);
});

test("bridge routes /computer through the Computer Use plugin mention", async () => {
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: testState(),
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("/computer play a music"));

  assert.equal(telegram.sentMessages.length, 0);
  assert.equal(codex.calls.length, 2);
  assert.equal(codex.calls[0]!.method, "thread/start");
  assert.equal(codex.calls[1]!.method, "turn/start");
  assert.deepEqual(codex.calls[1]!.params?.input, computerUseInput("play a music"));
});

test("bridge queues /computer input through the normal active-turn path", async () => {
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  codex.call = async function (method: string, params?: JsonObject): Promise<JsonObject> {
    this.calls.push({ method, params });
    if (method === "thread/read") {
      return {
        thread: {
          id: "thread-1",
          status: { type: "active" },
          turns: [{ id: "turn-1", status: "inProgress" }],
        },
      };
    }
    throw new Error(`unexpected codex call: ${method}`);
  };
  const state = testState();
  state.chats["42"] = testChatState({
    threadId: "thread-1",
    activeTurnId: "turn-1",
    turnControlTurnId: "turn-1",
    turnControlMessageId: 99,
    queueNextArmed: true,
  });
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: state,
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("/computer play a music"));

  assert.deepEqual(codex.calls.map((call) => call.method), ["thread/read"]);
  assert.equal(state.chats["42"]!.queueNextArmed, false);
  assert.deepEqual(state.chats["42"]!.queuedTurnInput, computerUseInput("play a music"));
  assert.equal(state.chats["42"]!.queuedTurnOriginMessageId, 1);
  assert.match(telegram.sentMessages[0]!.text, /Queued/);
  assert.equal(telegram.sentMessages[0]!.replyToMessageId, 1);
});

test("bridge shows /computer usage when task is missing", async () => {
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: testState(),
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("/computer"));

  assert.equal(codex.calls.length, 0);
  assert.equal(telegram.sentMessages.length, 1);
  assert.equal(telegram.sentMessages[0]!.text, "Usage: /computer <task>");
});

runOmxCommandTest("bridge routes $team through the OMX team CLI path", serialTest, async () => {
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: testState(),
  });

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-anywhere-omx-team-test-"));
  const binDir = path.join(tempDir, "bin");
  await fs.mkdir(binDir, { recursive: true });
  const omxPath = path.join(binDir, "omx");
  await fs.writeFile(
    omxPath,
    "#!/bin/sh\nif [ \"$1\" = \"team\" ] && [ \"$2\" = \"2:executor\" ]; then\n  echo 'Team started: test-team'\n  exit 0\nfi\necho unexpected >&2\nexit 2\n",
    { mode: 0o755 },
  );

  const originalPath = process.env.PATH ?? "";
  process.env.PATH = `${binDir}:${originalPath}`;
  try {
    await bridge.handleUpdateForTest(
      telegramMessageUpdate('$team 2:executor "fix failing tests"'),
    );
  } finally {
    process.env.PATH = originalPath;
  }

  assert.equal(codex.calls.length, 0);
  assert.equal(telegram.sentMessages.length, 1);
  assert.match(telegram.sentMessages[0]!.text, /<b>OMX<\/b>/);
  assert.match(telegram.sentMessages[0]!.text, /omx team 2:executor fix failing tests/);
  assert.match(telegram.sentMessages[0]!.text, /Team started: test-team/);
});

test("bridge switches workspace and clears chat thread state", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-anywhere-workspace-"));
  const initialWorkspace = path.join(tempDir, "workspace-a");
  const nextWorkspace = path.join(tempDir, "workspace-b");
  await fs.mkdir(initialWorkspace, { recursive: true });
  await fs.mkdir(nextWorkspace, { recursive: true });

  const configPath = path.join(tempDir, "config.json");
  const statePath = path.join(tempDir, "state.json");
  await saveConfig(configPath, testConfig({ workspaceCwd: initialWorkspace }));
  await saveState(statePath, {
    version: 1,
    lastUpdateId: null,
    chats: {
      "42": {
        threadId: "thread-1",
        activeTurnId: null,
        turnControlTurnId: "turn-1",
        turnControlMessageId: 99,
        verbose: false,
        queueNextArmed: true,
        queuedTurnInput: [{ type: "text", text: "queued" }],
        pendingTurnInput: [{ type: "text", text: "pending" }],
        pendingMention: { name: "file.ts", path: "/tmp/file.ts" },
        model: "gpt-5.4",
        reasoningEffort: "high",
        personality: "friendly",
        collaborationModeName: "plan",
        collaborationMode: { mode: "plan" },
        serviceTier: "fast",
        approvalPolicy: "on-request",
        sandboxMode: "read-only",
        lastAssistantMessage: "hello",
      },
    },
  });

  const telegram = new FakeTelegram();
  const bridge = new CodexAnywhereBridge(
    testConfig({ workspaceCwd: initialWorkspace }),
    configPath,
    statePath,
    {
      telegram,
      codex: new FakeCodex(),
      initialState: await loadState(statePath),
    },
  );

  await bridge.handleUpdateForTest(telegramMessageUpdate(`/workspace ${nextWorkspace}`));

  const savedConfig = await loadConfig(configPath);
  const savedState = await loadState(statePath);

  assert.equal(savedConfig?.workspaceCwd, nextWorkspace);
  assert.equal(savedState.chats["42"]?.threadId, null);
  assert.equal(savedState.chats["42"]?.turnControlMessageId, null);
  assert.equal(savedState.chats["42"]?.queueNextArmed, false);
  assert.equal(savedState.chats["42"]?.queuedTurnInput, null);
  assert.equal(savedState.chats["42"]?.pendingTurnInput, null);
  assert.equal(savedState.chats["42"]?.pendingMention, null);
  assert.equal(savedState.chats["42"]?.lastAssistantMessage, null);
  assert.equal(telegram.sentMessages.length, 1);
  assert.match(telegram.sentMessages[0]!.text, /Workspace changed to/);
  assert.match(telegram.sentMessages[0]!.text, /Detached current thread\/session state/);
});

test("bridge sets sandbox mode and applies it to new turns", async () => {
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: testState(),
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("/sandbox read-only"));
  await bridge.handleUpdateForTest(telegramMessageUpdate("Inspect the repo"));

  assert.equal(telegram.sentMessages[0]!.text, "Sandbox mode set to read-only. Applies to new turns.");
  assert.equal(codex.calls[0]!.method, "thread/start");
  assert.equal(codex.calls[0]!.params?.sandbox, "read-only");
  assert.equal(codex.calls[1]!.method, "turn/start");
  assert.deepEqual(codex.calls[1]!.params?.sandboxPolicy, {
    type: "readOnly",
    networkAccess: true,
  });
});

test("bridge recreates a fresh thread when resume reports a missing rollout", async () => {
  const telegram = new FakeTelegram();
  const codex = new FakeCodexWithFreshResumeFailure();
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: testState(),
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("/new"));
  await bridge.handleUpdateForTest(telegramMessageUpdate("Commit current changes"));

  assert.equal(codex.calls[0]!.method, "thread/start");
  assert.equal(codex.calls[1]!.method, "thread/resume");
  assert.equal(codex.calls[2]!.method, "thread/start");
  assert.equal(codex.calls[3]!.method, "turn/start");
  assert.deepEqual(codex.calls[3]!.params?.input, [
    { type: "text", text: "Commit current changes" },
  ]);
});

test("bridge inlines text-like document uploads into the turn input", async () => {
  const telegram = new FakeTelegram();
  telegram.getFile = async function (): Promise<{ file_path: string }> {
    return { file_path: "documents/report.crash" };
  };
  telegram.downloadFile = async function (): Promise<Buffer> {
    return Buffer.from("crash log");
  };
  const codex = new FakeCodex();
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: testState(),
  });

  await bridge.handleUpdateForTest(telegramDocumentUpdate({
    file_id: "doc-1",
    file_name: "TestFlight - Envoi AI 0.1.30 (36).crash",
    mime_type: "text/plain",
  }));

  assert.equal(codex.calls[0]!.method, "thread/start");
  assert.equal(codex.calls[1]!.method, "turn/start");
  const input = codex.calls[1]!.params?.input as JsonObject[];
  assert.equal(input.length, 1);
  assert.equal(input[0]!.type, "text");
  assert.match(String(input[0]!.text), /@TestFlight - Envoi AI 0\.1\.30 \(36\)\.crash/);
  assert.match(String(input[0]!.text), /Attached file: TestFlight - Envoi AI 0\.1\.30 \(36\)\.crash/);
  assert.match(String(input[0]!.text), /```text\ncrash log\n```/);
});

test("bridge keeps document caption alongside inlined text document content", async () => {
  const telegram = new FakeTelegram();
  telegram.getFile = async function (): Promise<{ file_path: string }> {
    return { file_path: "docs/incident.txt" };
  };
  telegram.downloadFile = async function (): Promise<Buffer> {
    return Buffer.from("incident report");
  };
  const codex = new FakeCodex();
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: testState(),
  });

  await bridge.handleUpdateForTest(telegramDocumentUpdate({
    file_id: "doc-2",
    file_name: "incident.txt",
    mime_type: "text/plain",
  }, "This one"));

  const input = codex.calls[1]!.params?.input as JsonObject[];
  assert.equal(input.length, 1);
  assert.equal(input[0]!.type, "text");
  assert.match(String(input[0]!.text), /^@incident\.txt This one/);
  assert.match(String(input[0]!.text), /Attached file: incident\.txt/);
  assert.match(String(input[0]!.text), /```text\nincident report\n```/);
});

test("bridge falls back to a file mention for non-text documents", async () => {
  const telegram = new FakeTelegram();
  telegram.getFile = async function (): Promise<{ file_path: string }> {
    return { file_path: "docs/archive.zip" };
  };
  telegram.downloadFile = async function (): Promise<Buffer> {
    return Buffer.from([0, 1, 2, 3]);
  };
  const codex = new FakeCodex();
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: testState(),
  });

  await bridge.handleUpdateForTest(telegramDocumentUpdate({
    file_id: "doc-3",
    file_name: "archive.zip",
    mime_type: "application/zip",
  }, "Use this"));

  assert.equal(telegram.sentMessages.length, 0);
  const input = codex.calls[1]!.params?.input as JsonObject[];
  assert.equal(input[0]!.type, "text");
  assert.equal(input[0]!.text, "@archive.zip Use this");
  assert.deepEqual(input[1], {
    type: "mention",
    name: "archive.zip",
    path: String(input[1]!.path),
  });
});

test("/download sends a regular workspace file as a Telegram document", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "codex-anywhere-download-file-"));
  await fs.mkdir(path.join(workspace, "artifacts"));
  const filePath = path.join(workspace, "artifacts", "report.txt");
  await fs.writeFile(filePath, "hello", "utf8");
  const telegram = new FakeTelegram();
  const bridge = new CodexAnywhereBridge(
    testConfig({ workspaceCwd: workspace }),
    "/tmp/config.json",
    "/tmp/state.json",
    {
      telegram,
      codex: new FakeCodex(),
      initialState: testState(),
    },
  );

  await bridge.handleUpdateForTest(telegramMessageUpdate("/download artifacts/report.txt"));

  assert.equal(telegram.sentDocuments.length, 1);
  assert.equal(telegram.sentDocuments[0]!.chatId, 42);
  assert.equal(telegram.sentDocuments[0]!.filePath, filePath);
  assert.match(telegram.sentDocuments[0]!.caption ?? "", /artifacts\/report\.txt/);
  assert.equal(telegram.sentMessages.length, 0);
});

test("/download photo sends an image through Telegram photo upload", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "codex-anywhere-download-photo-"));
  const filePath = path.join(workspace, "image.png");
  await fs.writeFile(filePath, Buffer.from([137, 80, 78, 71]));
  const telegram = new FakeTelegram();
  const bridge = new CodexAnywhereBridge(
    testConfig({ workspaceCwd: workspace }),
    "/tmp/config.json",
    "/tmp/state.json",
    {
      telegram,
      codex: new FakeCodex(),
      initialState: testState(),
    },
  );

  await bridge.handleUpdateForTest(telegramMessageUpdate("/download photo image.png"));

  assert.equal(telegram.sentPhotos.length, 1);
  assert.equal(telegram.sentPhotos[0]!.filePath, filePath);
  assert.equal(telegram.sentDocuments.length, 0);
});

test("/download auto sends an image through Telegram photo upload", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "codex-anywhere-download-auto-photo-"));
  const filePath = path.join(workspace, "image.png");
  await fs.writeFile(filePath, Buffer.from([137, 80, 78, 71]));
  const telegram = new FakeTelegram();
  const bridge = new CodexAnywhereBridge(
    testConfig({ workspaceCwd: workspace }),
    "/tmp/config.json",
    "/tmp/state.json",
    {
      telegram,
      codex: new FakeCodex(),
      initialState: testState(),
    },
  );

  await bridge.handleUpdateForTest(telegramMessageUpdate("/download image.png"));

  assert.equal(telegram.sentPhotos.length, 1);
  assert.equal(telegram.sentPhotos[0]!.filePath, filePath);
  assert.equal(telegram.sentDocuments.length, 0);
});

test("/download auto zips a directory before sending it", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "codex-anywhere-download-auto-zip-"));
  const directory = path.join(workspace, "artifacts");
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "report.txt"), "hello", "utf8");
  const telegram = new FakeTelegram();
  const execCalls: Array<{ file: string; args: string[]; cwd?: string }> = [];
  const bridge = new CodexAnywhereBridge(
    testConfig({ workspaceCwd: workspace }),
    "/tmp/config.json",
    "/tmp/state.json",
    {
      telegram,
      codex: new FakeCodex(),
      initialState: testState(),
      execFile: async (file, args, options) => {
        execCalls.push({ file, args, cwd: options?.cwd });
        await fs.writeFile(args[2]!, "zip", "utf8");
        return { stdout: "", stderr: "" };
      },
    },
  );

  await bridge.handleUpdateForTest(telegramMessageUpdate("/download artifacts"));

  assert.equal(execCalls[0]!.file, "zip");
  assert.equal(execCalls[0]!.cwd, directory);
  assert.equal(telegram.sentDocuments.length, 1);
  assert.match(telegram.sentDocuments[0]!.filePath, /artifacts\.zip$/);
});

test("/download allows files under the system temp directory", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "codex-anywhere-download-workspace-"));
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-anywhere-download-tmp-"));
  const filePath = path.join(tempDir, "artifact.txt");
  await fs.writeFile(filePath, "hello", "utf8");
  const telegram = new FakeTelegram();
  const bridge = new CodexAnywhereBridge(
    testConfig({ workspaceCwd: workspace }),
    "/tmp/config.json",
    "/tmp/state.json",
    {
      telegram,
      codex: new FakeCodex(),
      initialState: testState(),
    },
  );

  await bridge.handleUpdateForTest(telegramMessageUpdate(`/download ${filePath}`));

  assert.equal(telegram.sentDocuments.length, 1);
  assert.equal(telegram.sentDocuments[0]!.filePath, filePath);
});

test("/download rejects paths outside the workspace and temp directory", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "codex-anywhere-download-safe-"));
  const telegram = new FakeTelegram();
  const bridge = new CodexAnywhereBridge(
    testConfig({ workspaceCwd: workspace }),
    "/tmp/config.json",
    "/tmp/state.json",
    {
      telegram,
      codex: new FakeCodex(),
      initialState: testState(),
    },
  );

  await bridge.handleUpdateForTest(telegramMessageUpdate("/download /etc/hosts"));

  assert.equal(telegram.sentDocuments.length, 0);
  assert.equal(telegram.sentPhotos.length, 0);
  assert.match(telegram.sentMessages[0]!.text, /must stay inside/);
});

test("bridge edits the active turn control card instead of duplicating it", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-anywhere-turn-control-"));
  const configPath = path.join(tempDir, "config.json");
  const statePath = path.join(tempDir, "state.json");
  await saveConfig(configPath, testConfig());
  await saveState(statePath, {
    version: 1,
    lastUpdateId: null,
    chats: {
      "42": {
        threadId: "thread-1",
        freshThread: false,
        activeTurnId: "turn-1",
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
      },
    },
  });

  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  codex.call = async function (method: string, params?: JsonObject): Promise<JsonObject> {
    this.calls.push({ method, params });
    if (method === "thread/read") {
      return {
        thread: {
          id: "thread-1",
          status: { type: "active" },
          turns: [{ id: "turn-1", status: "inProgress" }],
        },
      };
    }
    throw new Error(`unexpected codex call: ${method}`);
  };
  const bridge = new CodexAnywhereBridge(testConfig(), configPath, statePath, {
    telegram,
    codex,
    initialState: await loadState(statePath),
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("first pending"));
  await bridge.handleUpdateForTest(telegramMessageUpdate("second pending <ok>"));

  assert.equal(telegram.sentMessages.length, 1);
  assert.equal(telegram.editedMessages.length, 1);
  assert.equal(telegram.sentMessages[0]!.parseMode, "HTML");
  assert.equal(telegram.editedMessages[0]!.parseMode, "HTML");
  assert.match(telegram.sentMessages[0]!.text, /first pending/);
  assert.match(telegram.editedMessages[0]!.text, /second pending &lt;ok&gt;/);
  assert.equal(telegram.editedMessages[0]!.messageId, 1);

  const savedState = await loadState(statePath);
  assert.equal(savedState.chats["42"]?.turnControlMessageId, 1);
  assert.equal(savedState.chats["42"]?.pendingTurnInput?.[0]?.text, "second pending <ok>");
});

test("/status renders a compact HTML status card", async () => {
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  codex.call = async function (method: string, params?: JsonObject): Promise<JsonObject> {
    this.calls.push({ method, params });
    if (method === "account/rateLimits/read") {
      return { rateLimits: { primary: { usedPercent: 25 } } };
    }
    throw new Error(`unexpected codex call: ${method}`);
  };
  const bridge = new CodexAnywhereBridge(
    testConfig({ workspaceCwd: "/tmp/codex-anywhere-workspace" }),
    "/tmp/config.json",
    "/tmp/state.json",
    {
      telegram,
      codex,
      initialState: testState(),
    },
  );

  await bridge.handleUpdateForTest(telegramMessageUpdate("/status"));

  assert.equal(telegram.sentMessages.length, 1);
  assert.equal(telegram.sentMessages[0]!.parseMode, "HTML");
  assert.match(telegram.sentMessages[0]!.text, /<b>Status<\/b>/);
  assert.match(telegram.sentMessages[0]!.text, /<b>Workspace<\/b>\n<code>\/tmp\/codex-anywhere-workspace<\/code>/);
  assert.match(telegram.sentMessages[0]!.text, /<b>Thread<\/b>\n<code>none<\/code>/);
  assert.match(telegram.sentMessages[0]!.text, /<b>Model<\/b>\n<code>default<\/code>/);
  assert.match(telegram.sentMessages[0]!.text, /Fast  <code>off<\/code>/);
  assert.match(telegram.sentMessages[0]!.text, /Approval  <code>on-request<\/code>/);
  assert.match(telegram.sentMessages[0]!.text, /<b>Rate limits<\/b>\n75% remaining/);
});

test("/model accepts reasoning efforts advertised by Codex", async () => {
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  codex.call = async function (method: string, params?: JsonObject): Promise<JsonObject> {
    this.calls.push({ method, params });
    if (method === "model/list") {
      return {
        data: [
          {
            model: "gpt-5.4",
            supportedReasoningEfforts: [
              { reasoningEffort: "low" },
              { reasoningEffort: "xhigh" },
            ],
          },
        ],
      };
    }
    throw new Error(`unexpected codex call: ${method}`);
  };
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: testState(),
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("/model gpt-5.4 xhigh"));

  assert.match(telegram.sentMessages[0]!.text, /Model override set to gpt-5\.4 \(xhigh\)/);
});

test("/model rejects reasoning efforts not advertised by Codex", async () => {
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  codex.call = async function (method: string, params?: JsonObject): Promise<JsonObject> {
    this.calls.push({ method, params });
    if (method === "model/list") {
      return {
        data: [
          {
            model: "gpt-5.4",
            supportedReasoningEfforts: [
              { reasoningEffort: "low" },
              { reasoningEffort: "medium" },
            ],
          },
        ],
      };
    }
    throw new Error(`unexpected codex call: ${method}`);
  };
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: testState(),
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("/model gpt-5.4 xhigh"));

  assert.match(telegram.sentMessages[0]!.text, /Unsupported reasoning effort/);
  assert.match(telegram.sentMessages[0]!.text, /Supported: low\|medium/);
});

test("/reload requires an existing current thread", async () => {
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: testState(),
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("/reload"));

  assert.equal(codex.calls.length, 0);
  assert.match(telegram.sentMessages[0]!.text, /No current thread/);
});

test("/reload refreshes only the current thread state and preview", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-anywhere-reload-"));
  const configPath = path.join(tempDir, "config.json");
  const statePath = path.join(tempDir, "state.json");
  const state = testState();
  state.chats["42"] = testChatState({
    threadId: "thread-1",
    activeTurnId: "stale-turn",
    lastAssistantMessage: "old answer",
  });
  await saveState(statePath, state);

  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  codex.call = async function (method: string, params?: JsonObject): Promise<JsonObject> {
    this.calls.push({ method, params });
    if (method === "thread/read") {
      return {
        thread: {
          id: "thread-1",
          status: { type: "active" },
          turns: [
            {
              id: "turn-1",
              status: "completed",
              items: [
                { type: "userMessage", content: [{ text: "old request" }] },
                { type: "agentMessage", text: "old answer" },
              ],
            },
            {
              id: "turn-2",
              status: "inProgress",
              items: [
                { type: "userMessage", content: [{ text: "desktop request" }] },
                { type: "agentMessage", text: "desktop answer" },
              ],
            },
          ],
        },
      };
    }
    throw new Error(`unexpected codex call: ${method}`);
  };
  const bridge = new CodexAnywhereBridge(testConfig(), configPath, statePath, {
    telegram,
    codex,
    initialState: await loadState(statePath),
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("/reload"));

  assert.deepEqual(codex.calls.map((call) => call.method), ["thread/read"]);
  assert.equal(codex.calls[0]!.params?.threadId, "thread-1");
  assert.equal(codex.calls[0]!.params?.includeTurns, true);
  const savedState = await loadState(statePath);
  assert.equal(savedState.chats["42"]?.threadId, "thread-1");
  assert.equal(savedState.chats["42"]?.activeTurnId, "turn-2");
  assert.equal(savedState.chats["42"]?.lastAssistantMessage, "desktop answer");
  assert.match(telegram.sentMessages[0]!.text, /Session reloaded/);
  assert.match(telegram.sentMessages[0]!.text, /desktop request/);
  assert.match(telegram.sentMessages[0]!.text, /desktop answer/);
});

test("/reload materializes the current thread before reading history", async () => {
  const state = testState();
  state.chats["42"] = testChatState({
    threadId: "thread-1",
    model: "gpt-test",
  });
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  let readCount = 0;
  codex.call = async function (method: string, params?: JsonObject): Promise<JsonObject> {
    this.calls.push({ method, params });
    if (method === "thread/read") {
      readCount += 1;
      if (readCount === 1) {
        return { thread: { id: "thread-1", status: { type: "notLoaded" } } };
      }
      return {
        thread: {
          id: "thread-1",
          status: { type: "completed" },
          turns: [
            {
              id: "turn-1",
              status: "completed",
              items: [
                { type: "userMessage", content: [{ text: "desktop request" }] },
                { type: "agentMessage", text: "desktop answer" },
              ],
            },
          ],
        },
      };
    }
    if (method === "thread/resume") {
      return {};
    }
    throw new Error(`unexpected codex call: ${method}`);
  };
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: state,
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("/reload"));

  assert.deepEqual(codex.calls.map((call) => call.method), [
    "thread/read",
    "thread/resume",
    "thread/read",
  ]);
  assert.equal(codex.calls[1]!.params?.threadId, "thread-1");
  assert.equal(codex.calls[1]!.params?.model, "gpt-test");
  assert.equal(codex.calls[1]!.params?.cwd, testConfig().workspaceCwd);
  assert.match(telegram.sentMessages[0]!.text, /Session reloaded/);
  assert.match(telegram.sentMessages[0]!.text, /desktop answer/);
});

test("/reload rejects direct session ids", async () => {
  const state = testState();
  state.chats["42"] = testChatState({ threadId: "thread-1" });
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: state,
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("/reload thread-2"));

  assert.equal(codex.calls.length, 0);
  assert.equal(telegram.sentMessages[0]!.text, "Usage: /reload");
});

test("/reload explains unavailable local thread state", async () => {
  const state = testState();
  state.chats["42"] = testChatState({ threadId: "thread-foreign" });
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  codex.call = async function (method: string, params?: JsonObject): Promise<JsonObject> {
    this.calls.push({ method, params });
    if (method === "thread/read") {
      return { thread: { id: "thread-foreign", status: { type: "notLoaded" } } };
    }
    if (method === "thread/resume") {
      throw new Error("no rollout found for thread id thread-foreign");
    }
    throw new Error(`unexpected codex call: ${method}`);
  };
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: state,
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("/reload"));

  assert.deepEqual(codex.calls.map((call) => call.method), ["thread/read", "thread/resume"]);
  assert.match(telegram.sentMessages[0]!.text, /Current stored thread could not be loaded/);
  assert.match(telegram.sentMessages[0]!.text, /saved thread id/);
  assert.match(telegram.sentMessages[0]!.text, /\/resume or \/continue/);
});

test("/goal requires an existing current thread", async () => {
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: testState(),
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("/goal"));

  assert.equal(codex.calls.length, 0);
  assert.match(telegram.sentMessages[0]!.text, /No current thread/);
});

test("/goal reads and renders the current thread goal", async () => {
  const state = testState();
  state.chats["42"] = testChatState({ threadId: "thread-1" });
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  codex.call = async function (method: string, params?: JsonObject): Promise<JsonObject> {
    this.calls.push({ method, params });
    if (method === "thread/goal/get") {
      return {
        goal: {
          threadId: "thread-1",
          objective: "Keep Telegram continuity stable",
          status: "active",
          tokenBudget: 50000,
          tokensUsed: 123,
          timeUsedSeconds: 9,
        },
      };
    }
    throw new Error(`unexpected codex call: ${method}`);
  };
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: state,
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("/goal"));

  assert.deepEqual(codex.calls.map((call) => call.method), ["thread/goal/get"]);
  assert.match(telegram.sentMessages[0]!.text, /Keep Telegram continuity stable/);
  assert.match(telegram.sentMessages[0]!.text, /<b>Status<\/b>\nactive/);
});

test("/goal status aliases goal get", async () => {
  const state = testState();
  state.chats["42"] = testChatState({ threadId: "thread-1" });
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  codex.call = async function (method: string, params?: JsonObject): Promise<JsonObject> {
    this.calls.push({ method, params });
    if (method === "thread/goal/get") {
      return { goal: null };
    }
    throw new Error(`unexpected codex call: ${method}`);
  };
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: state,
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("/goal status"));

  assert.deepEqual(codex.calls.map((call) => call.method), ["thread/goal/get"]);
  assert.match(telegram.sentMessages[0]!.text, /No goal is currently set/);
});

test("/goal set creates or updates the current thread goal", async () => {
  const state = testState();
  state.chats["42"] = testChatState({ threadId: "thread-1" });
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  codex.call = async function (method: string, params?: JsonObject): Promise<JsonObject> {
    this.calls.push({ method, params });
    if (method === "thread/goal/set") {
      return {
        goal: {
          threadId: "thread-1",
          objective: params?.objective,
          status: "active",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
        },
      };
    }
    throw new Error(`unexpected codex call: ${method}`);
  };
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: state,
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("/goal set Investigate reload continuity"));

  assert.deepEqual(codex.calls.map((call) => call.method), ["thread/goal/set"]);
  assert.equal(codex.calls[0]!.params?.threadId, "thread-1");
  assert.equal(codex.calls[0]!.params?.objective, "Investigate reload continuity");
  assert.match(telegram.sentMessages[0]!.text, /Investigate reload continuity/);
});

test("/goal clear clears the current thread goal", async () => {
  const state = testState();
  state.chats["42"] = testChatState({ threadId: "thread-1" });
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  codex.call = async function (method: string, params?: JsonObject): Promise<JsonObject> {
    this.calls.push({ method, params });
    if (method === "thread/goal/clear") {
      return { cleared: true };
    }
    throw new Error(`unexpected codex call: ${method}`);
  };
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: state,
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("/goal clear"));

  assert.deepEqual(codex.calls.map((call) => call.method), ["thread/goal/clear"]);
  assert.match(telegram.sentMessages[0]!.text, /Goal cleared\./);
});

test("/goal reports feature-unavailable failures cleanly", async () => {
  const state = testState();
  state.chats["42"] = testChatState({ threadId: "thread-1" });
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  codex.call = async function (method: string, params?: JsonObject): Promise<JsonObject> {
    this.calls.push({ method, params });
    if (method === "thread/goal/get") {
      throw new Error('{\"code\":-32601,\"message\":\"unknown method thread/goal/get\"}');
    }
    throw new Error(`unexpected codex call: ${method}`);
  };
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: state,
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("/goal"));

  assert.match(telegram.sentMessages[0]!.text, /Goals are not enabled or not supported/);
});

test("/account shows the active Codex account", async () => {
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  codex.call = async function (method: string, params?: JsonObject): Promise<JsonObject> {
    this.calls.push({ method, params });
    if (method === "account/read") {
      return {
        account: {
          type: "chatgpt",
          email: "user@example.com",
          planType: "pro",
        },
        requiresOpenaiAuth: true,
      };
    }
    throw new Error(`unexpected codex call: ${method}`);
  };
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: testState(),
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("/account"));

  assert.deepEqual(codex.calls, [{ method: "account/read", params: { refreshToken: false } }]);
  assert.equal(telegram.sentMessages[0]!.parseMode, "HTML");
  assert.match(telegram.sentMessages[0]!.text, /user@example\.com/);
  assert.match(telegram.sentMessages[0]!.text, /pro/);
});

test("/account login starts the ChatGPT device-code flow", async () => {
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  codex.call = async function (method: string, params?: JsonObject): Promise<JsonObject> {
    this.calls.push({ method, params });
    if (method === "account/login/start") {
      return {
        type: "chatgptDeviceCode",
        loginId: "login-1",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-1234",
      };
    }
    throw new Error(`unexpected codex call: ${method}`);
  };
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: testState(),
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("/account login"));

  assert.deepEqual(codex.calls, [
    { method: "account/login/start", params: { type: "chatgptDeviceCode" } },
  ]);
  assert.match(telegram.sentMessages[0]!.text, /ABCD-1234/);
  assert.match(telegram.sentMessages[0]!.text, /auth\.openai\.com/);
});

test("/account switch logs out before starting login", async () => {
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  codex.call = async function (method: string, params?: JsonObject): Promise<JsonObject> {
    this.calls.push({ method, params });
    if (method === "account/logout") {
      return {};
    }
    if (method === "account/login/start") {
      return {
        type: "chatgptDeviceCode",
        loginId: "login-1",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-1234",
      };
    }
    throw new Error(`unexpected codex call: ${method}`);
  };
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: testState(),
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("/account switch"));

  assert.deepEqual(codex.calls, [
    { method: "account/logout", params: undefined },
    { method: "account/login/start", params: { type: "chatgptDeviceCode" } },
  ]);
  assert.match(telegram.sentMessages[0]!.text, /account switch started/);
});

test("account login completion reports the refreshed account", async () => {
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  codex.call = async function (method: string, params?: JsonObject): Promise<JsonObject> {
    this.calls.push({ method, params });
    if (method === "account/login/start") {
      return {
        type: "chatgptDeviceCode",
        loginId: "login-1",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-1234",
      };
    }
    if (method === "account/read") {
      return {
        account: {
          type: "chatgpt",
          email: "new@example.com",
          planType: "plus",
        },
        requiresOpenaiAuth: true,
      };
    }
    throw new Error(`unexpected codex call: ${method}`);
  };
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: testState(),
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("/account login"));
  await bridge.handleNotificationForTest("account/login/completed", {
    loginId: "login-1",
    success: true,
    error: null,
  });

  assert.equal(codex.calls[1]!.method, "account/read");
  assert.deepEqual(codex.calls[1]!.params, { refreshToken: true });
  assert.match(telegram.sentMessages[1]!.text, /new@example\.com/);
});

test("/version reports the installed package version", async () => {
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: testState(),
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("/version"));

  assert.equal(telegram.sentMessages.length, 1);
  assert.equal(telegram.sentMessages[0]!.parseMode, undefined);
  assert.match(telegram.sentMessages[0]!.text, /^codex-anywhere \d+\.\d+\.\d+/);
});

test("/upgrade installs latest package and schedules a supervised official service restart", async () => {
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  const execCalls: Array<{ file: string; args: string[]; cwd?: string }> = [];
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: testState(),
    execFile: async (file, args, options) => {
      execCalls.push({ file, args, cwd: options?.cwd });
      if (file === "npm" && args.join(" ") === "install -g codex-anywhere@latest") {
        return { stdout: "changed 1 package\n", stderr: "" };
      }
      if (file === "npm" && args.join(" ") === "root -g") {
        return { stdout: "/opt/homebrew/lib/node_modules\n", stderr: "" };
      }
      if (file === process.execPath) {
        return { stdout: "codex-anywhere 0.3.15\n", stderr: "" };
      }
      return { stdout: "restarted\n", stderr: "" };
    },
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("/upgrade"));

  assert.deepEqual(execCalls.slice(0, 1), [
    {
      file: "npm",
      args: ["install", "-g", "codex-anywhere@latest"],
      cwd: testConfig().workspaceCwd,
    },
  ]);
  assert.deepEqual(execCalls[1], {
    file: "npm",
    args: ["root", "-g"],
    cwd: testConfig().workspaceCwd,
  });
  assert.deepEqual(execCalls[2], {
    file: process.execPath,
    args: ["/opt/homebrew/lib/node_modules/codex-anywhere/dist/cli.js", "--version"],
    cwd: testConfig().workspaceCwd,
  });
  assert.equal(execCalls.length, 4);
  assert.equal(execCalls[3]!.file, "sh");
  assert.deepEqual(execCalls[3]!.args.slice(0, 1), ["-c"]);
  const restartCommand = execCalls[3]!.args[1]!;
  assert.match(restartCommand, /codex-anywhere\/dist\/cli\.js/);
  assert.match(restartCommand, /codex-anywhere restart-service attempt/);
  assert.match(restartCommand, /codex-anywhere restart-service succeeded/);
  assert.match(restartCommand, /codex-anywhere install-service attempt/);
  assert.match(restartCommand, /codex-anywhere install-service succeeded/);
  assert.match(restartCommand, /upgrade-restart\.log/);
  if (process.platform === "darwin") {
    assert.match(restartCommand, /launchctl bootstrap/);
    assert.match(restartCommand, /ai\.mempat\.codex-anywhere\.upgrade-restart/);
    assert.doesNotMatch(restartCommand, /nohup sh -c 'sleep 3/);
  } else if (process.platform === "linux") {
    assert.match(restartCommand, /systemd-run --user/);
    assert.match(restartCommand, /codex-anywhere-upgrade-restart/);
    assert.match(restartCommand, /command -v systemd-run/);
  } else {
    assert.match(restartCommand, /nohup sh -c/);
  }
  assert.doesNotMatch(restartCommand, /\n  if codex-anywhere restart-service/);
  assert.doesNotMatch(restartCommand, /do;/);
  assert.doesNotMatch(restartCommand, /then;/);
  assert.equal(execCalls[3]!.cwd, testConfig().workspaceCwd);
  assert.equal(telegram.sentMessages.length, 2);
  assert.equal(telegram.sentMessages[0]!.parseMode, "HTML");
  assert.match(telegram.sentMessages[0]!.text, /Upgrade started/);
  assert.match(telegram.sentMessages[1]!.text, /Upgrade installed/);
  assert.match(telegram.sentMessages[1]!.text, /codex-anywhere 0\.3\.15/);
  assert.match(telegram.sentMessages[1]!.text, /supervised service restart/);
});

test("/upgrade reports installed CLI verification failures", async () => {
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  const execCalls: string[] = [];
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: testState(),
    execFile: async (file, args) => {
      execCalls.push(`${file} ${args.join(" ")}`);
      if (file === "npm" && args.join(" ") === "install -g codex-anywhere@latest") {
        return { stdout: "changed 1 package\n", stderr: "" };
      }
      if (file === "npm" && args.join(" ") === "root -g") {
        return { stdout: "/opt/homebrew/lib/node_modules\n", stderr: "" };
      }
      return { stdout: "unexpected tool output\n", stderr: "" };
    },
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("/upgrade"));

  assert.deepEqual(execCalls, [
    "npm install -g codex-anywhere@latest",
    "npm root -g",
    `${process.execPath} /opt/homebrew/lib/node_modules/codex-anywhere/dist/cli.js --version`,
  ]);
  assert.equal(telegram.sentMessages.length, 2);
  assert.match(telegram.sentMessages[1]!.text, /Upgrade failed/);
  assert.match(telegram.sentMessages[1]!.text, /did not report a valid version/);
});

test("/upgrade test runs the supervised restart probe without installing", async () => {
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-anywhere-upgrade-test-"));
  const execCalls: Array<{ file: string; args: string[] }> = [];
  const bridge = new CodexAnywhereBridge(testConfig(), path.join(tempDir, "config.json"), path.join(tempDir, "state.json"), {
    telegram,
    codex,
    initialState: testState(),
    execFile: async (file, args) => {
      execCalls.push({ file, args });
      assert.equal(file, "sh");
      const command = args[1] ?? "";
      const markerMatch = /([/\w.-]+upgrade-restart-test-([a-f0-9]+)\.ok)/.exec(command);
      assert.ok(markerMatch);
      await fs.mkdir(path.dirname(markerMatch[1]!), { recursive: true });
      await fs.writeFile(markerMatch[1]!, markerMatch[2]!, "utf8");
      return { stdout: "", stderr: "" };
    },
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("/upgrade test"));

  assert.equal(execCalls.length, 1);
  const restartCommand = execCalls[0]!.args[1]!;
  assert.match(restartCommand, /upgrade-restart-test/);
  assert.doesNotMatch(restartCommand, /npm install/);
  assert.equal(telegram.sentMessages.length, 2);
  assert.match(telegram.sentMessages[0]!.text, /Upgrade self-test started/);
  assert.match(telegram.sentMessages[1]!.text, /Upgrade self-test passed/);
  assert.match(telegram.sentMessages[1]!.text, /supervised helper ran/);
});

test("/upgrade rejects arguments", async () => {
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  const execCalls: string[] = [];
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: testState(),
    execFile: async (file) => {
      execCalls.push(file);
      return { stdout: "", stderr: "" };
    },
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("/upgrade 0.3.3"));

  assert.deepEqual(execCalls, []);
  assert.equal(telegram.sentMessages[0]!.text, "Usage: /upgrade\n/upgrade test");
});

test("/upgrade reports install failures", async () => {
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: testState(),
    execFile: async () => {
      throw new Error("npm permission denied");
    },
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("/upgrade"));

  assert.equal(telegram.sentMessages.length, 2);
  assert.match(telegram.sentMessages[1]!.text, /Upgrade failed/);
  assert.match(telegram.sentMessages[1]!.text, /npm permission denied/);
});

test("/resume lists only sessions for the current workspace", async () => {
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  codex.call = async function (method: string, params?: JsonObject): Promise<JsonObject> {
    this.calls.push({ method, params });
    if (method === "thread/list") {
      return { data: [] };
    }
    throw new Error(`unexpected codex call: ${method}`);
  };
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: testState(),
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("/resume"));

  assert.equal(codex.calls[0]!.method, "thread/list");
  assert.equal(codex.calls[0]!.params?.cwd, testConfig().workspaceCwd);
});

test("/continue lists sessions globally without cwd filtering", async () => {
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  codex.call = async function (method: string, params?: JsonObject): Promise<JsonObject> {
    this.calls.push({ method, params });
    if (method === "thread/list") {
      return { data: [] };
    }
    throw new Error(`unexpected codex call: ${method}`);
  };
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: testState(),
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("/continue"));

  assert.equal(codex.calls[0]!.method, "thread/list");
  assert.equal("cwd" in (codex.calls[0]!.params ?? {}), false);
});

test("/continue shows a More button when more sessions are available", async () => {
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  codex.call = async function (method: string, params?: JsonObject): Promise<JsonObject> {
    this.calls.push({ method, params });
    if (method === "thread/list") {
      return {
        data: [{ id: "019d6fef-786e-74a1-a59b-400820c026b0", preview: "session", updatedAt: 1, status: { type: "idle" }, source: "cli" }],
        nextCursor: "cursor-2",
      };
    }
    throw new Error(`unexpected codex call: ${method}`);
  };
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: testState(),
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("/continue"));

  assert.equal(telegram.sentMessages.at(-1)!.text, "Load more sessions...");
  const replyMarkup = telegram.sentMessages.at(-1)!.replyMarkup as {
    inline_keyboard: Array<Array<{ text?: string }>>;
  };
  assert.equal(replyMarkup.inline_keyboard[0]![0]!.text, "Load more sessions...");
});

test("tapping More on /continue fetches the next page with the cursor", async () => {
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  codex.call = async function (method: string, params?: JsonObject): Promise<JsonObject> {
    this.calls.push({ method, params });
    if (method === "thread/list" && !params?.cursor) {
      return {
        data: [{ id: "019d6fef-786e-74a1-a59b-400820c026b0", preview: "session", updatedAt: 1, status: { type: "idle" }, source: "cli" }],
        nextCursor: "cursor-2",
      };
    }
    if (method === "thread/list" && params?.cursor === "cursor-2") {
      return {
        data: [{ id: "019d6ff0-786e-74a1-a59b-400820c026b0", preview: "session-2", updatedAt: 2, status: { type: "idle" }, source: "cli" }],
      };
    }
    throw new Error(`unexpected codex call: ${method}`);
  };
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: testState(),
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("/continue"));
  const callbackData = (telegram.sentMessages.at(-1)!.replyMarkup as { inline_keyboard: Array<Array<{ callback_data?: string }>> })
    .inline_keyboard[0]![0]!.callback_data!;
  await bridge.handleUpdateForTest(telegramCallbackUpdate(callbackData));

  assert.equal(codex.calls[1]!.method, "thread/list");
  assert.equal(codex.calls[1]!.params?.cursor, "cursor-2");
  assert.match(telegram.sentMessages.at(-2)!.text, /More Sessions/);
});

test("/continue rejects malformed direct session ids", async () => {
  const telegram = new FakeTelegram();
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex: new FakeCodex(),
    initialState: testState(),
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("/continue latest"));

  assert.match(telegram.sentMessages[0]!.text, /Usage: \/continue \[exact-session-id]/);
});

test("/continue <session-id> takes over immediately when the session is in the same workspace", async () => {
  const threadId = "019d6fef-786e-74a1-a59b-400820c026b0";
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  codex.call = async function (method: string, params?: JsonObject): Promise<JsonObject> {
    this.calls.push({ method, params });
    if (method === "thread/read") {
      return {
        thread: {
          id: threadId,
          cwd: testConfig().workspaceCwd,
          turns: [
            {
              items: [
                { type: "userMessage", content: [{ text: "first question" }] },
                { type: "agentMessage", text: "first answer" },
              ],
            },
          ],
        },
      };
    }
    if (method === "thread/resume") {
      return {};
    }
    throw new Error(`unexpected codex call: ${method}`);
  };
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: testState(),
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate(`/continue ${threadId}`));

  assert.deepEqual(
    codex.calls.map((call) => call.method),
    ["thread/read", "thread/resume", "thread/read"],
  );
  assert.match(telegram.sentMessages[0]!.text, /Took over session/);
  assert.match(telegram.sentMessages[0]!.text, /Recent History/);
});

test("/continue <session-id> asks before switching workspace", async () => {
  const threadId = "019d6fef-786e-74a1-a59b-400820c026b0";
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  codex.call = async function (method: string, params?: JsonObject): Promise<JsonObject> {
    this.calls.push({ method, params });
    if (method === "thread/read") {
      return { thread: { id: threadId, cwd: "/tmp/other-workspace" } };
    }
    throw new Error(`unexpected codex call: ${method}`);
  };
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: testState(),
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate(`/continue ${threadId}`));

  assert.equal(codex.calls.length, 1);
  assert.match(telegram.sentMessages[0]!.text, /Continue session from another workspace/);
  assert.match(telegram.sentMessages[0]!.text, /Current workspace:/);
  assert.match(telegram.sentMessages[0]!.text, /Target workspace:/);
});

test("global /continue picker asks before taking over a session from another workspace", async () => {
  const threadId = "019d6fef-786e-74a1-a59b-400820c026b0";
  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  codex.call = async function (method: string, params?: JsonObject): Promise<JsonObject> {
    this.calls.push({ method, params });
    if (method === "thread/list") {
      return {
        data: [{ id: threadId, preview: "foreign session", updatedAt: 1, status: { type: "idle" }, source: "cli" }],
      };
    }
    if (method === "thread/read") {
      return { thread: { id: threadId, cwd: "/tmp/other-workspace", updatedAt: 1, status: { type: "idle" }, source: "cli" } };
    }
    throw new Error(`unexpected codex call: ${method}`);
  };
  const bridge = new CodexAnywhereBridge(testConfig(), "/tmp/config.json", "/tmp/state.json", {
    telegram,
    codex,
    initialState: testState(),
  });

  await bridge.handleUpdateForTest(telegramMessageUpdate("/continue"));
  const callbackData = (telegram.sentMessages[1]!.replyMarkup as { inline_keyboard: Array<Array<{ callback_data?: string }>> })
    .inline_keyboard[0]![0]!.callback_data!;
  await bridge.handleUpdateForTest(telegramCallbackUpdate(callbackData));

  assert.deepEqual(codex.calls.map((call) => call.method), ["thread/list", "thread/read"]);
  assert.match(telegram.sentMessages.at(-1)!.text, /Continue session from another workspace/);
});

test("approving cross-workspace /continue updates workspace and resumes the target thread", async () => {
  const threadId = "019d6fef-786e-74a1-a59b-400820c026b0";
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-anywhere-continue-approve-"));
  const currentWorkspace = path.join(tempDir, "workspace-a");
  const targetWorkspace = path.join(tempDir, "workspace-b");
  await fs.mkdir(currentWorkspace, { recursive: true });
  await fs.mkdir(targetWorkspace, { recursive: true });
  const configPath = path.join(tempDir, "config.json");
  const statePath = path.join(tempDir, "state.json");
  await saveConfig(configPath, testConfig({ workspaceCwd: currentWorkspace }));
  await saveState(statePath, testState());

  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  codex.call = async function (method: string, params?: JsonObject): Promise<JsonObject> {
    this.calls.push({ method, params });
    if (method === "thread/read") {
      return {
        thread: {
          id: threadId,
          cwd: targetWorkspace,
          turns: [
            {
              items: [
                { type: "userMessage", content: [{ text: "prior request" }] },
                { type: "agentMessage", text: "prior answer" },
              ],
            },
          ],
        },
      };
    }
    if (method === "thread/resume") {
      return {};
    }
    throw new Error(`unexpected codex call: ${method}`);
  };
  const bridge = new CodexAnywhereBridge(
    testConfig({ workspaceCwd: currentWorkspace }),
    configPath,
    statePath,
    {
      telegram,
      codex,
      initialState: await loadState(statePath),
    },
  );

  await bridge.handleUpdateForTest(telegramMessageUpdate(`/continue ${threadId}`));
  const callbackData = (telegram.sentMessages[0]!.replyMarkup as { inline_keyboard: Array<Array<{ callback_data?: string }>> })
    .inline_keyboard[0]![0]!.callback_data!;
  await bridge.handleUpdateForTest(telegramCallbackUpdate(callbackData));

  const savedConfig = await loadConfig(configPath);
  const savedState = await loadState(statePath);
  assert.equal(savedConfig?.workspaceCwd, targetWorkspace);
  assert.equal(savedState.chats["42"]?.threadId, threadId);
  assert.equal(savedState.chats["42"]?.activeTurnId, null);
  assert.match(telegram.sentMessages.at(-1)!.text, /Switched workspace to/);
  assert.match(telegram.sentMessages.at(-1)!.text, /Took over session/);
  assert.match(telegram.sentMessages.at(-1)!.text, /Recent History/);
});

test("cancelling cross-workspace /continue preserves the current workspace and thread state", async () => {
  const threadId = "019d6fef-786e-74a1-a59b-400820c026b0";
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-anywhere-continue-cancel-"));
  const currentWorkspace = path.join(tempDir, "workspace-a");
  const targetWorkspace = path.join(tempDir, "workspace-b");
  await fs.mkdir(currentWorkspace, { recursive: true });
  await fs.mkdir(targetWorkspace, { recursive: true });
  const configPath = path.join(tempDir, "config.json");
  const statePath = path.join(tempDir, "state.json");
  await saveConfig(configPath, testConfig({ workspaceCwd: currentWorkspace }));
  await saveState(statePath, {
    version: 1,
    lastUpdateId: null,
    chats: {
      "42": {
        threadId: "thread-1",
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
        sandboxMode: null,
        lastAssistantMessage: null,
      },
    },
  });

  const telegram = new FakeTelegram();
  const codex = new FakeCodex();
  codex.call = async function (method: string, params?: JsonObject): Promise<JsonObject> {
    this.calls.push({ method, params });
    if (method === "thread/read") {
      return { thread: { id: threadId, cwd: targetWorkspace } };
    }
    throw new Error(`unexpected codex call: ${method}`);
  };
  const bridge = new CodexAnywhereBridge(
    testConfig({ workspaceCwd: currentWorkspace }),
    configPath,
    statePath,
    {
      telegram,
      codex,
      initialState: await loadState(statePath),
    },
  );

  await bridge.handleUpdateForTest(telegramMessageUpdate(`/continue ${threadId}`));
  const callbackData = (telegram.sentMessages[0]!.replyMarkup as { inline_keyboard: Array<Array<{ callback_data?: string }>> })
    .inline_keyboard[0]![1]!.callback_data!;
  await bridge.handleUpdateForTest(telegramCallbackUpdate(callbackData));

  const savedConfig = await loadConfig(configPath);
  const savedState = await loadState(statePath);
  assert.equal(savedConfig?.workspaceCwd, currentWorkspace);
  assert.equal(savedState.chats["42"]?.threadId, "thread-1");
  assert.equal(codex.calls.length, 1);
  assert.equal(telegram.callbackAnswers.at(-1), "Cancelled");
});

test("session ownership lock prevents a second bot from taking over the same session", async () => {
  const registry = new InMemorySessionOwnershipRegistry();
  const threadId = "019d6fef-786e-74a1-a59b-400820c026b0";

  const telegramA = new FakeTelegram();
  const codexA = new FakeCodex();
  codexA.call = async function (method: string, params?: JsonObject): Promise<JsonObject> {
    this.calls.push({ method, params });
    if (method === "thread/read") {
      return { thread: { id: threadId, cwd: process.cwd(), updatedAt: 1, status: { type: "idle" }, source: "cli" } };
    }
    if (method === "thread/resume") {
      return {};
    }
    throw new Error(`unexpected codex call: ${method}`);
  };
  const bridgeA = new CodexAnywhereBridge(
    testConfig({ id: "bot-a", label: "bot-a" }),
    "/tmp/config-a.json",
    "/tmp/state-a.json",
    {
      telegram: telegramA,
      codex: codexA,
      initialState: testState(),
      botId: "bot-a",
      botLabel: "bot-a",
      sessionOwnership: registry,
    },
  );

  const telegramB = new FakeTelegram();
  const codexB = new FakeCodex();
  codexB.call = async function (method: string, params?: JsonObject): Promise<JsonObject> {
    this.calls.push({ method, params });
    if (method === "thread/read") {
      return { thread: { id: threadId, cwd: process.cwd(), updatedAt: 1, status: { type: "idle" }, source: "cli" } };
    }
    if (method === "thread/resume") {
      return {};
    }
    throw new Error(`unexpected codex call: ${method}`);
  };
  const bridgeB = new CodexAnywhereBridge(
    testConfig({ id: "bot-b", label: "bot-b" }),
    "/tmp/config-b.json",
    "/tmp/state-b.json",
    {
      telegram: telegramB,
      codex: codexB,
      initialState: testState(),
      botId: "bot-b",
      botLabel: "bot-b",
      sessionOwnership: registry,
    },
  );

  await bridgeA.handleUpdateForTest(telegramMessageUpdate(`/continue ${threadId}`));
  await bridgeB.handleUpdateForTest(telegramMessageUpdate(`/continue ${threadId}`));

  assert.equal(codexA.calls.some((call) => call.method === "thread/resume"), true);
  assert.equal(codexB.calls.some((call) => call.method === "thread/resume"), false);
  assert.match(telegramB.sentMessages.at(-1)!.text, /already owned by Telegram bot bot-a/);
});
