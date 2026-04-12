export type JsonObject = Record<string, unknown>;

export type ApprovalAction = "approve" | "session" | "decline" | "cancel";

export interface TelegramBotCommand {
  command: string;
  description: string;
}

export interface StoredSingleBotConfig {
  version: 1;
  telegramBotToken: string;
  workspaceCwd: string;
  ownerUserId: number | null;
  pollTimeoutSeconds: number;
  streamEditIntervalMs: number;
}

export interface StoredBotDefinition {
  id: string;
  label?: string | null;
  telegramBotToken: string;
  workspaceCwd: string;
  ownerUserId: number | null;
  pollTimeoutSeconds: number;
  streamEditIntervalMs: number;
}

export interface StoredMultiBotConfig {
  version: 2;
  bots: StoredBotDefinition[];
}

export type StoredConfig = StoredSingleBotConfig | StoredMultiBotConfig;

export interface BotRuntimeConfig {
  id: string;
  label: string;
  telegramBotToken: string;
  workspaceCwd: string;
  ownerUserId: number | null;
  pollTimeoutSeconds: number;
  streamEditIntervalMs: number;
}

export interface ChatSessionState {
  threadId: string | null;
  freshThread: boolean;
  activeTurnId: string | null;
  turnControlTurnId: string | null;
  turnControlMessageId: number | null;
  verbose: boolean;
  queueNextArmed: boolean;
  queuedTurnInput: JsonObject[] | null;
  pendingTurnInput: JsonObject[] | null;
  pendingMention: JsonObject | null;
  model: string | null;
  reasoningEffort: string | null;
  personality: string | null;
  collaborationModeName: string | null;
  collaborationMode: JsonObject | null;
  serviceTier: string | null;
  approvalPolicy: string | null;
  lastAssistantMessage: string | null;
}

export interface StoredState {
  version: 1;
  lastUpdateId: number | null;
  chats: Record<string, ChatSessionState>;
}

export interface StoragePaths {
  configPath: string;
  statePath: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number };
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
}

export interface TelegramPhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramCallbackQuery {
  id: string;
  from?: { id: number };
  data?: string;
  message?: TelegramMessage;
}

export interface PendingApproval {
  requestId: string | number;
  chatId: number;
  method: string;
  params: JsonObject;
}

export type PendingInteractiveSessionKind = "tool" | "mcp" | "local";

export interface PendingInteractiveSessionStep {
  key: string;
  prompt: string;
  kind: "choice" | "text" | "number" | "boolean" | "url";
  options?: Array<{ label: string; value: string }>;
  required?: boolean;
}

export interface PendingInteractiveSession {
  requestId: string | number | null;
  chatId: number;
  kind: PendingInteractiveSessionKind;
  token: string;
  title: string;
  steps: PendingInteractiveSessionStep[];
  currentStepIndex: number;
  answers: Record<string, unknown>;
  meta?: JsonObject | null;
}

export interface StreamBuffer {
  threadId: string;
  turnId: string;
  streamId: string;
  chatId: number;
  text: string;
  messageId: number | null;
  lastFlushAt: number;
  phase: string | null;
}
