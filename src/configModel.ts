import type {
  BotRuntimeConfig,
  StoredBotDefinition,
  StoredConfig,
  StoredMultiBotConfig,
  StoredSingleBotConfig,
} from "./types.js";

const DEFAULT_BOT_ID = "default";

export function isMultiBotConfig(config: StoredConfig): config is StoredMultiBotConfig {
  return config.version === 2;
}

export function normalizeConfig(config: StoredConfig): BotRuntimeConfig[] {
  if (isMultiBotConfig(config)) {
    return config.bots.map(normalizeBotDefinition);
  }

  return [
    {
      id: DEFAULT_BOT_ID,
      label: DEFAULT_BOT_ID,
      telegramBotToken: config.telegramBotToken,
      workspaceCwd: config.workspaceCwd,
      ownerUserId: config.ownerUserId,
      pollTimeoutSeconds: config.pollTimeoutSeconds,
      streamEditIntervalMs: config.streamEditIntervalMs,
    },
  ];
}

export function updateConfigBot(config: StoredConfig, bot: BotRuntimeConfig): StoredConfig {
  if (!isMultiBotConfig(config)) {
    return {
      version: 1,
      telegramBotToken: bot.telegramBotToken,
      workspaceCwd: bot.workspaceCwd,
      ownerUserId: bot.ownerUserId,
      pollTimeoutSeconds: bot.pollTimeoutSeconds,
      streamEditIntervalMs: bot.streamEditIntervalMs,
    } satisfies StoredSingleBotConfig;
  }

  return {
    version: 2,
    bots: config.bots.map((entry) => (entry.id === bot.id ? denormalizeBotDefinition(bot) : entry)),
  } satisfies StoredMultiBotConfig;
}

export function summarizeConfiguredBots(config: StoredConfig): BotRuntimeConfig[] {
  return normalizeConfig(config);
}

export function addBotToConfig(config: StoredConfig, bot: BotRuntimeConfig): StoredMultiBotConfig {
  const existingBots = normalizeConfig(config);
  if (existingBots.some((entry) => entry.id === bot.id)) {
    throw new Error(`Bot id already exists: ${bot.id}`);
  }
  return {
    version: 2,
    bots: [...existingBots.map(denormalizeBotDefinition), denormalizeBotDefinition(bot)],
  };
}

function normalizeBotDefinition(bot: StoredBotDefinition): BotRuntimeConfig {
  return {
    id: bot.id,
    label: bot.label?.trim() || bot.id,
    telegramBotToken: bot.telegramBotToken,
    workspaceCwd: bot.workspaceCwd,
    ownerUserId: bot.ownerUserId,
    pollTimeoutSeconds: bot.pollTimeoutSeconds,
    streamEditIntervalMs: bot.streamEditIntervalMs,
  };
}

function denormalizeBotDefinition(bot: BotRuntimeConfig): StoredBotDefinition {
  return {
    id: bot.id,
    label: bot.label,
    telegramBotToken: bot.telegramBotToken,
    workspaceCwd: bot.workspaceCwd,
    ownerUserId: bot.ownerUserId,
    pollTimeoutSeconds: bot.pollTimeoutSeconds,
    streamEditIntervalMs: bot.streamEditIntervalMs,
  };
}
