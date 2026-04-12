import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearInterval, setInterval } from "node:timers";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import {
  formatApprovalCallbackData,
  formatShellCallbackData,
  parseApprovalCallbackData,
  parseShellCallbackData,
} from "./approval.js";
import { agentStreamKey, streamGroupId } from "./agentMessageStreams.js";
import { CodexAppServerClient } from "./codexAppServer.js";
import {
  formatInteractiveCallbackData,
  parseInteractiveCallbackData,
} from "./interactive.js";
import {
  buildAgentThreadInteractiveSession,
  buildAddBotInteractiveSession,
  buildApprovalPolicyInteractiveSession,
  buildCollaborationInteractiveSession,
  buildExperimentalInteractiveSession,
  buildFastInteractiveSession,
  buildFeedbackInteractiveSession,
  buildLocalInteractiveFollowUpSteps,
  buildMentionInteractiveSession,
  buildModelInteractiveSession,
  buildPersonalityInteractiveSession,
  buildPlanInteractiveSession,
  buildRenameInteractiveSession,
  buildReviewInteractiveSession,
  buildVerboseInteractiveSession,
} from "./localCommandInteractions.js";
import { loadState, saveConfig, saveState } from "./persistence.js";
import type { SessionOwnershipRegistry } from "./sessionOwnership.js";
import { formatSessionCallbackData, parseSessionCallbackData } from "./sessions.js";
import {
  codexSlashHelpText,
  isRecognizedCodexSlashCommand,
  isSupportedCodexSlashCommand,
  isTaskBlockingSlashCommand,
  isUnsupportedTelegramOnlyCodexCommand,
  normalizeApprovalPolicy,
  normalizeReasoningEffort,
  parseTelegramSlashCommand,
} from "./slashCommands.js";
import { buildOmxHelpText, planOmxCommand } from "./omxCommands.js";
import { TelegramBotApi } from "./telegram.js";
import {
  escapeTelegramHtml,
  formatApprovalPromptHtml,
  formatCommandCompletionHtml,
  formatFileChangeCompletionHtml,
  formatPendingInputActionHtml,
  formatTurnCompletionHtml,
  renderAssistantTextHtml,
  splitTelegramChunks,
} from "./telegramFormatting.js";
import { reconcileActiveTurnIdFromThreadRead } from "./threadState.js";
import {
  formatTurnControlCallbackData,
  parseTurnControlCallbackData,
} from "./turnControls.js";
import type {
  BotRuntimeConfig,
  ChatSessionState,
  JsonObject,
  PendingApproval,
  PendingInteractiveSession,
  PendingInteractiveSessionStep,
  StoredState,
  StreamBuffer,
  TelegramBotCommand,
  TelegramCallbackQuery,
  TelegramMessage,
  TelegramUpdate,
} from "./types.js";

const execFileAsync = promisify(execFile);

type TelegramClient = Pick<
  TelegramBotApi,
  | "getUpdates"
  | "setMyCommands"
  | "getFile"
  | "downloadFile"
  | "sendChatAction"
  | "sendMessage"
  | "editMessageText"
  | "answerCallbackQuery"
  | "deleteMessage"
>;

type CodexClient = Pick<
  CodexAppServerClient,
  "start" | "initialize" | "call" | "notify" | "respond" | "nextMessage" | "close"
>;

export interface CodexAnywhereBridgeDeps {
  telegram?: TelegramClient;
  codex?: CodexClient;
  initialState?: StoredState;
  botId?: string;
  botLabel?: string;
  persistConfig?: (config: BotRuntimeConfig) => Promise<void>;
  sessionOwnership?: SessionOwnershipRegistry;
  addBot?: (bot: BotRuntimeConfig) => Promise<void>;
}

export class CodexAnywhereBridge {
  readonly #configPath: string;
  readonly #statePath: string;
  readonly #botId: string;
  readonly #botLabel: string;
  readonly #config: BotRuntimeConfig;
  readonly #telegram: TelegramClient;
  readonly #codex: CodexClient;
  readonly #persistConfigFn: (config: BotRuntimeConfig) => Promise<void>;
  readonly #sessionOwnership: SessionOwnershipRegistry | null;
  readonly #addBotFn: ((bot: BotRuntimeConfig) => Promise<void>) | null;
  readonly #pendingApprovals = new Map<string, PendingApproval>();
  readonly #pendingShellCommands = new Map<string, { chatId: number; command: string }>();
  readonly #pendingSessionSwitches = new Map<string, { chatId: number; threadId: string; targetWorkspace: string }>();
  readonly #pendingSessionPages = new Map<string, { chatId: number; global: boolean; cursor: string }>();
  readonly #pendingInteractiveSessions = new Map<string, PendingInteractiveSession>();
  readonly #pendingInteractiveSessionByChat = new Map<number, string>();
  readonly #items = new Map<string, JsonObject>();
  readonly #streams = new Map<string, StreamBuffer>();
  readonly #typingIntervals = new Map<number, ReturnType<typeof setInterval>>();
  readonly #hasInitialState: boolean;
  #initialized = false;
  #state: StoredState = {
    version: 1,
    lastUpdateId: null,
    chats: {},
  };

  constructor(
    config: BotRuntimeConfig,
    configPath: string,
    statePath: string,
    deps?: CodexAnywhereBridgeDeps,
  ) {
    this.#config = config;
    this.#configPath = configPath;
    this.#statePath = statePath;
    this.#botId = deps?.botId ?? config.id;
    this.#botLabel = deps?.botLabel ?? config.label;
    this.#telegram = deps?.telegram ?? new TelegramBotApi(config.telegramBotToken);
    this.#codex = deps?.codex ?? new CodexAppServerClient(["codex", "app-server"]);
    this.#persistConfigFn = deps?.persistConfig ?? (async (nextConfig) => {
      await saveConfig(this.#configPath, {
        version: 1,
        telegramBotToken: nextConfig.telegramBotToken,
        workspaceCwd: nextConfig.workspaceCwd,
        ownerUserId: nextConfig.ownerUserId,
        pollTimeoutSeconds: nextConfig.pollTimeoutSeconds,
        streamEditIntervalMs: nextConfig.streamEditIntervalMs,
      });
    });
    this.#sessionOwnership = deps?.sessionOwnership ?? null;
    this.#addBotFn = deps?.addBot ?? null;
    this.#hasInitialState = Boolean(deps?.initialState);
    if (deps?.initialState) {
      this.#state = deps.initialState;
    }
  }

  async initialize(options?: { printStartupHelp?: boolean; reconcilePersistedState?: boolean }): Promise<void> {
    if (this.#initialized) {
      return;
    }
    if (!this.#hasInitialState) {
      this.#state = await loadState(this.#statePath);
    }
    await this.#codex.start();
    await this.#codex.initialize();
    if (options?.reconcilePersistedState ?? false) {
      await this.#reconcilePersistedThreads();
    }
    await this.#registerTelegramCommands();
    if (options?.printStartupHelp ?? true) {
      this.#printStartupHelp();
    }
    this.#initialized = true;
  }

  async runLoops(): Promise<void> {
    await Promise.all([this.#pollTelegramLoop(), this.#consumeCodexLoop()]);
  }

  async run(): Promise<void> {
    await this.initialize();
    await this.runLoops();
  }

  async handleUpdateForTest(update: TelegramUpdate): Promise<void> {
    await this.#handleUpdate(update);
  }

  async #pollTelegramLoop(): Promise<void> {
    while (true) {
      try {
        const offset = this.#state.lastUpdateId === null ? null : this.#state.lastUpdateId + 1;
        const updates = await this.#telegram.getUpdates(offset, this.#config.pollTimeoutSeconds);
        for (const update of updates) {
          this.#state.lastUpdateId = update.update_id;
          await this.#saveState();
          await this.#handleUpdate(update);
        }
      } catch (error) {
        this.#logRuntimeError("telegram poll", error);
        await sleep(1000);
      }
    }
  }

  async #consumeCodexLoop(): Promise<void> {
    while (true) {
      try {
        const message = await this.#codex.nextMessage();
        if (typeof message.method !== "string") {
          continue;
        }
        if ("id" in message) {
          await this.#handleServerRequest(message);
        } else {
          await this.#handleNotification(
            message.method,
            (message.params as JsonObject | undefined) ?? {},
          );
        }
      } catch (error) {
        this.#logRuntimeError("codex event", error);
        await sleep(1000);
      }
    }
  }

  async #handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.#handleCallbackQuery(update.callback_query);
      return;
    }
    if (update.message?.text || update.message?.caption || update.message?.photo || update.message?.document) {
      await this.#handleMessage(update.message);
    }
  }

  async #handleMessage(message: TelegramMessage): Promise<void> {
    if (message.chat.type !== "private") {
      return;
    }
    const text = message.text?.trim() ?? message.caption?.trim() ?? "";
    const userId = message.from?.id;
    if (typeof userId !== "number") {
      return;
    }

    if (this.#config.ownerUserId === null) {
      await this.#maybePairOwner(userId, message.chat.id, text);
      return;
    }

    if (userId !== this.#config.ownerUserId) {
      return;
    }

    if (hasTelegramImage(message)) {
      if (await this.#handlePendingInteractiveTextInput(message.chat.id, text || "/cancel")) {
        return;
      }
      await this.#handleImageMessage(message, text);
      return;
    }

    if (!text) {
      return;
    }

    if (await this.#handlePendingInteractiveTextInput(message.chat.id, text)) {
      return;
    }

    const explicitOmxTeam = parseExplicitOmxTeamInvocation(text);
    if (explicitOmxTeam) {
      await this.#handleOmxCommand(message.chat.id, explicitOmxTeam);
      return;
    }

    const slashCommand = parseTelegramSlashCommand(text);
    if (slashCommand) {
      switch (slashCommand.name) {
        case "start":
          await this.#sendText(
            message.chat.id,
            [
              "Codex Anywhere is ready.",
              "Send a task, try /help, or use /resume to browse sessions.",
              "You can also send a screenshot with an optional caption.",
            ].join("\n"),
          );
          return;
        case "help":
          await this.#sendText(message.chat.id, codexSlashHelpText());
          return;
        case "new":
          await this.#startNewThread(message.chat.id);
          return;
        case "resume":
          await this.#showSessions(message.chat.id, { global: false });
          return;
        case "interrupt":
          await this.#interruptTurn(message.chat.id);
          return;
        case "esc":
        case "ese":
          await this.#interruptTurn(message.chat.id);
          return;
        case "cancel":
          await this.#sendText(message.chat.id, "No active interactive prompt to cancel.");
          return;
        case "status":
          await this.#sendStatus(message.chat.id);
          return;
        case "sh":
          await this.#runShellCommand(message.chat.id, slashCommand.args);
          return;
        case "omx":
          await this.#handleOmxCommand(message.chat.id, slashCommand.args);
          return;
        case "workspace":
          await this.#handleWorkspaceCommand(message.chat.id, slashCommand.args);
          return;
        case "addbot":
          await this.#handleAddBotCommand(message.chat.id);
          return;
        default:
          if (isRecognizedCodexSlashCommand(slashCommand.name)) {
            await this.#handleCodexSlashCommand(
              message.chat.id,
              slashCommand.name,
              slashCommand.args,
            );
            return;
          }
          await this.#sendText(
            message.chat.id,
            `Unknown command: /${slashCommand.name}\nUse /help to see supported commands.`,
          );
          return;
      }
    }

    await this.#submitChatInput(message.chat.id, [{ type: "text", text }]);
  }

  async #handleImageMessage(message: TelegramMessage, caption: string): Promise<void> {
    const imagePath = await this.#downloadTelegramImage(message);
    if (!imagePath) {
      await this.#sendText(message.chat.id, "I could not read that image from Telegram.");
      return;
    }

    const input: JsonObject[] = [];
    if (caption) {
      input.push({ type: "text", text: caption });
    }
    input.push({ type: "localImage", path: imagePath });
    await this.#submitChatInput(message.chat.id, input);
  }

  async #submitChatInput(chatId: number, input: JsonObject[]): Promise<void> {
    const state = this.#chatState(chatId);
    const preparedInput = consumePendingMention(state, input);
    if (!state.activeTurnId) {
      await this.#startTurn(chatId, preparedInput);
      return;
    }

    await this.#reconcileActiveTurnState(chatId);
    if (!state.activeTurnId) {
      await this.#startTurn(chatId, preparedInput);
      return;
    }

    if (state.queueNextArmed) {
      state.queuedTurnInput = preparedInput;
      state.queueNextArmed = false;
      await this.#saveState();
      await this.#sendHtmlText(chatId, formatPendingInputActionHtml("queued", preparedInput));
      return;
    }
    state.pendingTurnInput = preparedInput;
    await this.#saveState();
    await this.#sendTurnControls(chatId, state.activeTurnId);
  }

  async #downloadTelegramImage(message: TelegramMessage): Promise<string | null> {
    const fileId = bestTelegramImageFileId(message);
    if (!fileId) {
      return null;
    }

    const file = await this.#telegram.getFile(fileId);
    const extension = telegramFileExtension(file.file_path, message.document?.file_name);
    const directory = path.join(os.tmpdir(), "codex-anywhere-telegram-images");
    await fs.mkdir(directory, { recursive: true });
    const targetPath = path.join(
      directory,
      `${Date.now()}-${randomBytes(4).toString("hex")}${extension}`,
    );
    const bytes = await this.#telegram.downloadFile(file.file_path);
    await fs.writeFile(targetPath, bytes);
    return targetPath;
  }

  async #handleCallbackQuery(callback: TelegramCallbackQuery): Promise<void> {
    const userId = callback.from?.id;
    if (typeof userId !== "number" || userId !== this.#config.ownerUserId) {
      await this.#telegram.answerCallbackQuery(callback.id, "Not allowed");
      return;
    }

    const parsed = parseApprovalCallbackData(callback.data ?? "");
    if (parsed) {
      const approval = this.#pendingApprovals.get(parsed.token);
      if (!approval) {
        await this.#telegram.answerCallbackQuery(callback.id, "Approval expired");
        return;
      }

      await this.#resolveApproval(approval, parsed.action);
      this.#pendingApprovals.delete(parsed.token);
      await this.#telegram.answerCallbackQuery(callback.id, `Recorded: ${parsed.action}`);
      return;
    }

    const shellParsed = parseShellCallbackData(callback.data ?? "");
    const interactiveParsed = parseInteractiveCallbackData(callback.data ?? "");
    const sessionParsed = parseSessionCallbackData(callback.data ?? "");
    const turnControlParsed = parseTurnControlCallbackData(callback.data ?? "");
    if (interactiveParsed) {
      await this.#handleInteractiveCallback(callback.id, interactiveParsed);
      return;
    }
    if (sessionParsed) {
      await this.#handleSessionCallback(callback.id, callback.message?.chat.id ?? null, sessionParsed);
      return;
    }
    if (turnControlParsed) {
      await this.#handleTurnControlCallback(
        callback.id,
        callback.message?.chat.id ?? null,
        turnControlParsed,
      );
      return;
    }
    if (!shellParsed) {
      await this.#telegram.answerCallbackQuery(callback.id, "Unknown action");
      return;
    }
    const pendingShell = this.#pendingShellCommands.get(shellParsed.token);
    if (!pendingShell) {
      await this.#telegram.answerCallbackQuery(callback.id, "Shell confirmation expired");
      return;
    }

    this.#pendingShellCommands.delete(shellParsed.token);
    if (shellParsed.action === "cancel") {
      await this.#telegram.answerCallbackQuery(callback.id, "Cancelled");
      await this.#sendText(pendingShell.chatId, "Cancelled.");
      return;
    }

    await this.#telegram.answerCallbackQuery(callback.id, "Running command");
    await this.#executeShellCommand(pendingShell.chatId, pendingShell.command);
  }

  async #handleCodexSlashCommand(chatId: number, name: string, args: string): Promise<void> {
    if (isUnsupportedTelegramOnlyCodexCommand(name)) {
      await this.#sendText(
        chatId,
        `/${name} is a TUI/Desktop-oriented command and is not meaningful in the Telegram bridge yet.`,
      );
      return;
    }
    if (!isSupportedCodexSlashCommand(name)) {
      await this.#sendText(chatId, `/${name} is not supported in Codex Anywhere yet.`);
      return;
    }

    const state = this.#chatState(chatId);
    if (isTaskBlockingSlashCommand(name) && state.activeTurnId) {
      await this.#reconcileActiveTurnState(chatId);
    }
    if (isTaskBlockingSlashCommand(name) && state.activeTurnId) {
      await this.#sendText(chatId, `/${name} is disabled while a task is in progress.`);
      return;
    }

    switch (name) {
      case "fork":
        await this.#forkThread(chatId);
        return;
      case "init":
        await this.#runInitCommand(chatId);
        return;
      case "compact":
        await this.#compactThread(chatId);
        return;
      case "review":
        await this.#startReview(chatId, args);
        return;
      case "rename":
        await this.#renameThread(chatId, args);
        return;
      case "model":
        await this.#handleModelCommand(chatId, args);
        return;
      case "personality":
        await this.#handlePersonalityCommand(chatId, args);
        return;
      case "fast":
        await this.#handleFastCommand(chatId, args);
        return;
      case "plan":
        await this.#handlePlanCommand(chatId, args);
        return;
      case "collab":
        await this.#handleCollabCommand(chatId, args);
        return;
      case "continue":
        await this.#handleContinueCommand(chatId, args);
        return;
      case "agent":
      case "subagents":
        await this.#handleAgentCommand(chatId);
        return;
      case "approvals":
      case "permissions":
        await this.#handleApprovalPolicyCommand(chatId, args);
        return;
      case "clear":
        await this.#clearThread(chatId);
        return;
      case "diff":
        await this.#sendGitDiff(chatId);
        return;
      case "mention":
        await this.#handleMentionCommand(chatId, args);
        return;
      case "copy":
        await this.#copyLastOutput(chatId);
        return;
      case "verbose":
        await this.#handleVerboseCommand(chatId, args);
        return;
      case "feedback":
        await this.#handleFeedbackCommand(chatId);
        return;
      case "skills":
        await this.#sendSkills(chatId);
        return;
      case "mcp":
        await this.#sendMcpServers(chatId);
        return;
      case "apps":
        await this.#sendApps(chatId);
        return;
      case "plugins":
        await this.#sendPlugins(chatId);
        return;
      case "logout":
      case "quit":
      case "exit":
        await this.#logoutAccount(chatId);
        return;
      case "rollout":
        await this.#sendRolloutPath(chatId);
        return;
      case "stop":
      case "clean":
        await this.#stopBackgroundTerminals(chatId);
        return;
      case "experimental":
        await this.#handleExperimentalCommand(chatId, args);
        return;
      case "new":
      case "resume":
      case "status":
        return;
      default:
        await this.#sendText(chatId, `/${name} is not implemented in Codex Anywhere yet.`);
    }
  }

  async #handleOmxCommand(chatId: number, args: string): Promise<void> {
    let plan;
    try {
      plan = planOmxCommand(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#sendText(chatId, message);
      return;
    }

    if (plan.kind === "help") {
      await this.#sendText(chatId, buildOmxHelpText());
      return;
    }

    if (plan.kind === "skill") {
      await this.#submitChatInput(chatId, [{ type: "text", text: plan.skillText ?? "" }]);
      return;
    }

    if (plan.kind === "unsupported") {
      await this.#sendText(chatId, plan.message ?? "That OMX command is not supported in Telegram yet.");
      return;
    }

    await this.#runOmxCommand(chatId, plan.argv);
  }

  async #handleWorkspaceCommand(chatId: number, args: string): Promise<void> {
    const trimmed = args.trim();
    if (!trimmed) {
      await this.#sendText(
        chatId,
        [
          `Current workspace: ${this.#config.workspaceCwd}`,
          "Usage: /workspace <path>",
        ].join("\n"),
      );
      return;
    }

    if (Object.values(this.#state.chats).some((state) => Boolean(state.activeTurnId))) {
      await this.#sendText(chatId, "Cannot change workspace while a task is in progress.");
      return;
    }

    const targetPath = resolveWorkspacePath(trimmed, this.#config.workspaceCwd, os.homedir());

    let stats;
    try {
      stats = await fs.stat(targetPath);
    } catch {
      await this.#sendText(chatId, `Workspace path does not exist: ${targetPath}`);
      return;
    }
    if (!stats.isDirectory()) {
      await this.#sendText(chatId, `Workspace path is not a directory: ${targetPath}`);
      return;
    }

    const previousWorkspace = this.#config.workspaceCwd;
    if (targetPath === previousWorkspace) {
      await this.#sendText(chatId, `Already using workspace: ${targetPath}`);
      return;
    }

    this.#config.workspaceCwd = targetPath;
    await this.#persistConfig();

    this.#clearAllChatBindings();
    await this.#saveState();

    await this.#sendText(
      chatId,
      [
        `Workspace changed to ${targetPath}`,
        `Previous workspace: ${previousWorkspace}`,
        "Detached current thread/session state for this bot instance.",
      ].join("\n"),
    );
  }

  async #registerTelegramCommands(): Promise<void> {
    try {
      await this.#telegram.setMyCommands(telegramCommands());
    } catch (error) {
      this.#logRuntimeError("setMyCommands", error);
    }
  }

  async #handleInteractiveCallback(
    callbackQueryId: string,
    parsed: { token: string; action: "choose" | "cancel" | "open" | "done"; value: string | null },
  ): Promise<void> {
    const session = this.#pendingInteractiveSessions.get(parsed.token);
    if (!session) {
      await this.#telegram.answerCallbackQuery(callbackQueryId, "Prompt expired");
      return;
    }

    if (parsed.action === "cancel") {
      await this.#cancelInteractiveSession(session, "Cancelled");
      await this.#telegram.answerCallbackQuery(callbackQueryId, "Cancelled");
      return;
    }

    const step = session.steps[session.currentStepIndex];
    if (!step) {
      await this.#telegram.answerCallbackQuery(callbackQueryId, "Prompt finished");
      this.#cleanupInteractiveSession(session);
      return;
    }

    if (step.kind === "url") {
      if (parsed.action === "open") {
        await this.#telegram.answerCallbackQuery(
          callbackQueryId,
          "Open the link, then press Done when finished.",
        );
        return;
      }
      if (parsed.action === "done") {
        session.answers[step.key] = true;
        await this.#telegram.answerCallbackQuery(callbackQueryId, "Recorded");
        await this.#advanceInteractiveSession(session);
        return;
      }
      await this.#telegram.answerCallbackQuery(callbackQueryId, "Use the link or Done button");
      return;
    }

    if (parsed.action !== "choose" || parsed.value === null) {
      await this.#telegram.answerCallbackQuery(callbackQueryId, "Unknown selection");
      return;
    }

    if (step.kind === "boolean") {
      session.answers[step.key] = parsed.value === "true";
    } else {
      const option = step.options?.find((entry) => entry.value === parsed.value);
      if (!option) {
        await this.#telegram.answerCallbackQuery(callbackQueryId, "Choice unavailable");
        return;
      }
      session.answers[step.key] = option.value;
    }

    await this.#telegram.answerCallbackQuery(callbackQueryId, "Recorded");
    await this.#advanceInteractiveSession(session);
  }

  async #handlePendingInteractiveTextInput(chatId: number, text: string): Promise<boolean> {
    const token = this.#pendingInteractiveSessionByChat.get(chatId);
    if (!token) {
      return false;
    }

    const session = this.#pendingInteractiveSessions.get(token);
    if (!session) {
      this.#pendingInteractiveSessionByChat.delete(chatId);
      return false;
    }

    if (text === "/cancel") {
      await this.#cancelInteractiveSession(session, "Cancelled");
      return true;
    }

    const step = session.steps[session.currentStepIndex];
    if (!step) {
      this.#cleanupInteractiveSession(session);
      return false;
    }

    const allowLeadingSlashText =
      step.kind === "text"
      && session.kind === "local"
      && step.key === "workspaceCwd"
      && asString(session.meta?.command) === "addbot";

    if (text.startsWith("/") && step.kind !== "url" && !allowLeadingSlashText) {
      await this.#sendText(chatId, "Reply with your answer for the active prompt, or send /cancel.");
      return true;
    }

    if (step.kind === "text") {
      session.answers[step.key] = text;
      await this.#advanceInteractiveSession(session);
      return true;
    }

    if (step.kind === "number") {
      const value = Number(text);
      if (Number.isNaN(value)) {
        await this.#sendText(chatId, "Please reply with a number, or send /cancel.");
        return true;
      }
      session.answers[step.key] = value;
      await this.#advanceInteractiveSession(session);
      return true;
    }

    await this.#sendText(chatId, "Use the buttons for the active prompt, or send /cancel.");
    return true;
  }

  async #startToolInteractiveSession(
    chatId: number,
    requestId: string | number,
    params: JsonObject,
  ): Promise<void> {
    const questions = Array.isArray(params.questions) ? params.questions : [];
    const steps = questions
      .map((question, index) => buildToolInteractiveStep(question as JsonObject, index))
      .filter((step): step is PendingInteractiveSessionStep => Boolean(step));
    if (steps.length === 0) {
      await this.#codex.respond(requestId, { answers: {} });
      await this.#sendText(chatId, "No interactive choices were available for that prompt.");
      return;
    }

    await this.#cancelExistingInteractiveSession(chatId);
    const session: PendingInteractiveSession = {
      requestId,
      chatId,
      kind: "tool",
      token: randomBytes(4).toString("hex"),
      title: "Codex needs your input.",
      steps,
      currentStepIndex: 0,
      answers: {},
    };
    await this.#sendInteractiveStep(session);
  }

  async #startMcpInteractiveSession(
    chatId: number,
    requestId: string | number,
    params: JsonObject,
  ): Promise<void> {
    const built = buildMcpInteractiveSession(params);
    if (!built) {
      await this.#codex.respond(requestId, { action: "cancel", content: null, _meta: null });
      await this.#sendText(chatId, "This interactive MCP prompt is not supported in Telegram yet.");
      return;
    }

    await this.#cancelExistingInteractiveSession(chatId);
    const session: PendingInteractiveSession = {
      requestId,
      chatId,
      kind: "mcp",
      token: randomBytes(4).toString("hex"),
      title: built.title,
      steps: built.steps,
      currentStepIndex: 0,
      answers: {},
      meta: built.meta,
    };
    await this.#sendInteractiveStep(session);
  }

  async #startLocalSlashInteractiveSession(
    chatId: number,
    spec: {
      title: string;
      steps: PendingInteractiveSessionStep[];
      meta: JsonObject;
    },
  ): Promise<void> {
    await this.#cancelExistingInteractiveSession(chatId);
    const session: PendingInteractiveSession = {
      requestId: null,
      chatId,
      kind: "local",
      token: randomBytes(4).toString("hex"),
      title: spec.title,
      steps: [...spec.steps],
      currentStepIndex: 0,
      answers: {},
      meta: { ...spec.meta, type: "localSlashCommand" },
    };
    await this.#sendInteractiveStep(session);
  }

  async #cancelExistingInteractiveSession(chatId: number): Promise<void> {
    const existingToken = this.#pendingInteractiveSessionByChat.get(chatId);
    if (!existingToken) {
      return;
    }
    const session = this.#pendingInteractiveSessions.get(existingToken);
    if (!session) {
      this.#pendingInteractiveSessionByChat.delete(chatId);
      return;
    }
    await this.#cancelInteractiveSession(session, "Superseded by a new prompt.");
  }

  async #advanceInteractiveSession(session: PendingInteractiveSession): Promise<void> {
    session.currentStepIndex += 1;
    this.#expandLocalInteractiveSession(session);
    if (session.currentStepIndex >= session.steps.length) {
      await this.#completeInteractiveSession(session);
      return;
    }
    await this.#sendInteractiveStep(session);
  }

  #expandLocalInteractiveSession(session: PendingInteractiveSession): void {
    if (session.kind !== "local") {
      return;
    }
    const meta = session.meta;
    if (!meta || meta.type !== "localSlashCommand" || meta.followUpAdded === true) {
      return;
    }

    const command = asString(meta.command);
    if (!command) {
      return;
    }

    const steps = buildLocalInteractiveFollowUpSteps(
      command as "model" | "fast" | "permissions" | "experimental" | "rename" | "review",
      session.answers,
    );
    if (steps.length === 0) {
      return;
    }

    session.steps.push(...steps);
    meta.followUpAdded = true;
  }

  async #sendInteractiveStep(session: PendingInteractiveSession): Promise<void> {
    const step = session.steps[session.currentStepIndex];
    if (!step) {
      return;
    }

    this.#stopTypingIndicator(session.chatId);
    this.#pendingInteractiveSessions.set(session.token, session);
    this.#pendingInteractiveSessionByChat.set(session.chatId, session.token);

    const prefix =
      session.steps.length > 1
        ? `(${session.currentStepIndex + 1}/${session.steps.length}) `
        : "";
    const text = `${session.title}\n\n${prefix}${step.prompt}`;

    if (step.kind === "choice" || step.kind === "boolean") {
      const options =
        step.kind === "boolean"
          ? [
              { label: "Yes", value: "true" },
              { label: "No", value: "false" },
            ]
          : step.options ?? [];
      const replyMarkup = {
        inline_keyboard: [
          ...options.map((option) => [
            {
              text: option.label,
              callback_data: formatInteractiveCallbackData(session.token, "choose", option.value),
            },
          ]),
          [{ text: "Cancel", callback_data: formatInteractiveCallbackData(session.token, "cancel") }],
        ],
      } satisfies JsonObject;
      await this.#sendText(session.chatId, text, replyMarkup);
      return;
    }

    if (step.kind === "url") {
      const url = step.options?.[0]?.value ?? "";
      const replyMarkup = {
        inline_keyboard: [
          [{ text: "Open link", url }],
          [{ text: "Done", callback_data: formatInteractiveCallbackData(session.token, "done") }],
          [{ text: "Cancel", callback_data: formatInteractiveCallbackData(session.token, "cancel") }],
        ],
      } satisfies JsonObject;
      await this.#sendText(session.chatId, text, replyMarkup);
      return;
    }

    await this.#sendText(
      session.chatId,
      `${text}\n\nReply with your answer in chat, or send /cancel.`,
    );
  }

  async #completeInteractiveSession(session: PendingInteractiveSession): Promise<void> {
    if (session.kind === "tool") {
      const answers = Object.fromEntries(
        Object.entries(session.answers).map(([key, value]) => [key, { answers: [String(value)] }]),
      );
      await this.#codex.respond(session.requestId!, { answers });
      await this.#sendText(session.chatId, "Submitted your answers.");
    } else if (session.kind === "local") {
      await this.#completeLocalInteractiveSession(session);
    } else {
      await this.#codex.respond(session.requestId!, {
        action: "accept",
        content: session.answers,
        _meta: session.meta ?? null,
      });
      await this.#sendText(session.chatId, "Submitted your response.");
    }
    this.#cleanupInteractiveSession(session);
  }

  async #cancelInteractiveSession(
    session: PendingInteractiveSession,
    message: string,
  ): Promise<void> {
    if (session.kind === "tool") {
      await this.#codex.respond(session.requestId!, { answers: {} });
    } else if (session.kind === "mcp") {
      await this.#codex.respond(session.requestId!, {
        action: "cancel",
        content: null,
        _meta: session.meta ?? null,
      });
    }
    this.#cleanupInteractiveSession(session);
    await this.#sendText(session.chatId, message);
  }

  async #completeLocalInteractiveSession(session: PendingInteractiveSession): Promise<void> {
    const meta = session.meta;
    const command = meta ? asString(meta.command) : null;
    this.#cleanupInteractiveSession(session);

    switch (command) {
      case "model":
        await this.#applyLocalModelSelection(session.chatId, session.answers);
        return;
      case "personality":
        await this.#applyLocalPersonalitySelection(session.chatId, session.answers);
        return;
      case "fast":
        await this.#applyLocalFastSelection(session.chatId, session.answers);
        return;
      case "plan":
      case "collab":
        await this.#applyLocalCollaborationSelection(session.chatId, session.answers);
        return;
      case "permissions":
        await this.#applyLocalApprovalPolicySelection(session.chatId, session.answers);
        return;
      case "experimental":
        await this.#applyLocalExperimentalSelection(session.chatId, session.answers);
        return;
      case "feedback":
        await this.#applyLocalFeedbackSelection(session.chatId, session.answers);
        return;
      case "agent":
        await this.#applyLocalAgentSelection(session.chatId, session.answers);
        return;
      case "mention":
        await this.#applyLocalMentionSelection(session.chatId, session.answers);
        return;
      case "verbose":
        await this.#applyLocalVerboseSelection(session.chatId, session.answers);
        return;
      case "rename":
        await this.#applyLocalRenameSelection(session.chatId, session.answers);
        return;
      case "review":
        await this.#applyLocalReviewSelection(session.chatId, session.answers);
        return;
      case "addbot":
        await this.#applyLocalAddBotSelection(session.chatId, session.answers);
        return;
      default:
        await this.#sendText(session.chatId, "Unsupported local interactive command.");
    }
  }

  #cleanupInteractiveSession(session: PendingInteractiveSession): void {
    this.#pendingInteractiveSessions.delete(session.token);
    const current = this.#pendingInteractiveSessionByChat.get(session.chatId);
    if (current === session.token) {
      this.#pendingInteractiveSessionByChat.delete(session.chatId);
    }
  }

  async #forkThread(chatId: number): Promise<void> {
    const state = this.#chatState(chatId);
    if (!state.threadId) {
      await this.#sendText(chatId, "No current thread to fork. Send a task or use /new first.");
      return;
    }
    const result = await this.#codex.call("thread/fork", {
      threadId: state.threadId,
      ...threadSessionOverrides(this.#config, state),
    });
    const thread = result.thread as JsonObject | undefined;
    const threadId = asString(thread?.id);
    if (!threadId) {
      throw new Error("Codex did not return a forked thread id.");
    }
    this.#replaceThreadOwnership(state.threadId, threadId);
    state.threadId = threadId;
    state.freshThread = true;
    state.activeTurnId = null;
    await this.#saveState();
    await this.#sendText(chatId, "Forked into new thread.");
  }

  async #runInitCommand(chatId: number): Promise<void> {
    const agentsPath = path.join(this.#config.workspaceCwd, "AGENTS.md");
    try {
      await fs.access(agentsPath);
      await this.#sendText(
        chatId,
        `AGENTS.md already exists at ${agentsPath}. Skipping /init to avoid overwriting it.`,
      );
      return;
    } catch {
      // Missing file is expected here.
    }

    await this.#sendTask(
      chatId,
      [
        "Create an AGENTS.md file for this repository.",
        "Inspect the codebase first, then write concise project-specific instructions for Codex.",
        "Include build/test/lint commands, important conventions, and workflow guidance.",
      ].join(" "),
    );
  }

  async #handleAddBotCommand(chatId: number): Promise<void> {
    if (!this.#addBotFn) {
      await this.#sendText(chatId, "Adding bots from Telegram is not available in this runtime.");
      return;
    }
    await this.#startLocalSlashInteractiveSession(
      chatId,
      buildAddBotInteractiveSession(this.#config),
    );
  }

  async #runOmxCommand(chatId: number, argv: string[]): Promise<void> {
    const renderedCommand = `omx ${argv.join(" ")}`.trim();
    try {
      const result = await execFileAsync("omx", argv, {
        cwd: this.#config.workspaceCwd,
        maxBuffer: 1024 * 1024 * 8,
        timeout: 120_000,
      });
      await this.#sendHtmlText(
        chatId,
        [
          `<b>OMX</b>  <code>${escapeTelegramHtml(renderedCommand)}</code>`,
          `<pre>${escapeTelegramHtml(truncateOmxOutput(result.stdout || result.stderr || "(no output)"))}</pre>`,
        ].join("\n"),
      );
    } catch (error) {
      if (isMissingExecutableError(error, "omx")) {
        await this.#sendText(
          chatId,
          [
            "OMX is not installed in this environment.",
            "Install oh-my-codex first, then try /omx again.",
            "Terminal setup command: omx setup",
          ].join("\n"),
        );
        return;
      }
      const stdout = error && typeof error === "object" && "stdout" in error ? String((error as { stdout?: unknown }).stdout ?? "") : "";
      const stderr = error && typeof error === "object" && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
      const message = error instanceof Error ? error.message : String(error);
      const details = [stderr.trim(), stdout.trim(), message].filter(Boolean).join("\n\n");
      await this.#sendHtmlText(
        chatId,
        [
          `<b>OMX failed</b>  <code>${escapeTelegramHtml(renderedCommand)}</code>`,
          `<pre>${escapeTelegramHtml(truncateOmxOutput(details || "(no output)"))}</pre>`,
        ].join("\n"),
      );
    }
  }

  async #compactThread(chatId: number): Promise<void> {
    const threadId = await this.#resumeThread(chatId, true);
    await this.#codex.call("thread/compact/start", { threadId });
    await this.#sendText(chatId, "Compacting thread…");
  }

  async #startReview(chatId: number, args: string): Promise<void> {
    if (!args.trim()) {
      await this.#startLocalSlashInteractiveSession(chatId, buildReviewInteractiveSession());
      return;
    }
    await this.#runReview(chatId, parseReviewTarget(args));
  }

  async #runReview(chatId: number, target: JsonObject): Promise<void> {
    const threadId = await this.#resumeThread(chatId, true);
    await this.#codex.call("review/start", { threadId, target });
    await this.#sendText(chatId, "Review started.");
  }

  async #renameThread(chatId: number, args: string): Promise<void> {
    const name = args.trim();
    if (!name) {
      const state = this.#chatState(chatId);
      if (!state.threadId) {
        await this.#sendText(chatId, "No current thread to rename. Send a task or use /new first.");
        return;
      }
      await this.#startLocalSlashInteractiveSession(chatId, buildRenameInteractiveSession());
      return;
    }
    const state = this.#chatState(chatId);
    if (!state.threadId) {
      await this.#sendText(chatId, "No current thread to rename. Send a task or use /new first.");
      return;
    }
    await this.#codex.call("thread/name/set", {
      threadId: state.threadId,
      name,
    });
    await this.#sendText(chatId, `✏️ Renamed thread to: ${name}`);
  }

  async #handleModelCommand(chatId: number, args: string): Promise<void> {
    const state = this.#chatState(chatId);
    const trimmed = args.trim();
    const response = await this.#codex.call("model/list", {
      limit: 100,
      includeHidden: false,
    });
    const models = Array.isArray(response.data) ? response.data : [];

    if (!trimmed) {
      const session = buildModelInteractiveSession(models, state);
      if (!session) {
        await this.#sendText(chatId, "No models were available to choose from.");
        return;
      }
      await this.#startLocalSlashInteractiveSession(chatId, session);
      return;
    }

    if (trimmed === "status") {
      const lines = [
        `model override: ${state.model ?? "(default)"}`,
        `reasoning effort: ${state.reasoningEffort ?? "(default)"}`,
        "",
        "Available models:",
        ...models
          .map((entry) => formatModelSummary(entry))
          .filter((line): line is string => Boolean(line))
          .slice(0, 20),
        "",
        "Usage: /model <model> [minimal|low|medium|high]",
        "Usage: /model reset",
      ];
      await this.#sendText(chatId, lines.join("\n"));
      return;
    }

    if (trimmed === "reset") {
      state.model = null;
      state.reasoningEffort = null;
      await this.#saveState();
      await this.#sendText(chatId, "Model override cleared.");
      return;
    }

    const parts = trimmed.split(/\s+/).filter(Boolean);
    const model = parts[0] ?? "";
    const effort = parts[1] ? normalizeReasoningEffort(parts[1]) : null;
    const knownModel = models.find(
      (entry) => entry && typeof entry === "object" && asString((entry as JsonObject).model) === model,
    );
    if (!knownModel) {
      await this.#sendText(chatId, `Unknown model: ${model}\nRun /model to list available models.`);
      return;
    }
    if (parts[1] && !effort) {
      await this.#sendText(chatId, "Usage: /model <model> [minimal|low|medium|high]");
      return;
    }

    state.model = model;
    state.reasoningEffort = effort;
    await this.#saveState();
    await this.#sendText(
      chatId,
      `Model override set to ${model}${effort ? ` (${effort})` : ""}.`,
    );
  }

  async #handlePersonalityCommand(chatId: number, args: string): Promise<void> {
    const state = this.#chatState(chatId);
    const trimmed = args.trim().toLowerCase();
    if (!trimmed) {
      await this.#startLocalSlashInteractiveSession(chatId, buildPersonalityInteractiveSession(state));
      return;
    }
    if (trimmed === "status") {
      await this.#sendText(chatId, `Personality: ${state.personality ?? "default"}.`);
      return;
    }
    if (trimmed === "reset") {
      state.personality = null;
      await this.#saveState();
      await this.#sendText(chatId, "Personality reset to default.");
      return;
    }
    if (!["friendly", "pragmatic", "none"].includes(trimmed)) {
      await this.#sendText(chatId, "Usage: /personality [friendly|pragmatic|none|status|reset]");
      return;
    }
    state.personality = trimmed;
    await this.#saveState();
    await this.#sendText(chatId, `Personality set to ${trimmed}.`);
  }

  async #handleFastCommand(chatId: number, args: string): Promise<void> {
    const state = this.#chatState(chatId);
    const value = args.trim().toLowerCase();
    if (!value) {
      await this.#startLocalSlashInteractiveSession(chatId, buildFastInteractiveSession(state));
      return;
    }
    if (value === "status") {
      await this.#sendText(
        chatId,
        `Fast mode is ${state.serviceTier === "fast" ? "on" : "off"}.`,
      );
      return;
    }
    if (value === "on") {
      state.serviceTier = "fast";
      await this.#saveState();
      await this.#sendText(chatId, "Fast mode enabled.");
      return;
    }
    if (value === "off") {
      state.serviceTier = null;
      await this.#saveState();
      await this.#sendText(chatId, "Fast mode disabled.");
      return;
    }
    await this.#sendText(chatId, "Usage: /fast [on|off|status]");
  }

  async #handlePlanCommand(chatId: number, args: string): Promise<void> {
    const trimmed = args.trim();
    if (trimmed) {
      const collaborationMode = await this.#resolvePlanCollaborationMode();
      if (!collaborationMode) {
        await this.#sendText(chatId, "Plan mode is unavailable in this session.");
        return;
      }
      await this.#sendTask(chatId, trimmed, {
        collaborationMode,
      });
      return;
    }

    const session = buildPlanInteractiveSession(
      await this.#listCollaborationModes(),
      this.#chatState(chatId),
    );
    if (!session) {
      await this.#sendText(chatId, "No plan modes were available.");
      return;
    }
    await this.#startLocalSlashInteractiveSession(chatId, session);
  }

  async #handleCollabCommand(chatId: number, args: string): Promise<void> {
    const state = this.#chatState(chatId);
    const trimmed = args.trim();
    if (!trimmed) {
      const session = buildCollaborationInteractiveSession(
        await this.#listCollaborationModes(),
        state,
      );
      if (!session) {
        await this.#sendText(chatId, "No collaboration modes were available.");
        return;
      }
      await this.#startLocalSlashInteractiveSession(chatId, session);
      return;
    }

    if (trimmed === "status") {
      await this.#sendText(
        chatId,
        `Collaboration mode: ${state.collaborationModeName ?? "default"}.`,
      );
      return;
    }

    if (trimmed === "reset") {
      state.collaborationMode = null;
      state.collaborationModeName = null;
      await this.#saveState();
      await this.#sendText(chatId, "Collaboration mode reset to default.");
      return;
    }

    const collaborationMode = await this.#resolveNamedCollaborationMode(trimmed);
    if (!collaborationMode) {
      await this.#sendText(chatId, `Unknown collaboration mode: ${trimmed}`);
      return;
    }
    state.collaborationMode = collaborationMode;
    state.collaborationModeName = trimmed;
    await this.#saveState();
    await this.#sendText(chatId, `Collaboration mode set to ${trimmed}.`);
  }

  async #handleApprovalPolicyCommand(chatId: number, args: string): Promise<void> {
    const state = this.#chatState(chatId);
    const trimmed = args.trim().toLowerCase();
    if (!trimmed) {
      await this.#startLocalSlashInteractiveSession(
        chatId,
        buildApprovalPolicyInteractiveSession(state),
      );
      return;
    }
    if (trimmed === "status") {
      await this.#sendText(
        chatId,
        [
          `approval policy: ${state.approvalPolicy ?? "on-request"}`,
          "Usage: /permissions [untrusted|on-failure|on-request|never]",
        ].join("\n"),
      );
      return;
    }
    const policy = normalizeApprovalPolicy(trimmed);
    if (!policy) {
      await this.#sendText(
        chatId,
        "Usage: /permissions [untrusted|on-failure|on-request|never]",
      );
      return;
    }
    state.approvalPolicy = policy;
    await this.#saveState();
    await this.#sendText(chatId, `Approval policy set to ${policy}.`);
  }

  async #clearThread(chatId: number): Promise<void> {
    await this.#startNewThread(chatId, true);
    await this.#sendText(chatId, "Context cleared — fresh thread.");
  }

  async #sendGitDiff(chatId: number): Promise<void> {
    try {
      const status = await execFileAsync("git", ["status", "--short"], {
        cwd: this.#config.workspaceCwd,
        maxBuffer: 1024 * 1024,
      });
      const staged = await execFileAsync("git", ["diff", "--cached", "--stat", "--patch"], {
        cwd: this.#config.workspaceCwd,
        maxBuffer: 1024 * 1024,
      });
      const unstaged = await execFileAsync("git", ["diff", "--stat", "--patch"], {
        cwd: this.#config.workspaceCwd,
        maxBuffer: 1024 * 1024,
      });
      const text = [
        "Git status:",
        status.stdout.trim() || "(clean)",
        staged.stdout.trim() ? `\nStaged diff:\n${staged.stdout.trim()}` : "",
        unstaged.stdout.trim() ? `\nUnstaged diff:\n${unstaged.stdout.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      await this.#sendText(chatId, text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#sendText(chatId, `Failed to compute git diff: ${message}`);
    }
  }

  async #handleMentionCommand(chatId: number, args: string): Promise<void> {
    const query = args.trim();
    if (!query) {
      await this.#sendText(chatId, "Usage: /mention <file query>");
      return;
    }

    const files = await this.#searchWorkspaceFiles(query);
    const session = buildMentionInteractiveSession(files);
    if (!session) {
      await this.#sendText(chatId, `No files matched: ${query}`);
      return;
    }
    await this.#startLocalSlashInteractiveSession(chatId, session);
  }

  async #copyLastOutput(chatId: number): Promise<void> {
    const last = this.#chatState(chatId).lastAssistantMessage;
    if (!last) {
      await this.#sendText(
        chatId,
        "`/copy` is unavailable before the first completed Codex output.",
      );
      return;
    }
    await this.#sendText(chatId, last);
  }

  async #sendSkills(chatId: number): Promise<void> {
    const response = await this.#codex.call("skills/list", {
      cwds: [this.#config.workspaceCwd],
    });
    const data = Array.isArray(response.data) ? response.data : [];
    const lines = ["Skills:"];
    for (const entry of data) {
      const skills = Array.isArray((entry as JsonObject).skills)
        ? ((entry as JsonObject).skills as unknown[])
        : [];
      for (const skill of skills.slice(0, 20)) {
        const name = asString((skill as JsonObject).name);
        const description = asString((skill as JsonObject).description);
        if (name) {
          lines.push(`- ${name}${description ? `: ${description}` : ""}`);
        }
      }
    }
    await this.#sendText(chatId, lines.join("\n"));
  }

  async #sendMcpServers(chatId: number): Promise<void> {
    const response = await this.#codex.call("mcpServerStatus/list", {
      limit: 100,
      detail: "toolsAndAuthOnly",
    });
    const data = Array.isArray(response.data) ? response.data : [];
    const lines = ["MCP servers:"];
    for (const server of data.slice(0, 20)) {
      const entry = server as JsonObject;
      const name = asString(entry.name);
      const auth = asString(entry.authStatus) ?? "unknown";
      const tools = entry.tools && typeof entry.tools === "object" ? Object.keys(entry.tools as JsonObject).length : 0;
      if (name) {
        lines.push(`- ${name}: auth=${auth}, tools=${tools}`);
      }
    }
    await this.#sendText(chatId, lines.join("\n"));
  }

  async #sendApps(chatId: number): Promise<void> {
    const state = this.#chatState(chatId);
    const response = await this.#codex.call("app/list", {
      limit: 50,
      threadId: state.threadId,
    });
    const data = Array.isArray(response.data) ? response.data : [];
    const lines = ["Apps:"];
    for (const app of data.slice(0, 20)) {
      const entry = app as JsonObject;
      const name = asString(entry.name);
      const enabled = entry.isEnabled === true ? "enabled" : "disabled";
      const access = entry.isAccessible === true ? "accessible" : "needs-auth";
      if (name) {
        lines.push(`- ${name}: ${enabled}, ${access}`);
      }
    }
    await this.#sendText(chatId, lines.join("\n"));
  }

  async #sendPlugins(chatId: number): Promise<void> {
    const response = await this.#codex.call("plugin/list", {
      cwds: [this.#config.workspaceCwd],
    });
    const marketplaces = Array.isArray(response.marketplaces) ? response.marketplaces : [];
    const lines = ["Plugins:"];
    for (const marketplace of marketplaces) {
      const plugins = Array.isArray((marketplace as JsonObject).plugins)
        ? ((marketplace as JsonObject).plugins as JsonObject[])
        : [];
      for (const plugin of plugins.slice(0, 20)) {
        const name = asString(plugin.name);
        const installed = plugin.installed === true ? "installed" : "not-installed";
        const enabled = plugin.enabled === true ? "enabled" : "disabled";
        if (name) {
          lines.push(`- ${name}: ${installed}, ${enabled}`);
        }
      }
    }
    await this.#sendText(chatId, lines.join("\n"));
  }

  async #logoutAccount(chatId: number): Promise<void> {
    await this.#codex.call("account/logout");
    await this.#sendText(chatId, "Logged out of Codex.");
  }

  async #stopBackgroundTerminals(chatId: number): Promise<void> {
    const state = this.#chatState(chatId);
    if (!state.threadId) {
      await this.#sendText(chatId, "No current thread. Nothing to stop.");
      return;
    }
    await this.#codex.call("thread/backgroundTerminals/clean", {
      threadId: state.threadId,
    });
    await this.#sendText(chatId, "Stopping all background terminals for the current thread.");
  }

  async #handleExperimentalCommand(chatId: number, args: string): Promise<void> {
    const trimmed = args.trim();
    if (!trimmed) {
      const response = await this.#codex.call("experimentalFeature/list", {
        limit: 100,
      });
      const data = Array.isArray(response.data) ? response.data : [];
      const session = buildExperimentalInteractiveSession(data);
      if (!session) {
        await this.#sendText(chatId, "No experimental features were available.");
        return;
      }
      await this.#startLocalSlashInteractiveSession(chatId, session);
      return;
    }
    if (trimmed === "status") {
      const response = await this.#codex.call("experimentalFeature/list", {
        limit: 100,
      });
      const data = Array.isArray(response.data) ? response.data : [];
      const lines = ["Experimental features:"];
      for (const feature of data.slice(0, 20)) {
        const entry = feature as JsonObject;
        const name = asString(entry.name);
        const stage = asString(entry.stage) ?? "unknown";
        const enabled = entry.enabled === true ? "on" : "off";
        if (name) {
          lines.push(`- ${name}: ${enabled} (${stage})`);
        }
      }
      await this.#sendText(chatId, lines.join("\n"));
      return;
    }

    const parts = trimmed.split(/\s+/).filter(Boolean);
    if (parts.length !== 2 || !["on", "off"].includes(parts[1]!.toLowerCase())) {
      await this.#sendText(chatId, "Usage: /experimental <feature> <on|off>");
      return;
    }

    const featureName = parts[0]!;
    const enabled = parts[1]!.toLowerCase() === "on";
    await this.#codex.call("experimentalFeature/enablement/set", {
      enablement: { [featureName]: enabled },
    });
    await this.#sendText(chatId, `Experimental feature ${featureName} set to ${enabled ? "on" : "off"}.`);
  }

  async #handleFeedbackCommand(chatId: number): Promise<void> {
    await this.#startLocalSlashInteractiveSession(chatId, buildFeedbackInteractiveSession());
  }

  async #handleVerboseCommand(chatId: number, args: string): Promise<void> {
    const state = this.#chatState(chatId);
    const value = args.trim().toLowerCase();
    if (!value) {
      await this.#startLocalSlashInteractiveSession(chatId, buildVerboseInteractiveSession(state));
      return;
    }
    if (value === "status") {
      await this.#sendText(
        chatId,
        `Detailed tool/file messages are ${state.verbose ? "on" : "off"}.`,
      );
      return;
    }
    if (value === "on") {
      state.verbose = true;
      await this.#saveState();
      await this.#sendText(chatId, "Detailed tool/file messages enabled.");
      return;
    }
    if (value === "off") {
      state.verbose = false;
      await this.#saveState();
      await this.#sendText(chatId, "Detailed tool/file messages disabled.");
      return;
    }
    await this.#sendText(chatId, "Usage: /verbose [on|off|status]");
  }

  async #handleAgentCommand(chatId: number): Promise<void> {
    const state = this.#chatState(chatId);
    const response = await this.#codex.call("thread/list", {
      limit: 50,
      sortKey: "updated_at",
      cwd: this.#config.workspaceCwd,
      sourceKinds: [
        "cli",
        "vscode",
        "exec",
        "appServer",
        "subAgent",
        "subAgentReview",
        "subAgentCompact",
        "subAgentThreadSpawn",
        "subAgentOther",
      ],
    });
    const session = buildAgentThreadInteractiveSession(
      Array.isArray(response.data) ? response.data : [],
      state.threadId,
    );
    if (!session) {
      await this.#sendText(chatId, "No agent threads were available.");
      return;
    }
    await this.#startLocalSlashInteractiveSession(chatId, session);
  }

  async #showSessions(chatId: number, options: { global: boolean; cursor?: string | null }): Promise<void> {
    const currentThreadId = this.#chatState(chatId).threadId;
    const response = await this.#codex.call("thread/list", {
      limit: 8,
      sortKey: "updated_at",
      ...(options.cursor ? { cursor: options.cursor } : {}),
      ...(options.global ? {} : { cwd: this.#config.workspaceCwd }),
      sourceKinds: [
        "cli",
        "vscode",
        "exec",
        "appServer",
        "subAgent",
        "subAgentReview",
        "subAgentCompact",
        "subAgentThreadSpawn",
        "subAgentOther",
      ],
    });
    const threads = Array.isArray(response.data) ? [...response.data] : [];
    const nextCursor = asString(response.nextCursor);
    if (threads.length === 0) {
      await this.#sendText(chatId, "No recent sessions were found.");
      return;
    }

    threads.sort((left, right) => {
      const leftId = left && typeof left === "object" ? asString((left as JsonObject).id) : null;
      const rightId = right && typeof right === "object" ? asString((right as JsonObject).id) : null;
      if (leftId === currentThreadId) {
        return -1;
      }
      if (rightId === currentThreadId) {
        return 1;
      }
      return 0;
    });

    await this.#sendHtmlText(
      chatId,
      options.cursor
        ? (options.global ? "<b>More Sessions</b>" : "<b>More Sessions In This Workspace</b>")
        : (options.global ? "<b>All Sessions</b>" : "<b>Sessions</b>"),
    );
    for (const rawThread of threads) {
      if (!rawThread || typeof rawThread !== "object") {
        continue;
      }
      const thread = rawThread as JsonObject;
      const threadId = asString(thread.id);
      if (!threadId) {
        continue;
      }
      const isCurrent = currentThreadId === threadId;
      const replyMarkup = {
        inline_keyboard: [
          isCurrent
            ? [
                {
                  text: "Status",
                  callback_data: formatSessionCallbackData("status", threadId),
                },
              ]
            : [
                {
                  text: options.global ? "Continue" : "Take Over",
                  callback_data: formatSessionCallbackData("takeover", threadId),
                },
                {
                  text: "Status",
                  callback_data: formatSessionCallbackData("status", threadId),
                },
              ],
        ],
      } satisfies JsonObject;
      await this.#sendHtmlText(chatId, formatSessionCardHtml(thread, currentThreadId), replyMarkup);
    }
    if (nextCursor) {
      const token = randomBytes(4).toString("hex");
      this.#pendingSessionPages.set(token, {
        chatId,
        global: options.global,
        cursor: nextCursor,
      });
      const replyMarkup = {
        inline_keyboard: [[{
          text: "Load more sessions...",
          callback_data: formatSessionCallbackData("more", token),
        }]],
      } satisfies JsonObject;
      await this.#sendText(chatId, "Load more sessions...", replyMarkup);
    }
  }

  async #handleSessionCallback(
    callbackQueryId: string,
    chatId: number | null,
    parsed: { action: "takeover" | "status" | "confirmSwitch" | "cancelSwitch" | "more"; value: string },
  ): Promise<void> {
    if (chatId === null) {
      await this.#telegram.answerCallbackQuery(callbackQueryId, "Chat unavailable");
      return;
    }

    if (parsed.action === "more") {
      const pending = this.#pendingSessionPages.get(parsed.value);
      if (!pending || pending.chatId !== chatId) {
        await this.#telegram.answerCallbackQuery(callbackQueryId, "Session page expired");
        return;
      }
      this.#pendingSessionPages.delete(parsed.value);
      await this.#showSessions(chatId, {
        global: pending.global,
        cursor: pending.cursor,
      });
      await this.#telegram.answerCallbackQuery(callbackQueryId, "Loading more");
      return;
    }

    if (parsed.action === "confirmSwitch" || parsed.action === "cancelSwitch") {
      const pending = this.#pendingSessionSwitches.get(parsed.value);
      if (!pending || pending.chatId !== chatId) {
        await this.#telegram.answerCallbackQuery(callbackQueryId, "Session switch expired");
        return;
      }
      this.#pendingSessionSwitches.delete(parsed.value);
      if (parsed.action === "cancelSwitch") {
        await this.#telegram.answerCallbackQuery(callbackQueryId, "Cancelled");
        await this.#sendText(chatId, "Cancelled workspace switch.");
        return;
      }
      try {
        await this.#completeSessionTakeover(chatId, pending.threadId, pending.targetWorkspace);
      } catch (error) {
        if (error instanceof SessionOwnershipConflictError) {
          await this.#telegram.answerCallbackQuery(callbackQueryId, "Session locked");
          await this.#sendText(chatId, this.#formatSessionOwnershipConflict(error.threadId, error.ownerBotId));
          return;
        }
        throw error;
      }
      await this.#telegram.answerCallbackQuery(callbackQueryId, "Workspace switched");
      await this.#sendHtmlText(chatId, await this.#formatTakeoverMessage(pending.threadId, pending.targetWorkspace));
      return;
    }

    if (parsed.action === "takeover") {
      await this.#continueToSession(chatId, parsed.value);
      await this.#telegram.answerCallbackQuery(callbackQueryId, "Handled");
      return;
    }

    const response = await this.#codex.call("thread/read", {
      threadId: parsed.value,
      includeTurns: false,
    });
    const thread = response.thread as JsonObject | undefined;
    if (!thread) {
      await this.#telegram.answerCallbackQuery(callbackQueryId, "Session unavailable");
      return;
    }
    await this.#telegram.answerCallbackQuery(callbackQueryId, "Showing session");
    await this.#sendHtmlText(chatId, formatSessionStatusHtml(thread, this.#chatState(chatId).threadId));
  }

  async #handleContinueCommand(chatId: number, args: string): Promise<void> {
    const trimmed = args.trim();
    if (!trimmed) {
      await this.#showSessions(chatId, { global: true });
      return;
    }
    if (trimmed.split(/\s+/).length !== 1) {
      await this.#sendText(chatId, "Usage: /continue [exact-session-id]");
      return;
    }
    if (!isSessionIdLike(trimmed)) {
      await this.#sendText(chatId, "Usage: /continue [exact-session-id]");
      return;
    }
    await this.#continueToSession(chatId, trimmed);
  }

  async #continueToSession(chatId: number, threadId: string): Promise<void> {
    let response;
    try {
      response = await this.#codex.call("thread/read", {
        threadId,
        includeTurns: false,
      });
    } catch {
      await this.#sendText(chatId, `Session unavailable: ${threadId}`);
      return;
    }
    const thread = response.thread as JsonObject | undefined;
    if (!thread) {
      await this.#sendText(chatId, `Session unavailable: ${threadId}`);
      return;
    }
    const targetWorkspace = asString(thread.cwd);
    if (!targetWorkspace || targetWorkspace === this.#config.workspaceCwd) {
      try {
        await this.#takeOverSession(chatId, threadId);
      } catch (error) {
        if (error instanceof SessionOwnershipConflictError) {
          await this.#sendText(chatId, this.#formatSessionOwnershipConflict(error.threadId, error.ownerBotId));
          return;
        }
        throw error;
      }
      await this.#sendHtmlText(chatId, await this.#formatTakeoverMessage(threadId));
      return;
    }

    const token = randomBytes(4).toString("hex");
    this.#pendingSessionSwitches.set(token, { chatId, threadId, targetWorkspace });
    const replyMarkup = {
      inline_keyboard: [
        [
          {
            text: "Switch Workspace + Continue",
            callback_data: formatSessionCallbackData("confirmSwitch", token),
          },
          {
            text: "Cancel",
            callback_data: formatSessionCallbackData("cancelSwitch", token),
          },
        ],
      ],
    } satisfies JsonObject;
    await this.#sendHtmlText(
      chatId,
      [
        "<b>Continue session from another workspace?</b>",
        `Current workspace: <code>${escapeTelegramHtml(this.#config.workspaceCwd)}</code>`,
        `Target workspace: <code>${escapeTelegramHtml(targetWorkspace)}</code>`,
        `Session: <code>${escapeTelegramHtml(threadId)}</code>`,
      ].join("\n"),
      replyMarkup,
    );
  }

  async #takeOverSession(chatId: number, threadId: string): Promise<void> {
    const previousState = structuredClone(this.#chatState(chatId));
    const state = this.#chatState(chatId);
    this.#claimThreadOwnership(threadId);
    this.#resetChatSessionState(state, { releaseOwnership: false });
    state.threadId = threadId;
    try {
      await this.#codex.call("thread/resume", {
        threadId,
        ...threadSessionOverrides(this.#config, state),
      });
    } catch (error) {
      if (!isMissingRolloutResumeError(error)) {
        this.#releaseThreadOwnership(threadId);
        this.#state.chats[String(chatId)] = previousState;
        await this.#saveState();
        throw error;
      }
    }
    this.#releaseThreadOwnership(previousState.threadId);
    await this.#saveState();
  }

  async #completeSessionTakeover(chatId: number, threadId: string, targetWorkspace: string): Promise<void> {
    const previousWorkspace = this.#config.workspaceCwd;
    const previousState = structuredClone(this.#state);
    this.#claimThreadOwnership(threadId);
    this.#config.workspaceCwd = targetWorkspace;
    this.#clearAllChatBindings({ releaseOwnership: false });
    const state = this.#chatState(chatId);
    this.#resetChatSessionState(state, { releaseOwnership: false });
    state.threadId = threadId;
    try {
      await this.#codex.call("thread/resume", {
        threadId,
        ...threadSessionOverrides(this.#config, state),
      });
    } catch (error) {
      if (!isMissingRolloutResumeError(error)) {
        this.#releaseThreadOwnership(threadId);
        this.#config.workspaceCwd = previousWorkspace;
        this.#state = previousState;
        throw error;
      }
    }
    for (const chatState of Object.values(previousState.chats)) {
      this.#releaseThreadOwnership(chatState.threadId);
    }
    await this.#persistConfig();
    await this.#saveState();
  }

  async #formatTakeoverMessage(threadId: string, switchedWorkspace?: string): Promise<string> {
    const lines: string[] = [];
    if (switchedWorkspace) {
      lines.push(`Switched workspace to <code>${escapeTelegramHtml(switchedWorkspace)}</code>.`);
    }
    lines.push(`Took over session <code>${escapeTelegramHtml(threadId)}</code>.`);

    try {
      const response = await this.#codex.call("thread/read", {
        threadId,
        includeTurns: true,
      });
      const preview = formatRecentTurnsPreview(response.thread as JsonObject | undefined, 3);
      if (preview) {
        lines.push("");
        lines.push(preview);
      }
    } catch (error) {
      if (!isThreadNotMaterializedError(error)) {
        this.#logRuntimeError("thread/read takeover preview", error);
      }
    }

    return lines.join("\n");
  }

  async #sendRolloutPath(chatId: number): Promise<void> {
    const state = this.#chatState(chatId);
    if (!state.threadId) {
      await this.#sendText(chatId, "No current thread. Send a task or use /new first.");
      return;
    }
    const response = await this.#codex.call("thread/read", {
      threadId: state.threadId,
      includeTurns: false,
    });
    const thread = response.thread as JsonObject | undefined;
    const rolloutPath = asString(thread?.path);
    await this.#sendText(chatId, rolloutPath ? `Rollout path: ${rolloutPath}` : "No rollout path available.");
  }

  async #sendTurnControls(chatId: number, turnId: string): Promise<void> {
    const state = this.#chatState(chatId);
    const hasPendingInput = Array.isArray(state.pendingTurnInput) && state.pendingTurnInput.length > 0;
    const replyMarkup = {
      inline_keyboard: [
        [
          {
            text: hasPendingInput ? "Steer" : "Queue Next",
            callback_data: formatTurnControlCallbackData(hasPendingInput ? "steer" : "queue", turnId),
          },
          {
            text: hasPendingInput ? "Queue Next" : "Interrupt",
            callback_data: formatTurnControlCallbackData(hasPendingInput ? "queue" : "interrupt", turnId),
          },
          ...(hasPendingInput
            ? [
                {
                  text: "Cancel",
                  callback_data: formatTurnControlCallbackData("cancel", turnId),
                },
              ]
            : []),
        ],
      ],
    } satisfies JsonObject;
    const message = await this.#sendText(
      chatId,
      hasPendingInput
        ? "Turn active — steer with your message or queue it for next?"
        : "Turn active.",
      replyMarkup,
    );
    state.turnControlTurnId = turnId;
    state.turnControlMessageId = message.message_id;
    await this.#saveState();
  }

  async #handleTurnControlCallback(
    callbackQueryId: string,
    chatId: number | null,
    parsed: { action: "steer" | "queue" | "cancel" | "interrupt"; turnId: string },
  ): Promise<void> {
    if (chatId === null) {
      await this.#telegram.answerCallbackQuery(callbackQueryId, "Chat unavailable");
      return;
    }
    const state = this.#chatState(chatId);
    if (state.activeTurnId !== parsed.turnId) {
      await this.#clearTurnControls(chatId, parsed.turnId);
      await this.#telegram.answerCallbackQuery(callbackQueryId, "Turn is no longer active");
      return;
    }
    if (parsed.action === "steer") {
      if (!state.pendingTurnInput) {
        await this.#clearTurnControls(chatId, parsed.turnId);
        await this.#telegram.answerCallbackQuery(callbackQueryId, "No pending message");
        return;
      }
      const input = state.pendingTurnInput;
      state.pendingTurnInput = null;
      await this.#saveState();
      await this.#clearTurnControls(chatId, parsed.turnId);
      await this.#codex.call("turn/steer", {
        threadId: state.threadId,
        input,
        expectedTurnId: state.activeTurnId,
      });
      await this.#telegram.answerCallbackQuery(callbackQueryId, "Steering current turn");
      await this.#sendHtmlText(chatId, formatPendingInputActionHtml("steered", input));
      return;
    }
    if (parsed.action === "queue") {
      if (state.pendingTurnInput) {
        state.queuedTurnInput = state.pendingTurnInput;
        state.pendingTurnInput = null;
        await this.#saveState();
        await this.#clearTurnControls(chatId, parsed.turnId);
        await this.#telegram.answerCallbackQuery(callbackQueryId, "Queued for next turn");
        await this.#sendHtmlText(chatId, formatPendingInputActionHtml("queued", state.queuedTurnInput));
        return;
      }
      state.queueNextArmed = true;
      await this.#saveState();
      await this.#clearTurnControls(chatId, parsed.turnId);
      await this.#telegram.answerCallbackQuery(callbackQueryId, "Next message will be queued");
      await this.#sendHtmlText(chatId, formatPendingInputActionHtml("armed"));
      return;
    }
    if (parsed.action === "cancel") {
      state.pendingTurnInput = null;
      await this.#saveState();
      await this.#clearTurnControls(chatId, parsed.turnId);
      await this.#telegram.answerCallbackQuery(callbackQueryId, "Cancelled");
      await this.#sendText(chatId, "Cancelled.");
      return;
    }
    await this.#clearTurnControls(chatId, parsed.turnId);
    await this.#telegram.answerCallbackQuery(callbackQueryId, "Interrupting");
    await this.#interruptTurn(chatId);
  }

  async #handleServerRequest(message: JsonObject): Promise<void> {
    const method = String(message.method);
    const params = (message.params as JsonObject | undefined) ?? {};
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    const chatId = threadId ? this.#findChatIdByThread(threadId) : null;
    if (chatId === null) {
      await this.#codex.respond(message.id as string | number, autoDeclineResult(method));
      return;
    }

    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval" ||
      method === "item/permissions/requestApproval"
    ) {
      const token = randomBytes(4).toString("hex");
      this.#pendingApprovals.set(token, {
        requestId: message.id as string | number,
        chatId,
        method,
        params,
      });
      await this.#sendApprovalPrompt(chatId, token, method, params);
      return;
    }

    if (method === "item/tool/requestUserInput") {
      await this.#startToolInteractiveSession(chatId, message.id as string | number, params);
      return;
    }

    if (method === "mcpServer/elicitation/request") {
      await this.#startMcpInteractiveSession(chatId, message.id as string | number, params);
      return;
    }

    await this.#codex.respond(message.id as string | number, autoDeclineResult(method));
  }

  async #handleNotification(method: string, params: JsonObject): Promise<void> {
    const threadId = typeof params.threadId === "string" ? params.threadId : null;

    if (method === "item/started") {
      const item = params.item as JsonObject | undefined;
      if (item && typeof item.id === "string") {
        this.#items.set(item.id, item);
      }
      return;
    }

    if (method === "turn/started" && threadId) {
      const chatId = this.#findChatIdByThread(threadId);
      const turn = params.turn as JsonObject | undefined;
      const turnId = typeof turn?.id === "string" ? turn.id : null;
      if (chatId !== null && turnId) {
        this.#chatState(chatId).activeTurnId = turnId;
        this.#chatState(chatId).freshThread = false;
        await this.#saveState();
        this.#startTypingIndicator(chatId);
      }
      return;
    }

    if (method === "item/agentMessage/delta" && threadId) {
      const turnId = asString(params.turnId);
      const itemId = asString(params.itemId);
      const chatId = this.#findChatIdByThread(threadId);
      if (!turnId || !itemId || chatId === null) {
        return;
      }
      const stream = this.#getOrCreateAgentStream(threadId, turnId, chatId, itemId);
      stream.text += asString(params.delta) ?? "";
      await this.#flushStream(stream, false);
      return;
    }

    if (method === "item/completed" && threadId) {
      const chatId = this.#findChatIdByThread(threadId);
      const turnId = asString(params.turnId);
      const item = params.item as JsonObject | undefined;
      const itemType = asString(item?.type);
      if (chatId === null || !turnId || !item || !itemType) {
        return;
      }
      if (itemType === "agentMessage") {
        const itemId = asString(item.id);
        if (itemId) {
          this.#items.set(itemId, item);
        }
        const stream =
          itemId !== null ? this.#getOrCreateAgentStream(threadId, turnId, chatId, itemId) : null;
        if (stream) {
          const itemText = asString(item.text);
          if (itemText) {
            stream.text = itemText;
          }
          await this.#flushStream(stream, true);
        }
        const messageText = asString(item.text) ?? stream?.text ?? null;
        const phase = asString(item.phase) ?? stream?.phase;
        if (messageText && phase !== "commentary") {
          this.#chatState(chatId).lastAssistantMessage = messageText;
          await this.#saveState();
        }
        return;
      }
      if (itemType === "commandExecution") {
        await this.#sendHtmlText(chatId, formatCommandCompletionHtml(item, this.#chatState(chatId).verbose));
        return;
      }
      if (itemType === "fileChange") {
        await this.#sendHtmlText(chatId, formatFileChangeCompletionHtml(item, this.#chatState(chatId).verbose));
      }
      return;
    }

    if (method === "turn/completed" && threadId) {
      const chatId = this.#findChatIdByThread(threadId);
      const turn = params.turn as JsonObject | undefined;
      const turnId = asString(turn?.id);
      if (chatId === null || !turn || !turnId) {
        return;
      }
      const state = this.#chatState(chatId);
      if (state.activeTurnId === turnId) {
        state.activeTurnId = null;
        await this.#saveState();
      }
      if (!state.queuedTurnInput && state.pendingTurnInput) {
        state.queuedTurnInput = state.pendingTurnInput;
      }
      state.pendingTurnInput = null;
      const streams = this.#streamsForTurn(threadId, turnId);
      let lastNonCommentaryMessage: string | null = null;
      for (const stream of streams) {
        await this.#flushStream(stream, true);
        if (stream.text && stream.phase !== "commentary") {
          lastNonCommentaryMessage = stream.text;
        }
        this.#streams.delete(stream.streamId);
      }
      if (lastNonCommentaryMessage) {
        state.lastAssistantMessage = lastNonCommentaryMessage;
        await this.#saveState();
      }
      this.#stopTypingIndicator(chatId);
      await this.#clearTurnControls(chatId, turnId);
      const queuedTurnInput = state.queuedTurnInput;
      state.queuedTurnInput = null;
      const status = asString(turn.status) ?? "unknown";
      const error = (turn.error as JsonObject | undefined)?.message;
      const completionHtml = formatTurnCompletionHtml(status, typeof error === "string" ? error : null);
      if (completionHtml) {
        await this.#sendHtmlText(chatId, completionHtml);
      }
      if (queuedTurnInput) {
        await this.#sendHtmlText(chatId, formatPendingInputActionHtml("starting", queuedTurnInput));
        await this.#startTurn(chatId, queuedTurnInput);
      }
      return;
    }

    if (method === "error" && threadId) {
      const chatId = this.#findChatIdByThread(threadId);
      if (chatId === null) {
        return;
      }
      this.#stopTypingIndicator(chatId);
      const error = (params.error as JsonObject | undefined)?.message;
      await this.#sendHtmlText(chatId, `<b>Error</b>\n${escapeTelegramHtml(typeof error === "string" ? error : "unknown error")}`);
    }
  }

  async #maybePairOwner(userId: number, chatId: number, text: string): Promise<void> {
    const slashCommand = parseTelegramSlashCommand(text);
    if (slashCommand?.name !== "start") {
      await this.#sendText(chatId, "Send /start to pair this Telegram account with Codex Anywhere.");
      return;
    }
    this.#config.ownerUserId = userId;
    await this.#persistConfig();
    await this.#sendText(
      chatId,
      [
        "✅ Codex Anywhere paired.",
        "You can now send a task like `fix tests`.",
        "Use /help to see commands, /resume to browse sessions, or send a screenshot with a caption.",
      ].join("\n"),
    );
  }

  async #startNewThread(chatId: number, silent = false): Promise<string> {
    const result = await this.#codex.call(
      "thread/start",
      threadSessionOverrides(this.#config, this.#chatState(chatId)),
    );
    const thread = result.thread as JsonObject | undefined;
    const threadId = asString(thread?.id);
    if (!threadId) {
      throw new Error("Codex did not return a thread id.");
    }
    const state = this.#chatState(chatId);
    this.#replaceThreadOwnership(state.threadId, threadId);
    state.threadId = threadId;
    state.freshThread = true;
    state.activeTurnId = null;
    await this.#saveState();
    if (!silent) {
      await this.#sendText(chatId, "New thread started.");
    }
    return threadId;
  }

  async #resumeThread(chatId: number, silent = false): Promise<string> {
    const state = this.#chatState(chatId);
    if (!state.threadId) {
      return await this.#startNewThread(chatId, silent);
    }

    const existingThreadId = state.threadId;
    try {
      await this.#codex.call("thread/resume", {
        threadId: existingThreadId,
        ...threadSessionOverrides(this.#config, state),
      });
      state.freshThread = false;
      await this.#saveState();
      if (!silent) {
        await this.#sendText(chatId, "Thread resumed.");
      }
      return existingThreadId;
    } catch (error) {
      if (!isMissingRolloutResumeError(error)) {
        throw error;
      }
    }

    this.#releaseThreadOwnership(existingThreadId);
    state.threadId = null;
    state.freshThread = false;
    state.activeTurnId = null;
    state.turnControlTurnId = null;
    state.turnControlMessageId = null;
    await this.#saveState();
    return await this.#startNewThread(chatId, silent);
  }

  async #interruptTurn(chatId: number): Promise<void> {
    const state = this.#chatState(chatId);
    if (state.activeTurnId) {
      await this.#reconcileActiveTurnState(chatId);
    }
    if (!state.threadId || !state.activeTurnId) {
      await this.#sendText(chatId, "No active turn to interrupt.");
      return;
    }
    await this.#codex.call("turn/interrupt", {
      threadId: state.threadId,
      turnId: state.activeTurnId,
    });
    await this.#sendText(chatId, "Interrupting turn…");
  }

  async #runShellCommand(chatId: number, command: string): Promise<void> {
    if (!command) {
      await this.#sendText(chatId, "Usage: /sh <command>");
      return;
    }
    const token = randomBytes(4).toString("hex");
    this.#pendingShellCommands.set(token, { chatId, command });
    const replyMarkup = {
      inline_keyboard: [
        [
          {
            text: "Run",
            callback_data: formatShellCallbackData(token, "run"),
          },
          {
            text: "Cancel",
            callback_data: formatShellCallbackData(token, "cancel"),
          },
        ],
      ],
    } satisfies JsonObject;
    await this.#sendHtmlText(
      chatId,
      `<b>Run shell command?</b>\n<code>${escapeTelegramHtml(command)}</code>`,
      replyMarkup,
    );
  }

  async #sendTask(chatId: number, text: string, extraParams?: JsonObject): Promise<void> {
    await this.#startTurn(chatId, [{ type: "text", text }], extraParams);
  }

  async #startTurn(
    chatId: number,
    input: JsonObject[],
    extraParams?: JsonObject,
  ): Promise<void> {
    let threadId = await this.#resumeThread(chatId, true);
    const state = this.#chatState(chatId);
    let params = {
      threadId,
      input,
      ...turnSessionOverrides(this.#config, state),
      ...(extraParams ?? {}),
    } satisfies JsonObject;

    let result: JsonObject;
    try {
      result = await this.#codex.call("turn/start", params);
    } catch (error) {
      if (!isMissingRolloutResumeError(error)) {
        throw error;
      }
      this.#releaseThreadOwnership(threadId);
      state.threadId = null;
      state.freshThread = false;
      state.activeTurnId = null;
      state.turnControlTurnId = null;
      state.turnControlMessageId = null;
      await this.#saveState();
      threadId = await this.#startNewThread(chatId, true);
      params = {
        threadId,
        input,
        ...turnSessionOverrides(this.#config, this.#chatState(chatId)),
        ...(extraParams ?? {}),
      } satisfies JsonObject;
      result = await this.#codex.call("turn/start", params);
    }

    const turn = result.turn as JsonObject | undefined;
    const turnId = asString(turn?.id);
    if (!turnId) {
      throw new Error("Codex did not return a turn id.");
    }
    state.activeTurnId = turnId;
    state.freshThread = false;
    await this.#saveState();
  }

  async #sendStatus(chatId: number): Promise<void> {
    await this.#reconcileActiveTurnState(chatId);
    const state = this.#chatState(chatId);
    let rateLimits = "unavailable";
    try {
      const response = await this.#codex.call("account/rateLimits/read");
      const snapshot = response.rateLimits as JsonObject | undefined;
      rateLimits = formatRateLimitSnapshot(snapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rateLimits = `error: ${message}`;
    }
    const esc = escapeTelegramHtml;
    const shortThread = state.threadId
      ? (state.threadId.length > 12 ? state.threadId.slice(0, 8) : state.threadId)
      : "none";
    const lines = [
      `<b>Status</b>`,
      `workspace  <code>${esc(this.#config.workspaceCwd)}</code>`,
      `thread  <code>${esc(shortThread)}</code>${state.activeTurnId ? "  ⚡ turn active" : ""}`,
      `model  <code>${esc(state.model ?? "default")}${state.reasoningEffort ? ` (${state.reasoningEffort})` : ""}</code>`,
      `fast  <code>${state.serviceTier === "fast" ? "on" : "off"}</code>`,
      `approval  <code>${esc(state.approvalPolicy ?? "on-request")}</code>`,
      `rate limits  ${esc(rateLimits)}`,
    ];
    await this.#sendHtmlText(chatId, lines.join("\n"));
  }

  async #sendApprovalPrompt(chatId: number, token: string, method: string, params: JsonObject): Promise<void> {
    this.#stopTypingIndicator(chatId);
    const text = formatApprovalPromptHtml(method, params, this.#items);
    const replyMarkup = {
      inline_keyboard: [
        [
          { text: "Approve", callback_data: formatApprovalCallbackData(token, "approve") },
          { text: "Approve session", callback_data: formatApprovalCallbackData(token, "session") },
        ],
        [
          { text: "Decline", callback_data: formatApprovalCallbackData(token, "decline") },
          { text: "Cancel", callback_data: formatApprovalCallbackData(token, "cancel") },
        ],
      ],
    } satisfies JsonObject;
    await this.#sendHtmlText(chatId, text, replyMarkup);
  }

  async #resolveApproval(
    approval: PendingApproval,
    action: "approve" | "session" | "decline" | "cancel",
  ): Promise<void> {
    if (approval.method === "item/permissions/requestApproval") {
      const result =
        action === "decline" || action === "cancel"
          ? { permissions: {}, scope: "turn" }
          : {
              permissions: (approval.params.permissions as JsonObject | undefined) ?? {},
              scope: action === "session" ? "session" : "turn",
            };
      await this.#codex.respond(approval.requestId, result);
      await this.#sendText(approval.chatId, formatApprovalFeedback(action));
      return;
    }

    const decision =
      action === "approve"
        ? "accept"
        : action === "session"
          ? "acceptForSession"
          : action === "decline"
            ? "decline"
            : "cancel";
    await this.#codex.respond(approval.requestId, { decision });
    await this.#sendText(approval.chatId, formatApprovalFeedback(action));
  }

  async #flushStream(stream: StreamBuffer, force: boolean): Promise<void> {
    const now = Date.now();
    if (!force && now - stream.lastFlushAt < this.#config.streamEditIntervalMs) {
      return;
    }

    const raw = stream.text || "🤖 Working on it…";
    const chunks = splitTelegramChunks(raw);
    const needsChunking = force && chunks.length > 1;

    // During streaming: show clamped tail in one message.
    // On final flush with overflow: render all chunks as separate messages.
    if (needsChunking) {
      // Edit the existing streaming message with the first chunk.
      const firstHtml = renderAssistantTextHtml(chunks[0]!);
      if (stream.messageId === null) {
        const message = await this.#telegram.sendMessage(stream.chatId, firstHtml, undefined, "HTML");
        stream.messageId = message.message_id;
      } else {
        await this.#telegram.editMessageText(stream.chatId, stream.messageId, firstHtml, undefined, "HTML");
      }
      // Send remaining chunks as new messages.
      for (let i = 1; i < chunks.length; i++) {
        const html = renderAssistantTextHtml(chunks[i]!);
        await this.#telegram.sendMessage(stream.chatId, html, undefined, "HTML");
      }
    } else {
      const html = renderAssistantTextHtml(clampTelegramText(raw));
      if (stream.messageId === null) {
        const message = await this.#telegram.sendMessage(stream.chatId, html, undefined, "HTML");
        stream.messageId = message.message_id;
      } else {
        await this.#telegram.editMessageText(stream.chatId, stream.messageId, html, undefined, "HTML");
      }
    }

    stream.lastFlushAt = now;
  }

  async #sendText(
    chatId: number,
    text: string,
    replyMarkup?: JsonObject,
  ): Promise<{ message_id: number }> {
    const chunks = splitTelegramChunks(text);
    let last!: { message_id: number };
    for (const [i, chunk] of chunks.entries()) {
      last = await this.#telegram.sendMessage(
        chatId,
        chunk,
        i === chunks.length - 1 ? replyMarkup : undefined,
      );
    }
    return last;
  }

  async #sendHtmlText(
    chatId: number,
    text: string,
    replyMarkup?: JsonObject,
  ): Promise<{ message_id: number }> {
    const chunks = splitTelegramChunks(text);
    let last!: { message_id: number };
    for (const [i, chunk] of chunks.entries()) {
      last = await this.#telegram.sendMessage(
        chatId,
        chunk,
        i === chunks.length - 1 ? replyMarkup : undefined,
        "HTML",
      );
    }
    return last;
  }

  async #clearTurnControls(chatId: number, turnId: string): Promise<void> {
    const state = this.#chatState(chatId);
    if (state.turnControlTurnId !== turnId || state.turnControlMessageId === null) {
      return;
    }
    const messageId = state.turnControlMessageId;
    state.turnControlTurnId = null;
    state.turnControlMessageId = null;
    await this.#saveState();
    try {
      await this.#telegram.deleteMessage(chatId, messageId);
    } catch (error) {
      this.#logRuntimeError("deleteMessage", error);
    }
  }

  #startTypingIndicator(chatId: number): void {
    this.#stopTypingIndicator(chatId);
    const tick = () => {
      void this.#telegram.sendChatAction(chatId, "typing").catch((error) => {
        this.#logRuntimeError("sendChatAction", error);
      });
    };
    tick();
    const interval = setInterval(tick, 4000);
    interval.unref?.();
    this.#typingIntervals.set(chatId, interval);
  }

  #stopTypingIndicator(chatId: number): void {
    const interval = this.#typingIntervals.get(chatId);
    if (!interval) {
      return;
    }
    clearInterval(interval);
    this.#typingIntervals.delete(chatId);
  }

  #getOrCreateAgentStream(
    threadId: string,
    turnId: string,
    chatId: number,
    itemId: string,
  ): StreamBuffer {
    const item = this.#items.get(itemId);
    const phase = asString(item?.phase);
    const streamId = agentStreamKey(threadId, turnId, streamGroupId(itemId, phase));
    const existing = this.#streams.get(streamId);
    if (existing) {
      return existing;
    }
    const stream: StreamBuffer = {
      threadId,
      turnId,
      streamId,
      chatId,
      text: "",
      messageId: null,
      lastFlushAt: 0,
      phase,
    };
    this.#streams.set(streamId, stream);
    return stream;
  }

  #streamsForTurn(threadId: string, turnId: string): StreamBuffer[] {
    const prefix = `${threadId}:${turnId}:`;
    return [...this.#streams.values()].filter((stream) => stream.streamId.startsWith(prefix));
  }

  async #executeShellCommand(chatId: number, command: string): Promise<void> {
    const threadId = await this.#resumeThread(chatId, true);
    await this.#codex.call("thread/shellCommand", {
      threadId,
      command,
    });
    await this.#sendHtmlText(
      chatId,
      `Running <code>${escapeTelegramHtml(command)}</code>`,
    );
  }

  async #applyLocalModelSelection(
    chatId: number,
    answers: Record<string, unknown>,
  ): Promise<void> {
    const state = this.#chatState(chatId);
    const model = asString(answers.model);
    if (!model) {
      await this.#sendText(chatId, "Model selection was incomplete.");
      return;
    }
    if (model === "__reset__") {
      state.model = null;
      state.reasoningEffort = null;
      await this.#saveState();
      await this.#sendText(chatId, "Model override cleared.");
      return;
    }

    const effortValue = asString(answers.reasoningEffort);
    const effort =
      effortValue && effortValue !== "__default__"
        ? normalizeReasoningEffort(effortValue)
        : null;

    state.model = model;
    state.reasoningEffort = effort;
    await this.#saveState();
    await this.#sendText(
      chatId,
      `Model override set to ${model}${effort ? ` (${effort})` : ""}.`,
    );
  }

  async #applyLocalPersonalitySelection(
    chatId: number,
    answers: Record<string, unknown>,
  ): Promise<void> {
    const value = asString(answers.personality);
    if (!value) {
      await this.#sendText(chatId, "Personality selection was incomplete.");
      return;
    }
    const state = this.#chatState(chatId);
    state.personality = value === "__default__" ? null : value;
    await this.#saveState();
    await this.#sendText(chatId, `Personality set to ${state.personality ?? "default"}.`);
  }

  async #applyLocalFastSelection(
    chatId: number,
    answers: Record<string, unknown>,
  ): Promise<void> {
    const state = this.#chatState(chatId);
    const serviceTier = asString(answers.serviceTier);
    if (!serviceTier) {
      await this.#sendText(chatId, "Fast mode selection was incomplete.");
      return;
    }
    state.serviceTier = serviceTier === "fast" ? "fast" : null;
    await this.#saveState();
    await this.#sendText(
      chatId,
      `Fast mode ${state.serviceTier === "fast" ? "enabled" : "disabled"}.`,
    );
  }

  async #applyLocalApprovalPolicySelection(
    chatId: number,
    answers: Record<string, unknown>,
  ): Promise<void> {
    const policy = asString(answers.approvalPolicy);
    if (!policy) {
      await this.#sendText(chatId, "Approval policy selection was incomplete.");
      return;
    }
    this.#chatState(chatId).approvalPolicy = policy;
    await this.#saveState();
    await this.#sendText(chatId, `Approval policy set to ${policy}.`);
  }

  async #applyLocalCollaborationSelection(
    chatId: number,
    answers: Record<string, unknown>,
  ): Promise<void> {
    const modeName = asString(answers.collaborationModeName);
    if (!modeName) {
      await this.#sendText(chatId, "Collaboration mode selection was incomplete.");
      return;
    }
    const state = this.#chatState(chatId);
    if (modeName === "__reset__") {
      state.collaborationMode = null;
      state.collaborationModeName = null;
      await this.#saveState();
      await this.#sendText(chatId, "Collaboration mode reset to default.");
      return;
    }
    const collaborationMode = await this.#resolveNamedCollaborationMode(modeName);
    if (!collaborationMode) {
      await this.#sendText(chatId, `Unknown collaboration mode: ${modeName}`);
      return;
    }
    state.collaborationMode = collaborationMode;
    state.collaborationModeName = modeName;
    await this.#saveState();
    await this.#sendText(chatId, `Collaboration mode set to ${modeName}.`);
  }

  async #applyLocalExperimentalSelection(
    chatId: number,
    answers: Record<string, unknown>,
  ): Promise<void> {
    const featureName = asString(answers.featureName);
    const enabledValue = asString(answers.enabled);
    if (!featureName || !enabledValue) {
      await this.#sendText(chatId, "Experimental feature selection was incomplete.");
      return;
    }
    const enabled = enabledValue === "on";
    await this.#codex.call("experimentalFeature/enablement/set", {
      enablement: { [featureName]: enabled },
    });
    await this.#sendText(
      chatId,
      `Experimental feature ${featureName} set to ${enabled ? "on" : "off"}.`,
    );
  }

  async #applyLocalFeedbackSelection(
    chatId: number,
    answers: Record<string, unknown>,
  ): Promise<void> {
    const classification = asString(answers.classification);
    const includeLogs = answers.includeLogs === true;
    if (!classification) {
      await this.#sendText(chatId, "Feedback selection was incomplete.");
      return;
    }
    const state = this.#chatState(chatId);
    const params: JsonObject = {
      classification,
      reason: null,
      threadId: state.threadId,
      includeLogs,
      extraLogFiles: null,
    };
    const result = await this.#codex.call("feedback/upload", params);
    const threadId = asString(result.threadId) ?? "<unknown>";
    await this.#sendText(chatId, `Feedback submitted.\nThread ID: ${threadId}`);
  }

  async #applyLocalAgentSelection(
    chatId: number,
    answers: Record<string, unknown>,
  ): Promise<void> {
    const threadId = asString(answers.threadId);
    if (!threadId) {
      await this.#sendText(chatId, "Agent selection was incomplete.");
      return;
    }
    const state = this.#chatState(chatId);
    try {
      this.#replaceThreadOwnership(state.threadId, threadId);
    } catch (error) {
      if (error instanceof SessionOwnershipConflictError) {
        await this.#sendText(chatId, this.#formatSessionOwnershipConflict(error.threadId, error.ownerBotId));
        return;
      }
      throw error;
    }
    state.threadId = threadId;
    state.freshThread = false;
    state.activeTurnId = null;
    await this.#saveState();
    await this.#codex.call("thread/resume", {
      threadId,
      ...threadSessionOverrides(this.#config, state),
    });
    await this.#sendText(chatId, `Active agent thread set to ${threadId}.`);
  }

  async #applyLocalMentionSelection(
    chatId: number,
    answers: Record<string, unknown>,
  ): Promise<void> {
    const mentionPath = asString(answers.mentionPath);
    if (!mentionPath) {
      await this.#sendText(chatId, "Mention selection was incomplete.");
      return;
    }
    const state = this.#chatState(chatId);
    state.pendingMention = {
      name: path.basename(mentionPath),
      path: mentionPath,
    };
    await this.#saveState();
    await this.#sendText(
      chatId,
      `File mention ready: ${mentionPath}\nSend your next message and it will include this file.`,
    );
  }

  async #applyLocalVerboseSelection(
    chatId: number,
    answers: Record<string, unknown>,
  ): Promise<void> {
    const value = asString(answers.verboseMode);
    if (!value) {
      await this.#sendText(chatId, "Verbose selection was incomplete.");
      return;
    }
    const state = this.#chatState(chatId);
    state.verbose = value === "on";
    await this.#saveState();
    await this.#sendText(
      chatId,
      `Detailed tool/file messages ${state.verbose ? "enabled" : "disabled"}.`,
    );
  }

  async #applyLocalAddBotSelection(
    chatId: number,
    answers: Record<string, unknown>,
  ): Promise<void> {
    if (!this.#addBotFn) {
      await this.#sendText(chatId, "Adding bots from Telegram is not available in this runtime.");
      return;
    }
    const rawBotId = asString(answers.botId)?.trim();
    const telegramBotToken = asString(answers.telegramBotToken)?.trim();
    const workspaceInput = asString(answers.workspaceCwd)?.trim();
    const labelInput = asString(answers.label)?.trim() ?? "";
    if (!rawBotId || !telegramBotToken || !workspaceInput) {
      await this.#sendText(chatId, "Add-bot details were incomplete.");
      return;
    }

    const workspaceCwd = resolveWorkspacePath(
      workspaceInput,
      this.#config.workspaceCwd,
      os.homedir(),
    );
    try {
      await fs.access(workspaceCwd);
    } catch {
      await this.#sendText(chatId, `Workspace path does not exist: ${workspaceCwd}`);
      return;
    }

    const bot: BotRuntimeConfig = {
      id: rawBotId,
      label: labelInput === "-" ? rawBotId : (labelInput || rawBotId),
      telegramBotToken,
      workspaceCwd,
      ownerUserId: this.#config.ownerUserId,
      pollTimeoutSeconds: this.#config.pollTimeoutSeconds,
      streamEditIntervalMs: this.#config.streamEditIntervalMs,
    };

    try {
      await this.#addBotFn(bot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#sendText(chatId, `Failed to add bot: ${message}`);
      return;
    }

    await this.#sendText(
      chatId,
      [
        `Added bot ${bot.id}.`,
        `Workspace: ${bot.workspaceCwd}`,
        "The new Telegram bot is now configured and started in this runtime.",
      ].join("\n"),
    );
  }

  async #applyLocalRenameSelection(
    chatId: number,
    answers: Record<string, unknown>,
  ): Promise<void> {
    const name = asString(answers.threadName)?.trim();
    if (!name) {
      await this.#sendText(chatId, "Thread name was incomplete.");
      return;
    }
    await this.#renameThread(chatId, name);
  }

  async #applyLocalReviewSelection(
    chatId: number,
    answers: Record<string, unknown>,
  ): Promise<void> {
    const targetKind = asString(answers.targetKind);
    if (!targetKind) {
      await this.#sendText(chatId, "Review target selection was incomplete.");
      return;
    }

    if (targetKind === "uncommittedChanges") {
      await this.#runReview(chatId, { type: "uncommittedChanges" });
      return;
    }

    const targetValue = asString(answers.targetValue)?.trim();
    if (!targetValue) {
      await this.#sendText(chatId, "Review target details were incomplete.");
      return;
    }

    switch (targetKind) {
      case "baseBranch":
        await this.#runReview(chatId, { type: "baseBranch", branch: targetValue });
        return;
      case "commit":
        await this.#runReview(chatId, { type: "commit", sha: targetValue, title: null });
        return;
      case "custom":
        await this.#runReview(chatId, { type: "custom", instructions: targetValue });
        return;
      default:
        await this.#sendText(chatId, "Unsupported review target.");
    }
  }

  async #reconcileActiveTurnState(chatId: number): Promise<void> {
    const state = this.#chatState(chatId);
    if (!state.threadId || !state.activeTurnId) {
      return;
    }

    const nextActiveTurnId = await this.#readResolvedActiveTurnId(state);
    if (nextActiveTurnId === state.activeTurnId) {
      return;
    }

    state.activeTurnId = nextActiveTurnId;
    await this.#saveState();
  }

  async #readResolvedActiveTurnId(state: ChatSessionState): Promise<string | null> {
    const threadId = state.threadId;
    if (!threadId) {
      return null;
    }

    try {
      const response = await this.#codex.call("thread/read", {
        threadId,
        includeTurns: true,
      });
      const thread = response.thread as JsonObject | undefined;
      if ((thread?.status as JsonObject | undefined)?.type === "notLoaded") {
        return null;
      }
      return reconcileActiveTurnIdFromThreadRead(thread, state.activeTurnId);
    } catch (includeTurnsError) {
      try {
        const response = await this.#codex.call("thread/read", {
          threadId,
          includeTurns: false,
        });
        const thread = response.thread as JsonObject | undefined;
        if ((thread?.status as JsonObject | undefined)?.type === "notLoaded") {
          return null;
        }
        return reconcileActiveTurnIdFromThreadRead(thread, state.activeTurnId);
      } catch (statusOnlyError) {
        this.#logRuntimeError("thread/read", includeTurnsError);
        this.#logRuntimeError("thread/read fallback", statusOnlyError);
        return null;
      }
    }
  }

  async #listCollaborationModes(): Promise<unknown[]> {
    const response = await this.#codex.call("collaborationMode/list", {});
    return Array.isArray(response.data) ? response.data : [];
  }

  async #resolveNamedCollaborationMode(name: string): Promise<JsonObject | null> {
    const normalizedName = name.trim().toLowerCase();
    const modes = await this.#listCollaborationModes();
    const match = modes.find((entry) => {
      if (!entry || typeof entry !== "object") {
        return false;
      }
      return asString((entry as JsonObject).name)?.toLowerCase() === normalizedName;
    }) as JsonObject | undefined;
    if (!match) {
      return null;
    }
    return this.#buildCollaborationModeOverride(match);
  }

  async #resolvePlanCollaborationMode(): Promise<JsonObject | null> {
    const modes = await this.#listCollaborationModes();
    const match = modes.find((entry) => {
      if (!entry || typeof entry !== "object") {
        return false;
      }
      const mode = entry as JsonObject;
      return asString(mode.mode) === "plan" || asString(mode.name)?.toLowerCase().includes("plan");
    }) as JsonObject | undefined;
    return match ? this.#buildCollaborationModeOverride(match) : null;
  }

  #buildCollaborationModeOverride(mask: JsonObject): JsonObject {
    const model = asString(mask.model) ?? "gpt-5.4";
    const reasoningEffort = mask.reasoning_effort ?? mask.reasoningEffort ?? null;
    return {
      mode: asString(mask.mode) ?? "default",
      settings: {
        model,
        reasoning_effort: reasoningEffort,
        developer_instructions: null,
      },
    } satisfies JsonObject;
  }

  async #searchWorkspaceFiles(query: string): Promise<string[]> {
    const files = await workspaceFiles(this.#config.workspaceCwd);
    return bestWorkspaceFileMatches(files, query).map((file) =>
      path.isAbsolute(file) ? file : path.join(this.#config.workspaceCwd, file),
    );
  }

  #chatState(chatId: number): ChatSessionState {
    const key = String(chatId);
    if (!this.#state.chats[key]) {
      this.#state.chats[key] = {
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
      };
    }
    return this.#state.chats[key];
  }

  #clearAllChatBindings(options: { releaseOwnership?: boolean } = {}): void {
    for (const state of Object.values(this.#state.chats)) {
      this.#resetChatSessionState(state, options);
    }
  }

  #resetChatSessionState(
    state: ChatSessionState,
    options: { releaseOwnership?: boolean } = {},
  ): void {
    const threadId = options.releaseOwnership ?? true ? state.threadId : null;
    if (threadId) {
      this.#sessionOwnership?.release(this.#botId, threadId);
    }
    state.threadId = null;
    state.freshThread = false;
    state.activeTurnId = null;
    state.turnControlTurnId = null;
    state.turnControlMessageId = null;
    state.queueNextArmed = false;
    state.queuedTurnInput = null;
    state.pendingTurnInput = null;
    state.pendingMention = null;
    state.lastAssistantMessage = null;
  }

  #findChatIdByThread(threadId: string): number | null {
    for (const [chatId, state] of Object.entries(this.#state.chats)) {
      if (state.threadId === threadId) {
        return Number(chatId);
      }
    }
    return null;
  }

  async #saveState(): Promise<void> {
    await saveState(this.#statePath, this.#state);
  }

  #printStartupHelp(): void {
    console.log(`Codex Anywhere bot ${this.#botLabel} running for workspace: ${this.#config.workspaceCwd}`);
    if (this.#config.ownerUserId === null) {
      console.log("Pairing mode: open your bot in Telegram and send /start from your account.");
      return;
    }
    console.log(`Paired owner user id: ${this.#config.ownerUserId}`);
  }

  #logRuntimeError(source: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[codex-anywhere:${this.#botId}] ${source} error: ${message}`);
  }

  async #persistConfig(): Promise<void> {
    await this.#persistConfigFn(this.#config);
  }

  #replaceThreadOwnership(previousThreadId: string | null, nextThreadId: string | null): void {
    if (nextThreadId && nextThreadId !== previousThreadId) {
      this.#claimThreadOwnership(nextThreadId);
    }
    if (previousThreadId && previousThreadId !== nextThreadId) {
      this.#releaseThreadOwnership(previousThreadId);
    }
  }

  #claimThreadOwnership(threadId: string | null): void {
    if (!threadId) {
      return;
    }
    const result = this.#sessionOwnership?.claim(this.#botId, threadId);
    if (result && !result.ok) {
      throw new SessionOwnershipConflictError(threadId, result.ownerBotId);
    }
  }

  #releaseThreadOwnership(threadId: string | null): void {
    if (!threadId) {
      return;
    }
    this.#sessionOwnership?.release(this.#botId, threadId);
  }

  #formatSessionOwnershipConflict(threadId: string, ownerBotId: string): string {
    return [
      `Session ${threadId} is already owned by Telegram bot ${ownerBotId}.`,
      "Finish or release it there before taking it over here.",
    ].join("\n");
  }

  async #reconcilePersistedThreads(): Promise<void> {
    let changed = false;
    for (const [chatId, state] of Object.entries(this.#state.chats)) {
      const threadId = state.threadId;
      if (!threadId) {
        continue;
      }

      let thread: JsonObject | undefined;
      try {
        const response = await this.#codex.call("thread/read", {
          threadId,
          includeTurns: false,
        });
        thread = response.thread as JsonObject | undefined;
      } catch {
        thread = undefined;
      }

      const threadWorkspace = asString(thread?.cwd);
      if (!thread || (threadWorkspace && threadWorkspace !== this.#config.workspaceCwd)) {
        this.#resetChatSessionState(state, { releaseOwnership: false });
        changed = true;
        console.log(
          `[codex-anywhere:${this.#botId}] dropped stale persisted thread ${threadId} for chat ${chatId}`,
        );
        continue;
      }

      this.#claimThreadOwnership(threadId);
      const threadStatus = thread?.status as JsonObject | undefined;
      const reconciledActiveTurnId = threadStatus?.type === "notLoaded"
        ? null
        : reconcileActiveTurnIdFromThreadRead(
          thread,
          state.activeTurnId,
        );
      if (state.activeTurnId !== reconciledActiveTurnId) {
        state.activeTurnId = reconciledActiveTurnId;
        changed = true;
      }
      if (state.freshThread) {
        state.freshThread = false;
        changed = true;
      }
    }

    if (changed) {
      await this.#saveState();
    }
  }
}

class SessionOwnershipConflictError extends Error {
  readonly threadId: string;
  readonly ownerBotId: string;

  constructor(threadId: string, ownerBotId: string) {
    super(`Session ${threadId} is already owned by bot ${ownerBotId}.`);
    this.threadId = threadId;
    this.ownerBotId = ownerBotId;
  }
}

function clampTelegramText(text: string): string {
  if (text.length <= 3900) return text;
  return "…\n\n" + text.slice(-(3900 - 3));
}

function formatRecentTurnsPreview(thread: JsonObject | undefined, limit: number): string | null {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const recent = turns
    .filter((turn): turn is JsonObject => typeof turn === "object" && turn !== null && !Array.isArray(turn))
    .slice(-limit);
  if (recent.length === 0) {
    return null;
  }

  const lines = ["<b>Recent History</b>"];
  for (const turn of recent) {
    const userText = extractTurnUserText(turn);
    const assistantText = extractTurnAssistantText(turn);
    lines.push(`• <b>User:</b> ${escapeTelegramHtml(truncatePreview(userText ?? "(no user text)"))}`);
    lines.push(`  <b>Assistant:</b> ${escapeTelegramHtml(truncatePreview(assistantText ?? "(no assistant text)"))}`);
  }
  return lines.join("\n");
}

function extractTurnUserText(turn: JsonObject): string | null {
  const items = Array.isArray(turn.items) ? turn.items : [];
  for (const item of items) {
    if (!item || typeof item !== "object" || (item as JsonObject).type !== "userMessage") {
      continue;
    }
    const content = Array.isArray((item as JsonObject).content) ? (item as JsonObject).content as JsonObject[] : [];
    const texts = content
      .map((entry) => asString(entry.text))
      .filter((value): value is string => Boolean(value));
    if (texts.length > 0) {
      return texts.join(" ");
    }
  }
  return null;
}

function extractTurnAssistantText(turn: JsonObject): string | null {
  const items = Array.isArray(turn.items) ? turn.items : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item || typeof item !== "object") {
      continue;
    }
    if ((item as JsonObject).type === "agentMessage") {
      const text = asString((item as JsonObject).text);
      if (text) {
        return text;
      }
    }
  }
  return null;
}

function truncatePreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 160 ? `${normalized.slice(0, 160)}…` : normalized;
}

function resolveWorkspacePath(input: string, currentWorkspace: string, homeDir: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return currentWorkspace;
  }
  if (trimmed === "~") {
    return homeDir;
  }
  if (trimmed.startsWith("~/")) {
    return path.join(homeDir, trimmed.slice(2));
  }
  return path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(currentWorkspace, trimmed);
}

function parseExplicitOmxTeamInvocation(text: string): string | null {
  const match = /^\$team(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) {
    return null;
  }
  const suffix = (match[1] ?? "").trim();
  return suffix ? `team ${suffix}` : "team --help";
}

function truncateOmxOutput(text: string): string {
  const normalized = text.trim();
  if (!normalized) {
    return "(no output)";
  }
  return normalized.length > 3200 ? `${normalized.slice(0, 3200)}\n…` : normalized;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isMissingExecutableError(error: unknown, command: string): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = "code" in error ? (error as { code?: unknown }).code : null;
  if (code === "ENOENT") {
    return true;
  }
  const message =
    error instanceof Error ? error.message : String(error);
  return message.includes(`spawn ${command} ENOENT`);
}

function isMissingRolloutResumeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("no rollout found for thread id");
}

function isSessionIdLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isThreadNotMaterializedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("is not materialized yet");
}

function autoDeclineResult(method: string): JsonObject {
  if (method === "item/permissions/requestApproval") {
    return { permissions: {}, scope: "turn" };
  }
  if (method === "item/tool/requestUserInput") {
    return { answers: {} };
  }
  if (method === "mcpServer/elicitation/request") {
    return { action: "cancel", content: null };
  }
  return { decision: "cancel" };
}

function threadSessionOverrides(config: BotRuntimeConfig, state: ChatSessionState): JsonObject {
  const params: JsonObject = {
    cwd: config.workspaceCwd,
    approvalPolicy: state.approvalPolicy ?? "on-request",
    sandbox: "workspace-write",
  };
  if (state.model) {
    params.model = state.model;
  }
  if (state.personality) {
    params.personality = state.personality;
  }
  if (state.serviceTier) {
    params.serviceTier = state.serviceTier;
  }
  return params;
}

function turnSessionOverrides(config: BotRuntimeConfig, state: ChatSessionState): JsonObject {
  const params: JsonObject = {
    cwd: config.workspaceCwd,
    approvalPolicy: state.approvalPolicy ?? "on-request",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [config.workspaceCwd],
      networkAccess: true,
    },
  };
  if (state.model) {
    params.model = state.model;
  }
  if (state.personality) {
    params.personality = state.personality;
  }
  if (state.collaborationMode) {
    params.collaborationMode = state.collaborationMode;
  }
  if (state.serviceTier) {
    params.serviceTier = state.serviceTier;
  }
  if (state.reasoningEffort) {
    params.effort = state.reasoningEffort;
  }
  return params;
}

function parseReviewTarget(args: string): JsonObject {
  const trimmed = args.trim();
  if (!trimmed) {
    return { type: "uncommittedChanges" };
  }
  const baseMatch = /^base\s+(.+)$/i.exec(trimmed);
  if (baseMatch) {
    return { type: "baseBranch", branch: baseMatch[1]!.trim() };
  }
  const commitMatch = /^commit\s+([^\s]+)$/i.exec(trimmed);
  if (commitMatch) {
    return { type: "commit", sha: commitMatch[1]!.trim(), title: null };
  }
  return { type: "custom", instructions: trimmed };
}

function formatModelSummary(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const model = asString((entry as JsonObject).model);
  if (!model) {
    return null;
  }
  const displayName = asString((entry as JsonObject).displayName) ?? model;
  const isDefault = (entry as JsonObject).isDefault === true ? " default" : "";
  return `- ${model}${isDefault}: ${displayName}`;
}

function formatRateLimitSnapshot(snapshot: JsonObject | undefined): string {
  if (!snapshot) {
    return "unknown";
  }
  const primary =
    snapshot.primary && typeof snapshot.primary === "object"
      ? (snapshot.primary as JsonObject)
      : undefined;
  const usedPercent = primary?.usedPercent;
  const resetsAt = primary?.resetsAt;
  const parts = [];
  if (typeof usedPercent === "number") {
    parts.push(`${Math.max(0, 100 - usedPercent)}% remaining`);
  }
  if (typeof resetsAt === "number") {
    parts.push(`resets at ${new Date(resetsAt * 1000).toISOString()}`);
  }
  return parts.join(", ") || "available";
}

function formatSessionCardHtml(thread: JsonObject, currentThreadId: string | null): string {
  const threadId = asString(thread.id) ?? "<unknown>";
  const isCurrent = currentThreadId === threadId;
  const rawTitle =
    asString(thread.name)
    ?? formatThreadOptionLabel(thread)
    ?? asString(thread.preview)
    ?? threadId;
  const title = rawTitle.length > 60 ? rawTitle.slice(0, 59) + "…" : rawTitle;
  const gitInfo = thread.gitInfo && typeof thread.gitInfo === "object"
    ? (thread.gitInfo as JsonObject)
    : null;
  const branch =
    asString(thread.gitBranch)
    ?? asString(thread.branch)
    ?? asString(gitInfo?.branch)
    ?? null;
  const updatedAt = typeof thread.updatedAt === "number" ? relativeTime(thread.updatedAt) : "";
  const rawStatus = formatThreadStatus(thread.status as JsonObject | undefined);
  const source = formatSourceLabel(asString(thread.source));
  const header = isCurrent
    ? `▶ <b>${escapeTelegramHtml(title)}</b>`
    : `<b>${escapeTelegramHtml(title)}</b>`;
  const lines = [header];
  if (branch) {
    lines.push(`↳ <code>${escapeTelegramHtml(branch)}</code>`);
  }
  lines.push(`<code>${escapeTelegramHtml(threadId)}</code>`);
  const metaParts = [statusBadge(rawStatus), updatedAt, source].filter(Boolean);
  lines.push(metaParts.join("  ·  "));
  return lines.join("\n");
}

function formatSessionStatusHtml(thread: JsonObject, currentThreadId: string | null): string {
  const threadId = asString(thread.id) ?? "<unknown>";
  const preview = asString(thread.preview) ?? "";
  const rolloutPath = asString(thread.path) ?? "";
  return [
    formatSessionCardHtml(thread, currentThreadId),
    `<code>${escapeTelegramHtml(threadId)}</code>`,
    preview ? escapeTelegramHtml(preview) : "",
    rolloutPath ? `Rollout: <code>${escapeTelegramHtml(rolloutPath)}</code>` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatThreadOptionLabel(thread: JsonObject): string | null {
  const nickname = asString(thread.agentNickname);
  const role = asString(thread.agentRole);
  if (nickname && role) {
    return `${nickname} [${role}]`;
  }
  return nickname ?? role ?? null;
}

function formatThreadStatus(status: JsonObject | undefined): string {
  const type = asString(status?.type);
  if (type !== "active") {
    return type ?? "unknown";
  }
  const activeFlags = Array.isArray(status?.activeFlags) ? status.activeFlags.join(", ") : "";
  return activeFlags ? `active (${activeFlags})` : "active";
}

function formatApprovalFeedback(action: "approve" | "session" | "decline" | "cancel"): string {
  switch (action) {
    case "approve": return "✓ Approved.";
    case "session": return "✓ Approved for session.";
    case "decline": return "Declined.";
    case "cancel": return "Cancelled.";
  }
}

function statusBadge(rawStatus: string): string {
  if (rawStatus.startsWith("active")) {
    const working = rawStatus.includes("tool-use");
    return working ? "🔧 working" : "⚡ active";
  }
  switch (rawStatus) {
    case "completed": return "✓ done";
    case "failed": return "✗ failed";
    case "notLoaded": return "💤 idle";
    default: return rawStatus;
  }
}

function formatSourceLabel(source: string | null): string {
  switch (source) {
    case "vscode": return "VS Code";
    case "cli": return "CLI";
    case "appServer": return "App";
    case "subAgent":
    case "subAgentReview":
    case "subAgentCompact":
    case "subAgentThreadSpawn":
    case "subAgentOther":
      return "Agent";
    case "exec": return "Exec";
    default: return source ?? "";
  }
}

function relativeTime(unixSeconds: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (diff < 60) {
    return `${diff}s ago`;
  }
  if (diff < 3600) {
    return `${Math.floor(diff / 60)}m ago`;
  }
  if (diff < 86400) {
    return `${Math.floor(diff / 3600)}h ago`;
  }
  return `${Math.floor(diff / 86400)}d ago`;
}

function hasTelegramImage(message: TelegramMessage): boolean {
  return (
    (Array.isArray(message.photo) && message.photo.length > 0)
    || Boolean(message.document && isImageDocument(message.document))
  );
}

function bestTelegramImageFileId(message: TelegramMessage): string | null {
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    return message.photo[message.photo.length - 1]?.file_id ?? null;
  }
  if (message.document && isImageDocument(message.document)) {
    return message.document.file_id;
  }
  return null;
}

function isImageDocument(document: { mime_type?: string }): boolean {
  return typeof document.mime_type === "string" && document.mime_type.startsWith("image/");
}

function telegramFileExtension(filePath: string, fileName?: string): string {
  const extension = path.extname(filePath || fileName || "");
  return extension || ".jpg";
}

function consumePendingMention(state: ChatSessionState, input: JsonObject[]): JsonObject[] {
  const pendingMention = state.pendingMention;
  if (!pendingMention) {
    return input;
  }
  state.pendingMention = null;

  const name = asString(pendingMention.name) ?? path.basename(asString(pendingMention.path) ?? "file");
  const mentionPath = asString(pendingMention.path) ?? "";
  const items = [...input];
  const firstTextIndex = items.findIndex((entry) => entry.type === "text");
  if (firstTextIndex >= 0) {
    const textItem = items[firstTextIndex] as JsonObject;
    const originalText = asString(textItem.text) ?? "";
    items[firstTextIndex] = {
      ...textItem,
      text: `@${name} ${originalText}`.trim(),
    };
  } else {
    items.unshift({ type: "text", text: `@${name}` });
  }
  items.push({ type: "mention", name, path: mentionPath });
  return items;
}

async function workspaceFiles(
  cwd: string,
): Promise<string[]> {
  const { stdout } = await execFileAsync("rg", ["--files"], {
    cwd,
    maxBuffer: 1024 * 1024 * 8,
  });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function bestWorkspaceFileMatches(files: string[], query: string): string[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }
  const matches = files.filter((file) => file.toLowerCase().includes(normalizedQuery));
  matches.sort((left, right) => {
    const leftBase = path.basename(left).toLowerCase();
    const rightBase = path.basename(right).toLowerCase();
    const leftStarts = leftBase.startsWith(normalizedQuery) ? 0 : 1;
    const rightStarts = rightBase.startsWith(normalizedQuery) ? 0 : 1;
    if (leftStarts !== rightStarts) {
      return leftStarts - rightStarts;
    }
    return left.length - right.length;
  });
  return matches.slice(0, 12);
}

function telegramCommands(): TelegramBotCommand[] {
  return [
    { command: "help", description: "show bot and Codex slash commands" },
    { command: "status", description: "show current thread and model settings" },
    { command: "new", description: "start a fresh Codex thread" },
    { command: "resume", description: "browse and continue sessions in this workspace" },
    { command: "continue", description: "browse all sessions or continue by exact id" },
    { command: "interrupt", description: "interrupt the active turn" },
    { command: "esc", description: "interrupt the active turn" },
    { command: "cancel", description: "cancel the active interactive prompt" },
    { command: "sh", description: "run an explicit shell command" },
    { command: "workspace", description: "show or change the bot workspace" },
    { command: "addbot", description: "add and start another Telegram bot" },
    { command: "omx", description: "run supported oh-my-codex CLI commands" },
    { command: "model", description: "show or set the active model" },
    { command: "personality", description: "set Codex personality" },
    { command: "fast", description: "toggle Fast mode" },
    { command: "plan", description: "switch to Plan mode" },
    { command: "collab", description: "change collaboration mode" },
    { command: "agent", description: "switch active agent thread" },
    { command: "permissions", description: "set the approval policy" },
    { command: "review", description: "start a code review" },
    { command: "rename", description: "rename the current thread" },
    { command: "fork", description: "fork the current thread" },
    { command: "compact", description: "compact the current thread" },
    { command: "clear", description: "start a new blank thread" },
    { command: "verbose", description: "toggle detailed tool output" },
    { command: "diff", description: "show the current git diff" },
    { command: "copy", description: "repeat the last assistant output" },
    { command: "mention", description: "attach a file to your next message" },
    { command: "skills", description: "list available skills" },
    { command: "mcp", description: "list MCP servers" },
    { command: "apps", description: "list apps and connectors" },
    { command: "plugins", description: "list installed plugins" },
    { command: "feedback", description: "send feedback" },
    { command: "experimental", description: "show or toggle experimental features" },
    { command: "rollout", description: "show current rollout path" },
    { command: "logout", description: "log out of Codex" },
    { command: "quit", description: "log out of Codex" },
    { command: "stop", description: "stop background terminals" },
  ];
}

function buildToolInteractiveStep(
  question: JsonObject,
  index: number,
): PendingInteractiveSessionStep | null {
  const id = asString(question.id) ?? `question_${index + 1}`;
  const header = asString(question.header);
  const questionText = asString(question.question);
  const prompt = [header, questionText].filter(Boolean).join("\n");
  const options = Array.isArray(question.options)
    ? question.options
        .map((option) => {
          if (!option || typeof option !== "object") {
            return null;
          }
          const entry = option as JsonObject;
          const label = asString(entry.label);
          return label ? { label, value: label } : null;
        })
        .filter((entry): entry is { label: string; value: string } => Boolean(entry))
    : [];

  return {
    key: id,
    prompt: prompt || `Question ${index + 1}`,
    kind: options.length > 0 ? "choice" : "text",
    options: options.length > 0 ? options : undefined,
    required: true,
  };
}

function buildMcpInteractiveSession(
  params: JsonObject,
): { title: string; steps: PendingInteractiveSessionStep[]; meta: JsonObject | null } | null {
  const mode = asString(params.mode);
  const message = asString(params.message) ?? "An MCP server needs your input.";
  const meta =
    params._meta && typeof params._meta === "object" ? (params._meta as JsonObject) : null;

  if (mode === "url") {
    const url = asString(params.url);
    if (!url) {
      return null;
    }
    return {
      title: message,
      meta,
      steps: [
        {
          key: "__url_ack__",
          prompt: message,
          kind: "url",
          options: [{ label: "Open link", value: url }],
          required: true,
        },
      ],
    };
  }

  if (mode !== "form") {
    return null;
  }

  const schema =
    params.requestedSchema && typeof params.requestedSchema === "object"
      ? (params.requestedSchema as JsonObject)
      : null;
  if (!schema) {
    return null;
  }

  const properties =
    schema.properties && typeof schema.properties === "object"
      ? (schema.properties as Record<string, unknown>)
      : {};
  const required = Array.isArray(schema.required) ? new Set(schema.required.map(String)) : new Set<string>();
  const steps: PendingInteractiveSessionStep[] = [];

  for (const [key, rawValue] of Object.entries(properties)) {
    if (!rawValue || typeof rawValue !== "object") {
      continue;
    }
    const value = rawValue as JsonObject;
    const prompt = [asString(value.title), asString(value.description)].filter(Boolean).join("\n") || key;
    const type = asString(value.type);
    const enumOptions = extractEnumOptions(value);

    if (enumOptions.length > 0) {
      steps.push({
        key,
        prompt,
        kind: "choice",
        options: enumOptions,
        required: required.has(key),
      });
      continue;
    }

    if (type === "boolean") {
      steps.push({
        key,
        prompt,
        kind: "boolean",
        required: required.has(key),
      });
      continue;
    }

    if (type === "number" || type === "integer") {
      steps.push({
        key,
        prompt,
        kind: "number",
        required: required.has(key),
      });
      continue;
    }

    if (type === "string") {
      steps.push({
        key,
        prompt,
        kind: "text",
        required: required.has(key),
      });
      continue;
    }

    return null;
  }

  if (steps.length === 0) {
    return null;
  }

  return {
    title: message,
    steps,
    meta,
  };
}

function extractEnumOptions(value: JsonObject): Array<{ label: string; value: string }> {
  const directEnum = Array.isArray(value.enum) ? value.enum : null;
  if (directEnum) {
    return directEnum
      .map((entry) => (typeof entry === "string" ? { label: entry, value: entry } : null))
      .filter((entry): entry is { label: string; value: string } => Boolean(entry));
  }

  const oneOf = Array.isArray(value.oneOf) ? value.oneOf : null;
  if (oneOf) {
    return oneOf
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        const option = entry as JsonObject;
        const optionValue = asString(option.const);
        const optionLabel = asString(option.title) ?? optionValue;
        return optionValue && optionLabel ? { label: optionLabel, value: optionValue } : null;
      })
      .filter((entry): entry is { label: string; value: string } => Boolean(entry));
  }

  return [];
}
