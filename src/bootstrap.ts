import process from "node:process";

import { CodexAnywhereBridge } from "./bridge.js";
import { normalizeConfig } from "./configModel.js";
import { runSetupWizard } from "./onboarding.js";
import { getStoragePaths } from "./paths.js";
import { loadConfig, saveConfig } from "./persistence.js";
import { runPreflightChecks } from "./preflight.js";
import type { BotRuntimeConfig, StoragePaths } from "./types.js";

export interface BootstrapCodexAnywhereDeps {
  cwd?: string;
  getStoragePaths?: () => StoragePaths;
  loadConfig?: typeof loadConfig;
  saveConfig?: typeof saveConfig;
  runSetupWizard?: typeof runSetupWizard;
  runPreflightChecks?: typeof runPreflightChecks;
  createBridge?: (config: BotRuntimeConfig, configPath: string, statePath: string) => CodexAnywhereBridge;
  log?: (message: string) => void;
}

export interface BootstrappedCodexAnywhere {
  bridge: CodexAnywhereBridge;
  configPath: string;
  statePath: string;
}

export async function bootstrapCodexAnywhere(
  deps: BootstrapCodexAnywhereDeps = {},
): Promise<BootstrappedCodexAnywhere> {
  const resolveStoragePaths = deps.getStoragePaths ?? (() => getStoragePaths());
  const loadConfigFile = deps.loadConfig ?? loadConfig;
  const saveConfigFile = deps.saveConfig ?? saveConfig;
  const setupWizard = deps.runSetupWizard ?? runSetupWizard;
  const preflightChecks = deps.runPreflightChecks ?? runPreflightChecks;
  const createBridge =
    deps.createBridge ?? ((config, configPath, statePath) => new CodexAnywhereBridge(config, configPath, statePath));
  const log = deps.log ?? console.log;

  const { configPath, statePath } = resolveStoragePaths();
  let config = await loadConfigFile(configPath);
  if (!config) {
    config = await setupWizard(deps.cwd ?? process.cwd());
    await saveConfigFile(configPath, config);
    log(`Saved config to ${configPath}`);
  }

  await preflightChecks(config);

  const [botConfig] = normalizeConfig(config);
  if (!botConfig) {
    throw new Error("Codex Anywhere config does not define any bots.");
  }
  const bridge = createBridge(botConfig, configPath, statePath);
  await bridge.initialize();
  return {
    bridge,
    configPath,
    statePath,
  };
}
