import { spawnSync } from "node:child_process";

import { normalizeConfig } from "./configModel.js";
import { TelegramBotApi } from "./telegram.js";
import type { StoredConfig } from "./types.js";

export async function runPreflightChecks(config: StoredConfig): Promise<void> {
  assertCodexAvailable();
  for (const bot of normalizeConfig(config)) {
    await assertTelegramTokenWorks(bot.telegramBotToken);
  }
}

function assertCodexAvailable(): void {
  const result = spawnSync("codex", ["--help"], {
    stdio: "ignore",
  });
  if (result.error) {
    throw new Error(
      "`codex` was not found on PATH. Install/authenticate Codex first, then run `pnpm run connect` again.",
    );
  }
}

async function assertTelegramTokenWorks(token: string): Promise<void> {
  const api = new TelegramBotApi(token);
  try {
    await api.getMe();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Telegram bot token check failed: ${message}`);
  }
}
