import assert from "node:assert/strict";
import test from "node:test";

import { addBotToCodexAnywhereConfig } from "../src/configuration.js";
import type { BotRuntimeConfig, StoredConfig } from "../src/types.js";

test("addBotToCodexAnywhereConfig appends a new bot to an existing multi-bot config", async () => {
  let savedConfig: StoredConfig | null = null;
  let preflightConfig: StoredConfig | null = null;

  const initialConfig: StoredConfig = {
    version: 2,
    bots: [
      {
        id: "bot-a",
        label: "Bot A",
        telegramBotToken: "token-a",
        workspaceCwd: "/tmp/workspace-a",
        ownerUserId: 1,
        pollTimeoutSeconds: 20,
        streamEditIntervalMs: 1500,
      },
    ],
  };
  const newBot: BotRuntimeConfig = {
    id: "bot-b",
    label: "Bot B",
    telegramBotToken: "token-b",
    workspaceCwd: "/tmp/workspace-b",
    ownerUserId: 1,
    pollTimeoutSeconds: 20,
    streamEditIntervalMs: 1500,
  };

  const result = await addBotToCodexAnywhereConfig({
    cwd: "/tmp/current",
    storagePaths: {
      configPath: "/tmp/codex-anywhere/config.json",
      statePath: "/tmp/codex-anywhere/state.json",
    },
    loadConfig: async () => initialConfig,
    saveConfig: async (_configPath, config) => {
      savedConfig = config;
    },
    runAddBotWizard: async (defaultWorkspaceCwd, defaults) => {
      assert.equal(defaultWorkspaceCwd, "/tmp/current");
      assert.equal(defaults?.workspaceCwd, "/tmp/workspace-a");
      return newBot;
    },
    runPreflightChecks: async (config) => {
      preflightConfig = config;
    },
    log: () => {},
  });

  assert.equal(result.bot.id, "bot-b");
  assert.equal(result.config.version, 2);
  assert.equal(result.config.bots.length, 2);
  assert.equal(result.config.bots[0]!.id, "bot-a");
  assert.equal(result.config.bots[1]!.id, "bot-b");
  assert.deepEqual(savedConfig, result.config);
  assert.deepEqual(preflightConfig, result.config);
});

test("addBotToCodexAnywhereConfig rejects legacy single-bot config and requires connect first", async () => {
  const initialConfig: StoredConfig = {
    version: 1,
    telegramBotToken: "token-a",
    workspaceCwd: "/tmp/workspace-a",
    ownerUserId: 1,
    pollTimeoutSeconds: 20,
    streamEditIntervalMs: 1500,
  };

  let wizardCalled = false;

  await assert.rejects(
    () => addBotToCodexAnywhereConfig({
      cwd: "/tmp/current",
      storagePaths: {
        configPath: "/tmp/codex-anywhere/config.json",
        statePath: "/tmp/codex-anywhere/state.json",
      },
      loadConfig: async () => initialConfig,
      runAddBotWizard: async () => {
        wizardCalled = true;
        throw new Error("should not run");
      },
      log: () => {},
    }),
    /Run `codex-anywhere connect` first/,
  );

  assert.equal(wizardCalled, false);
});

test("addBotToCodexAnywhereConfig requires an existing config", async () => {
  await assert.rejects(
    () => addBotToCodexAnywhereConfig({
      storagePaths: {
        configPath: "/tmp/codex-anywhere/config.json",
        statePath: "/tmp/codex-anywhere/state.json",
      },
      loadConfig: async () => null,
      runAddBotWizard: async () => {
        throw new Error("should not run");
      },
      log: () => {},
    }),
    /Run `codex-anywhere connect` first/,
  );
});

test("addBotToCodexAnywhereConfig rejects duplicate bot ids", async () => {
  const initialConfig: StoredConfig = {
    version: 2,
    bots: [
      {
        id: "bot-a",
        label: "Bot A",
        telegramBotToken: "token-a",
        workspaceCwd: "/tmp/workspace-a",
        ownerUserId: 1,
        pollTimeoutSeconds: 20,
        streamEditIntervalMs: 1500,
      },
    ],
  };

  await assert.rejects(
    () => addBotToCodexAnywhereConfig({
      storagePaths: {
        configPath: "/tmp/codex-anywhere/config.json",
        statePath: "/tmp/codex-anywhere/state.json",
      },
      loadConfig: async () => initialConfig,
      saveConfig: async () => {},
      runAddBotWizard: async () => ({
        id: "bot-a",
        label: "Bot A Duplicate",
        telegramBotToken: "token-b",
        workspaceCwd: "/tmp/workspace-b",
        ownerUserId: 1,
        pollTimeoutSeconds: 20,
        streamEditIntervalMs: 1500,
      }),
      runPreflightChecks: async () => {},
      log: () => {},
    }),
    /Bot id already exists: bot-a/,
  );
});
