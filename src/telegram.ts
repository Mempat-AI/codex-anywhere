import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { TelegramParseMode } from "./telegramFormatting.js";
import type { JsonObject, TelegramBotCommand, TelegramUpdate } from "./types.js";

const TELEGRAM_RATE_LIMIT_RETRIES = 1;

export class TelegramApiError extends Error {
  readonly retryAfterSeconds: number | null;

  constructor(message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "TelegramApiError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface TelegramRequestOptions {
  retry?: boolean;
}

export class TelegramBotApi {
  readonly #baseUrl: string;
  #retryAfterUntil = 0;

  constructor(token: string) {
    this.#baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async getMe(): Promise<Record<string, unknown>> {
    return (await this.#request("getMe", {})) as Record<string, unknown>;
  }

  async setMyCommands(commands: TelegramBotCommand[]): Promise<void> {
    await this.#request("setMyCommands", { commands });
  }

  async getUpdates(offset: number | null, timeoutSeconds: number): Promise<TelegramUpdate[]> {
    const payload: JsonObject = {
      timeout: timeoutSeconds,
      allowed_updates: ["message", "callback_query"],
    };
    if (offset !== null) {
      payload.offset = offset;
    }
    return (await this.#request("getUpdates", payload)) as TelegramUpdate[];
  }

  async getFile(fileId: string): Promise<{ file_path: string }> {
    return (await this.#request("getFile", {
      file_id: fileId,
    })) as { file_path: string };
  }

  async downloadFile(filePath: string): Promise<Buffer> {
    const response = await fetch(`${this.#baseUrl.replace("/bot", "/file/bot")}/${filePath}`);
    if (!response.ok) {
      throw new Error(`Telegram file download failed: ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async sendChatAction(chatId: number, action: "typing"): Promise<void> {
    await this.#request("sendChatAction", {
      chat_id: chatId,
      action,
    });
  }

  async sendMessage(
    chatId: number,
    text: string,
    replyMarkup?: JsonObject,
    parseMode?: TelegramParseMode,
    replyToMessageId?: number | null,
  ): Promise<{ message_id: number }> {
    const payload: JsonObject = {
      chat_id: chatId,
      text,
    };
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }
    if (parseMode) {
      payload.parse_mode = parseMode;
    }
    if (replyToMessageId !== null && replyToMessageId !== undefined) {
      payload.reply_parameters = {
        message_id: replyToMessageId,
      };
    }
    return (await this.#request("sendMessage", payload)) as { message_id: number };
  }

  async sendDocument(chatId: number, filePath: string, caption?: string): Promise<{ message_id: number }> {
    return (await this.#uploadFile("sendDocument", chatId, "document", filePath, caption)) as {
      message_id: number;
    };
  }

  async sendPhoto(chatId: number, filePath: string, caption?: string): Promise<{ message_id: number }> {
    return (await this.#uploadFile("sendPhoto", chatId, "photo", filePath, caption)) as {
      message_id: number;
    };
  }

  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    replyMarkup?: JsonObject,
    parseMode?: TelegramParseMode,
    options?: TelegramRequestOptions,
  ): Promise<void> {
    const payload: JsonObject = {
      chat_id: chatId,
      message_id: messageId,
      text,
    };
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }
    if (parseMode) {
      payload.parse_mode = parseMode;
    }
    try {
      await this.#request("editMessageText", payload, options);
    } catch (error) {
      if (error instanceof Error && error.message.includes("message is not modified")) {
        return;
      }
      throw error;
    }
  }

  async answerCallbackQuery(callbackQueryId: string, text: string): Promise<void> {
    await this.#request("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
      show_alert: false,
    });
  }

  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    await this.#request("deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    });
  }

  async #request(method: string, payload: JsonObject, options?: TelegramRequestOptions): Promise<unknown> {
    return this.#withRetry(method, async () => {
      const response = await fetch(`${this.#baseUrl}/${method}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      return readTelegramApiResponse(response, method);
    }, options);
  }

  async #uploadFile(
    method: "sendDocument" | "sendPhoto",
    chatId: number,
    fieldName: "document" | "photo",
    filePath: string,
    caption?: string,
  ): Promise<unknown> {
    const bytes = await fs.readFile(filePath);
    return this.#withRetry(method, async () => {
      const form = new FormData();
      form.append("chat_id", String(chatId));
      if (caption) {
        form.append("caption", caption);
      }
      form.append(fieldName, new Blob([bytes]), path.basename(filePath));

      const response = await fetch(`${this.#baseUrl}/${method}`, {
        method: "POST",
        body: form,
      });
      return readTelegramApiResponse(response, method);
    });
  }

  async #withRetry(
    method: string,
    send: () => Promise<unknown>,
    options?: TelegramRequestOptions,
  ): Promise<unknown> {
    const shouldRetry = options?.retry ?? true;
    for (let attempt = 0; ; attempt += 1) {
      const gateDelayMs = this.#retryAfterUntil - Date.now();
      if (gateDelayMs > 0) {
        if (!shouldRetry) {
          throw new TelegramApiError(
            `Too Many Requests: retry after ${Math.ceil(gateDelayMs / 1000)}`,
            Math.ceil(gateDelayMs / 1000),
          );
        }
        await sleep(gateDelayMs);
      }
      try {
        return await send();
      } catch (error) {
        const retryAfterMs = telegramRetryAfterMs(error);
        if (retryAfterMs === null || !shouldRetry || attempt >= TELEGRAM_RATE_LIMIT_RETRIES) {
          throw error;
        }
        this.#retryAfterUntil = Math.max(this.#retryAfterUntil, Date.now() + retryAfterMs);
        await sleep(retryAfterMs);
      }
    }
  }
}

async function readTelegramApiResponse(response: Response, method: string): Promise<unknown> {
  const body = (await response.json()) as {
    ok: boolean;
    description?: string;
    result?: unknown;
    parameters?: {
      retry_after?: number;
    };
  };
  if (!response.ok || !body.ok) {
    throw new TelegramApiError(
      body.description ?? `Telegram request failed for ${method}`,
      telegramRetryAfterSeconds(body),
    );
  }
  return body.result;
}

function telegramRetryAfterSeconds(body: {
  description?: string;
  parameters?: { retry_after?: number };
}): number | null {
  const structured = body.parameters?.retry_after;
  if (typeof structured === "number" && Number.isFinite(structured) && structured > 0) {
    return structured;
  }
  const match = /\bretry after\s+(\d+(?:\.\d+)?)\b/i.exec(body.description ?? "");
  if (!match) {
    return null;
  }
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function telegramRetryAfterMs(error: unknown): number | null {
  const retryAfterSeconds = (error as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds;
  if (typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.ceil(retryAfterSeconds * 1000);
  }
  if (!(error instanceof Error)) {
    return null;
  }
  const match = /\bretry after\s+(\d+(?:\.\d+)?)\b/i.exec(error.message);
  if (!match) {
    return null;
  }
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : null;
}
