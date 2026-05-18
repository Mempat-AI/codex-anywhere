import fs from "node:fs/promises";
import path from "node:path";

import type { TelegramParseMode } from "./telegramFormatting.js";
import type { JsonObject, TelegramBotCommand, TelegramUpdate } from "./types.js";

export class TelegramBotApi {
  readonly #baseUrl: string;

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
      await this.#request("editMessageText", payload);
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

  async #request(method: string, payload: JsonObject): Promise<unknown> {
    const response = await fetch(`${this.#baseUrl}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const body = (await response.json()) as {
      ok: boolean;
      description?: string;
      result?: unknown;
    };
    if (!response.ok || !body.ok) {
      throw new Error(body.description ?? `Telegram request failed for ${method}`);
    }
    return body.result;
  }

  async #uploadFile(
    method: "sendDocument" | "sendPhoto",
    chatId: number,
    fieldName: "document" | "photo",
    filePath: string,
    caption?: string,
  ): Promise<unknown> {
    const bytes = await fs.readFile(filePath);
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
    const body = (await response.json()) as {
      ok: boolean;
      description?: string;
      result?: unknown;
    };
    if (!response.ok || !body.ok) {
      throw new Error(body.description ?? `Telegram request failed for ${method}`);
    }
    return body.result;
  }
}
