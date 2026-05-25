import fs from "node:fs/promises";
import path from "node:path";

import type { StoredConfig, StoredState } from "./types.js";

const DEFAULT_STATE: StoredState = {
  version: 1,
  lastUpdateId: null,
  pendingUpgradeNotification: null,
  chats: {},
};

export async function loadConfig(configPath: string): Promise<StoredConfig | null> {
  return readJsonFile<StoredConfig>(configPath);
}

export async function saveConfig(configPath: string, config: StoredConfig): Promise<void> {
  await writeJsonFile(configPath, config);
}

export async function loadState(statePath: string): Promise<StoredState> {
  const state = (await readJsonFile<StoredState>(statePath)) ?? structuredClone(DEFAULT_STATE);
  state.pendingUpgradeNotification ??= null;
  for (const chat of Object.values(state.chats)) {
    chat.freshThread ??= false;
    chat.turnControlTurnId ??= null;
    chat.turnControlMessageId ??= null;
    chat.verbose ??= false;
    chat.queueNextArmed ??= false;
    chat.queuedTurnInput ??= null;
    chat.queuedTurnOriginMessageId ??= null;
    chat.pendingTurnInput ??= null;
    chat.pendingTurnOriginMessageId ??= null;
    chat.pendingMention ??= null;
    chat.model ??= null;
    chat.reasoningEffort ??= null;
    chat.personality ??= null;
    chat.collaborationModeName ??= null;
    chat.collaborationMode ??= null;
    chat.serviceTier ??= null;
    chat.approvalPolicy ??= null;
    chat.sandboxMode ??= null;
    chat.lastAssistantMessage ??= null;
  }
  if (state.pendingUpgradeNotification) {
    state.pendingUpgradeNotification.attemptId ??= null;
    state.pendingUpgradeNotification.diagnosticJournalPath ??= null;
    state.pendingUpgradeNotification.diagnosticStatePath ??= null;
    state.pendingUpgradeNotification.watchdogMarkerPath ??= null;
  }
  return state;
}

export async function saveState(statePath: string, state: StoredState): Promise<void> {
  await writeJsonFile(statePath, state);
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const contents = await fs.readFile(filePath, "utf8");
    return JSON.parse(contents) as T;
  } catch (error) {
    if (isFileMissing(error)) {
      return null;
    }
    throw error;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (process.platform !== "win32") {
    await fs.chmod(filePath, 0o600);
  }
}

function isFileMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
