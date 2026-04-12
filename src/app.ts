import process from "node:process";

import { CodexAnywhereBridge, type CodexAnywhereBridgeDeps } from "./bridge.js";
import { addBotToConfig, normalizeConfig, updateConfigBot } from "./configModel.js";
import {
  prepareCodexAnywhereConfig,
  type PrepareCodexAnywhereConfigOptions,
} from "./configuration.js";
import { getBotStoragePaths, getSessionOwnershipPath } from "./paths.js";
import { loadState, saveConfig } from "./persistence.js";
import { runPreflightChecks as defaultRunPreflightChecks } from "./preflight.js";
import { PersistentSessionOwnershipRegistry } from "./sessionOwnership.js";
import { CodexAnywhereSupervisor } from "./supervisor.js";
import type { BotRuntimeConfig, StoragePaths, StoredConfig } from "./types.js";

interface CodexAnywhereBootstrapOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  storagePaths?: StoragePaths;
  bridgeDeps?: CodexAnywhereBridgeDeps;
  bridgeDepsByBotId?: Record<string, CodexAnywhereBridgeDeps>;
  loadConfig?: PrepareCodexAnywhereConfigOptions["loadConfig"];
  saveConfig?: PrepareCodexAnywhereConfigOptions["saveConfig"];
  runSetupWizard?: PrepareCodexAnywhereConfigOptions["runSetupWizard"];
  runPreflightChecks?: PrepareCodexAnywhereConfigOptions["runPreflightChecks"];
  printStartupHelp?: boolean;
  allowSetupWizard?: boolean;
  createBridge?: (
    config: BotRuntimeConfig,
    configPath: string,
    statePath: string,
    deps?: CodexAnywhereBridgeDeps,
  ) => CodexAnywhereBridge;
}

export async function bootstrapCodexAnywhere(
  options: CodexAnywhereBootstrapOptions = {},
): Promise<CodexAnywhereSupervisor> {
  const { config, storagePaths } = await prepareCodexAnywhereConfig({
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    storagePaths: options.storagePaths,
    loadConfig: options.loadConfig,
    saveConfig: options.saveConfig,
    runSetupWizard: options.runSetupWizard,
    runPreflightChecks: options.runPreflightChecks,
    allowSetupWizard: options.allowSetupWizard,
  });

  const createBridge =
    options.createBridge
    ?? ((botConfig, configPath, statePath, deps) =>
      new CodexAnywhereBridge(botConfig, configPath, statePath, deps));
  const runPreflightChecksFn = options.runPreflightChecks ?? defaultRunPreflightChecks;
  let persistedConfig: StoredConfig = config;
  let saveChain = Promise.resolve();
  const bots = normalizeConfig(config);
  const botEntries = await Promise.all(bots.map(async (bot) => {
    const botStoragePaths = bots.length === 1 && config.version === 1
      ? storagePaths
      : getBotStoragePaths(storagePaths, bot.id);
    const initialState = await loadState(botStoragePaths.statePath);
    return {
      bot,
      botStoragePaths,
      initialState,
    };
  }));

  const sessionOwnership = new PersistentSessionOwnershipRegistry(
    getSessionOwnershipPath(storagePaths),
  );
  sessionOwnership.replaceAll({});
  let runtime: CodexAnywhereSupervisor | null = null;
  const addBotRuntime = async (bot: BotRuntimeConfig): Promise<void> => {
    const nextConfig = addBotToConfig(persistedConfig, bot);
    await runPreflightChecksFn(nextConfig);
    persistedConfig = nextConfig;
    const toSave = persistedConfig;
    saveChain = saveChain.then(() => saveConfig(storagePaths.configPath, toSave));
    await saveChain;

    const botStoragePaths = getBotStoragePaths(storagePaths, bot.id);
    const initialState = await loadState(botStoragePaths.statePath);
    const persistConfig = async (nextBotConfig: BotRuntimeConfig): Promise<void> => {
      persistedConfig = updateConfigBot(persistedConfig, nextBotConfig);
      const updatedConfig = persistedConfig;
      saveChain = saveChain.then(() => saveConfig(storagePaths.configPath, updatedConfig));
      await saveChain;
    };
    const bridge = createBridge(
      bot,
      storagePaths.configPath,
      botStoragePaths.statePath,
      {
        ...options.bridgeDeps,
        ...options.bridgeDepsByBotId?.[bot.id],
        botId: bot.id,
        botLabel: bot.label,
        persistConfig,
        sessionOwnership,
        initialState,
        addBot: addBotRuntime,
      },
    );
    await bridge.initialize({
      printStartupHelp: false,
      reconcilePersistedState: true,
    });
    runtime?.addLane(bot, bridge);
  };

  const lanes = await Promise.all(botEntries.map(async (entry) => {
    const persistConfig = async (nextBotConfig: BotRuntimeConfig): Promise<void> => {
      persistedConfig = updateConfigBot(persistedConfig, nextBotConfig);
      const toSave = persistedConfig;
      saveChain = saveChain.then(() => saveConfig(storagePaths.configPath, toSave));
      await saveChain;
    };
    const bridgeDeps = {
      ...options.bridgeDeps,
      ...options.bridgeDepsByBotId?.[entry.bot.id],
      botId: entry.bot.id,
      botLabel: entry.bot.label,
      persistConfig,
      sessionOwnership,
      initialState: entry.initialState,
      addBot: addBotRuntime,
    } satisfies CodexAnywhereBridgeDeps;
    const bridge = createBridge(
      entry.bot,
      storagePaths.configPath,
      entry.botStoragePaths.statePath,
      bridgeDeps,
    );
    await bridge.initialize({
      printStartupHelp: options.printStartupHelp,
      reconcilePersistedState: true,
    });
    return {
      bot: entry.bot,
      bridge,
    };
  }));

  runtime = new CodexAnywhereSupervisor(lanes);
  return runtime;
}
