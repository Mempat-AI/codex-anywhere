import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile as execFileCallback } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import { CodexAnywhereBridge } from "../src/bridge.js";
import { CodexAppServerClient } from "../src/codexAppServer.js";
import { loadState, saveConfig } from "../src/persistence.js";
import type {
  JsonObject,
  StoredConfig,
  TelegramBotCommand,
  TelegramUpdate,
} from "../src/types.js";

const runRealBackend = process.env.CODEX_ANYWHERE_REAL_BACKEND === "1";
const execFileAsync = promisify(execFileCallback);

class FakeTelegram {
  readonly commands: TelegramBotCommand[][] = [];
  readonly sentMessages: Array<{
    chatId: number;
    text: string;
    replyMarkup?: JsonObject;
    parseMode?: string;
  }> = [];

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
    replyMarkup?: JsonObject,
    parseMode?: string,
  ): Promise<{ message_id: number }> {
    this.sentMessages.push({ chatId, text, replyMarkup, parseMode });
    return { message_id: this.sentMessages.length };
  }

  async editMessageText(): Promise<void> {}

  async answerCallbackQuery(): Promise<void> {}

  async deleteMessage(): Promise<void> {}
}

function testConfig(workspaceCwd: string): StoredConfig {
  return {
    version: 1,
    telegramBotToken: "test-token",
    workspaceCwd,
    ownerUserId: 1,
    pollTimeoutSeconds: 1,
    streamEditIntervalMs: 100,
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

test(
  "bridge smoke-tests representative slash commands against the real Codex backend",
  { skip: !runRealBackend },
  async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-anywhere-real-backend-"));
    const workspaceDir = path.join(tempDir, "workspace");
    const configPath = path.join(tempDir, "config.json");
    const statePath = path.join(tempDir, "state.json");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "README.md"), "# temp\n", "utf8");
    await saveConfig(configPath, testConfig(workspaceDir));

    const telegram = new FakeTelegram();
    const codex = new CodexAppServerClient();
    const bridge = new CodexAnywhereBridge(
      testConfig(workspaceDir),
      configPath,
      statePath,
      { telegram, codex },
    );

    try {
      await bridge.initialize({ printStartupHelp: false });

      await bridge.handleUpdateForTest(telegramMessageUpdate(1, "/new"));
      assert.match(telegram.sentMessages.at(-1)?.text ?? "", /Started a fresh Codex thread/);

      const stateAfterNew = await loadState(statePath);
      assert.ok(stateAfterNew.chats["42"]?.threadId);

      await bridge.handleUpdateForTest(telegramMessageUpdate(2, "/resume"));
      const resumeMessages = telegram.sentMessages.slice(1);
      assert.ok(
        resumeMessages.some((message) => message.text.includes("Sessions") || message.text.includes("No recent sessions were found.")),
        "expected /resume to render a workspace-scoped session result",
      );

      await bridge.handleUpdateForTest(telegramMessageUpdate(3, "/continue"));
      const continueMessages = telegram.sentMessages.slice(2);
      assert.ok(
        continueMessages.some((message) => message.text.includes("All Sessions")),
        "expected /continue to render the global session picker header",
      );

      const threadId = stateAfterNew.chats["42"]?.threadId;
      assert.ok(threadId);
      await bridge.handleUpdateForTest(telegramMessageUpdate(4, `/continue ${threadId}`));
      assert.match(telegram.sentMessages.at(-1)?.text ?? "", /Took over session/);

      await bridge.handleUpdateForTest(telegramMessageUpdate(5, "/status"));
      assert.match(telegram.sentMessages.at(-1)?.text ?? "", new RegExp(`workspace: ${workspaceDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.match(telegram.sentMessages.at(-1)?.text ?? "", /thread: /);

      await bridge.handleUpdateForTest(telegramMessageUpdate(6, "/model status"));
      assert.match(telegram.sentMessages.at(-1)?.text ?? "", /Available models:/);

      await bridge.handleUpdateForTest(telegramMessageUpdate(7, "/permissions status"));
      assert.match(telegram.sentMessages.at(-1)?.text ?? "", /approval policy:/);
    } finally {
      await codex.close();
    }
  },
);

test(
  "bridge exercises the full safe Telegram command surface against the real Codex backend",
  { skip: !runRealBackend },
  async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-anywhere-real-commands-"));
    const workspaceDir = path.join(tempDir, "workspace");
    const configPath = path.join(tempDir, "config.json");
    const statePath = path.join(tempDir, "state.json");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "README.md"), "# temp\n", "utf8");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "# existing\n", "utf8");
    await execFileAsync("git", ["init"], { cwd: workspaceDir });
    await saveConfig(configPath, testConfig(workspaceDir));

    const telegram = new FakeTelegram();
    const codex = new CodexAppServerClient();
    const bridge = new CodexAnywhereBridge(
      testConfig(workspaceDir),
      configPath,
      statePath,
      { telegram, codex },
    );

    async function expectCommand(
      updateId: number,
      text: string,
      matcher?: RegExp,
    ): Promise<void> {
      const before = telegram.sentMessages.length;
      await bridge.handleUpdateForTest(telegramMessageUpdate(updateId, text));
      const after = telegram.sentMessages.length;
      assert.ok(after > before, `expected ${text} to send at least one Telegram message`);
      if (matcher) {
        const messageTexts = telegram.sentMessages.slice(before).map((message) => message.text).join("\n");
        assert.match(messageTexts, matcher, `expected ${text} to match ${matcher}`);
      }
    }

    async function cancelInteractivePrompt(updateId: number): Promise<void> {
      const before = telegram.sentMessages.length;
      await bridge.handleUpdateForTest(telegramMessageUpdate(updateId, "/cancel"));
      const after = telegram.sentMessages.length;
      assert.ok(after > before, "expected /cancel to respond while an interactive prompt is active");
      assert.match(
        telegram.sentMessages.at(-1)?.text ?? "",
        /(Cancelled|No active interactive prompt)/,
      );
    }

    async function waitForThreadToSettle(threadId: string): Promise<void> {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        try {
          const response = await codex.call("thread/read", {
            threadId,
            includeTurns: true,
          });
          const thread = response.thread as JsonObject | undefined;
          const status = (thread?.status as JsonObject | undefined)?.type;
          if (status !== "active") {
            return;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes("not materialized yet")) {
            throw error;
          }
        }
        await sleep(1000);
      }
      throw new Error(`Timed out waiting for thread ${threadId} to settle`);
    }

    try {
      await bridge.initialize({ printStartupHelp: false });

      await expectCommand(1, "/start", /Codex Anywhere is ready/);
      await expectCommand(2, "/help", /Codex Anywhere commands:/);
      await expectCommand(3, "/workspace", /Current workspace:/);
      await expectCommand(4, "/status", /workspace:/);
      await expectCommand(5, "/new", /Started a fresh Codex thread/);
      await expectCommand(6, "/resume", /(Sessions|No recent sessions were found\.)/);
      await expectCommand(7, "/continue", /All Sessions/);
      const stateAfterNew = await loadState(statePath);
      const initialThreadId = stateAfterNew.chats["42"]?.threadId;
      assert.ok(initialThreadId, "expected initial thread id after /new");
      await expectCommand(8, `/continue ${initialThreadId}`, /Took over session/);
      await expectCommand(9, "/interrupt", /No active turn to interrupt/);
      await expectCommand(10, "/esc", /No active turn to interrupt/);
      await expectCommand(11, "/ese", /No active turn to interrupt/);
      await expectCommand(12, "/cancel", /No active interactive prompt/);
      await expectCommand(13, "/sh pwd", /Confirm explicit shell command/);
      await expectCommand(14, "/model status", /Available models:/);
      await expectCommand(15, "/fast status", /Fast mode is/);
      await expectCommand(16, "/personality status", /Personality:/);
      await expectCommand(17, "/permissions status", /approval policy:/);
      await expectCommand(18, "/approvals status", /approval policy:/);
      await expectCommand(19, "/plan", /(Choose Plan mode|No plan modes were available|Plan mode is unavailable)/);
      await cancelInteractivePrompt(20);
      await expectCommand(21, "/collab status", /Collaboration mode:/);
      await expectCommand(22, "/agent", /(Choose the active agent thread|No agent threads were available)/);
      await cancelInteractivePrompt(23);
      await expectCommand(24, "/subagents", /(Choose the active agent thread|No agent threads were available)/);
      await cancelInteractivePrompt(25);
      await expectCommand(26, "/review", /Start a review/);
      await cancelInteractivePrompt(27);
      await expectCommand(28, "/rename", /Rename the current thread/);
      await cancelInteractivePrompt(29);
      await bridge.handleUpdateForTest(
        telegramMessageUpdate(30, "Reply with the single word ok."),
      );
      const stateAfterSeedTurn = await loadState(statePath);
      const seededThreadId = stateAfterSeedTurn.chats["42"]?.threadId;
      assert.ok(seededThreadId, "expected seeded thread id after sending a real task");
      assert.ok(stateAfterSeedTurn.chats["42"]?.activeTurnId, "expected active turn id after sending a real task");
      await waitForThreadToSettle(seededThreadId);
      await expectCommand(31, "/fork", /Forked into a new thread/);
      await expectCommand(32, "/compact", /Requested thread compaction/);
      await expectCommand(33, "/clear", /Started a fresh thread/);
      await expectCommand(34, "/diff", /Git status:/);
      await expectCommand(35, "/copy", /\/copy/);
      await expectCommand(36, "/mention README", /Choose a file to mention/);
      await cancelInteractivePrompt(37);
      await expectCommand(38, "/skills", /Skills:/);
      await expectCommand(39, "/mcp", /MCP servers:/);
      await expectCommand(40, "/apps", /Apps:/);
      await expectCommand(41, "/plugins", /Plugins:/);
      await expectCommand(42, "/feedback", /Send feedback/);
      await cancelInteractivePrompt(43);
      await expectCommand(44, "/experimental status", /Experimental features:/);
      await expectCommand(45, "/rollout", /(Rollout path:|No rollout path available\.)/);
      await expectCommand(46, "/stop", /(Stopping all background terminals|No current thread\. Nothing to stop\.)/);
      await expectCommand(47, "/clean", /(Stopping all background terminals|No current thread\. Nothing to stop\.)/);
      await expectCommand(48, "/init", /AGENTS\.md already exists/);
    } finally {
      await codex.close();
    }
  },
);
