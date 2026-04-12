import fs from "node:fs/promises";
import process from "node:process";

import { addBotToConfig, isMultiBotConfig, normalizeConfig } from "./configModel.js";
import { runSetupWizard } from "./onboarding.js";
import { getStoragePaths } from "./paths.js";
import { loadConfig, saveConfig } from "./persistence.js";
import { runPreflightChecks } from "./preflight.js";
import type { BotRuntimeConfig, StoredConfig, StoragePaths } from "./types.js";

export interface PrepareCodexAnywhereConfigOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  storagePaths?: StoragePaths;
  loadConfig?: (configPath: string) => Promise<StoredConfig | null>;
  saveConfig?: (configPath: string, config: StoredConfig) => Promise<void>;
  runSetupWizard?: (defaultWorkspaceCwd: string) => Promise<StoredConfig>;
  runPreflightChecks?: (config: StoredConfig) => Promise<void>;
  log?: (message: string) => void;
  allowSetupWizard?: boolean;
}

export interface PreparedCodexAnywhereConfig {
  config: StoredConfig;
  storagePaths: StoragePaths;
}

export interface AddBotToCodexAnywhereConfigOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  storagePaths?: StoragePaths;
  loadConfig?: (configPath: string) => Promise<StoredConfig | null>;
  saveConfig?: (configPath: string, config: StoredConfig) => Promise<void>;
  runAddBotWizard?: (
    defaultWorkspaceCwd: string,
    defaults?: Partial<BotRuntimeConfig>,
  ) => Promise<BotRuntimeConfig>;
  runPreflightChecks?: (config: StoredConfig) => Promise<void>;
  log?: (message: string) => void;
}

export async function prepareCodexAnywhereConfig(
  options: PrepareCodexAnywhereConfigOptions = {},
): Promise<PreparedCodexAnywhereConfig> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const storagePaths = options.storagePaths ?? getStoragePaths(env);
  const loadConfigFn = options.loadConfig ?? loadConfig;
  const saveConfigFn = options.saveConfig ?? saveConfig;
  const runSetupWizardFn = options.runSetupWizard ?? runSetupWizard;
  const runPreflightChecksFn = options.runPreflightChecks ?? runPreflightChecks;
  const log = options.log ?? console.log;
  const allowSetupWizard = options.allowSetupWizard ?? true;

  let config = await loadConfigFn(storagePaths.configPath);
  if (config && !isMultiBotConfig(config)) {
    if (!allowSetupWizard) {
      throw new Error("Existing Codex Anywhere config uses an older protocol and is no longer supported. Run `codex-anywhere connect` to reset setup.");
    }
    log("Existing Codex Anywhere config uses an older protocol and is no longer supported. Running setup again.");
    await fs.rm(storagePaths.configPath, { force: true });
    config = null;
  }
  if (!config) {
    if (!allowSetupWizard) {
      throw new Error("Codex Anywhere is not configured yet. Run `codex-anywhere connect` first.");
    }
    config = await runSetupWizardFn(cwd);
    await saveConfigFn(storagePaths.configPath, config);
    log(`Saved config to ${storagePaths.configPath}`);
  }

  await runPreflightChecksFn(config);
  return {
    config,
    storagePaths,
  };
}

export async function addBotToCodexAnywhereConfig(
  options: AddBotToCodexAnywhereConfigOptions = {},
): Promise<{ config: StoredConfig; storagePaths: StoragePaths; bot: BotRuntimeConfig }> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const storagePaths = options.storagePaths ?? getStoragePaths(env);
  const loadConfigFn = options.loadConfig ?? loadConfig;
  const saveConfigFn = options.saveConfig ?? saveConfig;
  const runAddBotWizardFn = options.runAddBotWizard;
  const runPreflightChecksFn = options.runPreflightChecks ?? runPreflightChecks;
  const log = options.log ?? console.log;

  if (!runAddBotWizardFn) {
    throw new Error("runAddBotWizard handler is required.");
  }

  const config = await loadConfigFn(storagePaths.configPath);
  if (!config || !isMultiBotConfig(config)) {
    throw new Error("Codex Anywhere is not configured for the current protocol yet. Run `codex-anywhere connect` first.");
  }

  const existingBots = normalizeConfig(config);
  const defaults = existingBots.at(-1) ?? {
    id: "bot-2",
    label: "bot-2",
    telegramBotToken: "",
    workspaceCwd: cwd,
    ownerUserId: null,
    pollTimeoutSeconds: 20,
    streamEditIntervalMs: 1500,
  };
  const bot = await runAddBotWizardFn(cwd, defaults);
  const nextConfig = addBotToConfig(config, bot);
  await runPreflightChecksFn(nextConfig);
  await saveConfigFn(storagePaths.configPath, nextConfig);
  log(`Saved updated config to ${storagePaths.configPath}`);
  log(`Added bot ${bot.id} for workspace ${bot.workspaceCwd}`);
  log("Restart Codex Anywhere or restart the background service to launch the new bot.");
  return {
    config: nextConfig,
    storagePaths,
    bot,
  };
}
