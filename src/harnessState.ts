import { normalizeConfig } from "./configModel.js";
import path from "node:path";

import { getStoragePaths } from "./paths.js";
import { loadConfig, loadState } from "./persistence.js";
import type { StoragePaths } from "./types.js";

export interface LaunchRestoreStatus {
  workspaceCwd: string;
  configPath: string;
  statePath: string;
  configuredWorkspaceCwd: string | null;
  sameWorkspace: boolean;
  restoredChatId: string | null;
  restoredThreadId: string | null;
  activeTurnId: string | null;
  canRestore: boolean;
  summary: string;
}

export async function readLaunchRestoreStatus(
  workspaceCwd: string,
  storagePaths: StoragePaths = getStoragePaths(),
): Promise<LaunchRestoreStatus> {
  const normalizedWorkspace = path.resolve(workspaceCwd);
  const config = await loadConfig(storagePaths.configPath);
  const configuredWorkspaceCwd = config
    ? normalizeConfig(config)
      .map((bot) => path.resolve(bot.workspaceCwd))
      .find((candidate) => candidate === normalizedWorkspace) ?? null
    : null;
  const sameWorkspace = configuredWorkspaceCwd === normalizedWorkspace;

  if (!config || !sameWorkspace) {
    return {
      workspaceCwd: normalizedWorkspace,
      configPath: storagePaths.configPath,
      statePath: storagePaths.statePath,
      configuredWorkspaceCwd,
      sameWorkspace,
      restoredChatId: null,
      restoredThreadId: null,
      activeTurnId: null,
      canRestore: false,
      summary: !config
        ? "No Codex Anywhere config exists yet for this storage root."
        : "Configured workspace does not match the current workspace; nothing to restore.",
    };
  }

  const state = await loadState(storagePaths.statePath);
  for (const [chatId, chatState] of Object.entries(state.chats)) {
    if (chatState.threadId) {
      return {
        workspaceCwd: normalizedWorkspace,
        configPath: storagePaths.configPath,
        statePath: storagePaths.statePath,
        configuredWorkspaceCwd,
        sameWorkspace,
        restoredChatId: chatId,
        restoredThreadId: chatState.threadId,
        activeTurnId: chatState.activeTurnId,
        canRestore: true,
        summary:
          "Workspace matches the configured Codex Anywhere root and persisted chat/thread state is available to restore.",
      };
    }
  }

  return {
    workspaceCwd: normalizedWorkspace,
    configPath: storagePaths.configPath,
    statePath: storagePaths.statePath,
    configuredWorkspaceCwd,
    sameWorkspace,
    restoredChatId: null,
    restoredThreadId: null,
    activeTurnId: null,
    canRestore: false,
    summary:
      "Workspace matches the configured Codex Anywhere root, but there is no persisted chat/thread state to restore.",
  };
}
