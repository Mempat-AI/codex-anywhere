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
  JsonObject,
  StoredConfig,
  StoredState,
  TelegramBotCommand,
  TelegramUpdate,
} from "../src/types.js";

class FakeTelegram {
  readonly sentMessages: Array<{ chatId: number; text: string; replyMarkup?: JsonObject; parseMode?: string }> = [];
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
  ): Promise<{ message_id: number }> {
    this.sentMessages.push({ chatId, text, replyMarkup, parseMode });
    return { message_id: this.sentMessages.length };
  }

  async editMessageText(): Promise<void> {}

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

function telegramMessageUpdate(text: string): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: 42, type: "private" },
      from: { id: 1 },
      text,
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
