import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

import type { BotRuntimeConfig, StoredConfig } from "./types.js";

export async function runSetupWizard(defaultWorkspaceCwd: string): Promise<StoredConfig> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log("Welcome to Codex Anywhere.");
    console.log("This one-time setup asks only for your Telegram bot token and workspace path.\n");

    const telegramBotToken = await promptForRequired(rl, "Telegram bot token (from BotFather): ");
    const workspacePrompt = `Workspace path for Codex tasks [${defaultWorkspaceCwd}]: `;
    const workspaceInput = (await rl.question(workspacePrompt)).trim();
    const workspaceCwd = path.resolve(workspaceInput || defaultWorkspaceCwd);

    if (!fs.existsSync(workspaceCwd)) {
      throw new Error(`Workspace path does not exist: ${workspaceCwd}`);
    }

    return {
      version: 2,
      bots: [
        {
          id: "default",
          label: "default",
          telegramBotToken,
          workspaceCwd,
          ownerUserId: null,
          pollTimeoutSeconds: 20,
          streamEditIntervalMs: 1500,
        },
      ],
    };
  } finally {
    rl.close();
  }
}

export async function runAddBotWizard(
  defaultWorkspaceCwd: string,
  defaults: Partial<BotRuntimeConfig> = {},
): Promise<BotRuntimeConfig> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log("Add a Telegram bot to Codex Anywhere.");
    console.log("This appends one bot definition to the shared supervisor config.\n");

    const defaultBotId = defaults.id ?? "bot-2";
    const botId = await promptForDefault(rl, `Bot id [${defaultBotId}]: `, defaultBotId);
    const labelInput = (await rl.question(`Bot label [${defaults.label ?? botId}]: `)).trim();
    const telegramBotToken = await promptForRequired(rl, "Telegram bot token (from BotFather): ");
    const workspacePrompt = `Workspace path for this bot [${defaultWorkspaceCwd}]: `;
    const workspaceInput = (await rl.question(workspacePrompt)).trim();
    const workspaceCwd = path.resolve(workspaceInput || defaultWorkspaceCwd);

    if (!fs.existsSync(workspaceCwd)) {
      throw new Error(`Workspace path does not exist: ${workspaceCwd}`);
    }

    return {
      id: botId,
      label: labelInput || defaults.label || botId,
      telegramBotToken,
      workspaceCwd,
      ownerUserId: defaults.ownerUserId ?? null,
      pollTimeoutSeconds: defaults.pollTimeoutSeconds ?? 20,
      streamEditIntervalMs: defaults.streamEditIntervalMs ?? 1500,
    };
  } finally {
    rl.close();
  }
}

async function promptForRequired(
  rl: readline.Interface,
  question: string,
): Promise<string> {
  while (true) {
    const answer = (await rl.question(question)).trim();
    if (answer.length > 0) {
      return answer;
    }
    console.log("This field is required.");
  }
}

async function promptForDefault(
  rl: readline.Interface,
  question: string,
  fallback: string,
): Promise<string> {
  const answer = (await rl.question(question)).trim();
  return answer || fallback;
}
