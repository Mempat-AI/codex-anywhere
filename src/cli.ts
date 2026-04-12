#!/usr/bin/env node

import process from "node:process";

import { bootstrapCodexAnywhere } from "./app.js";
import { addBotToCodexAnywhereConfig } from "./configuration.js";
import { runAddBotWizard } from "./onboarding.js";
import { runBackgroundServiceCommand } from "./service.js";

async function main(): Promise<void> {
  const wantsHelp = process.argv.includes("--help") || process.argv.includes("-h");
  const command = process.argv[2] ?? "connect";
  if (wantsHelp || command === "help") {
    printHelp();
    return;
  }

  switch (command) {
    case "connect": {
      const runtime = await bootstrapCodexAnywhere({
        cwd: process.cwd(),
        env: process.env,
        allowSetupWizard: !Boolean(process.env.XPC_SERVICE_NAME),
      });
      await runtime.runLoops();
      return;
    }
    case "add-bot":
      await addBotToCodexAnywhereConfig({
        cwd: process.cwd(),
        env: process.env,
        runAddBotWizard,
      });
      return;
    case "install-service":
    case "start-service":
    case "stop-service":
    case "service-status":
    case "uninstall-service":
      await runBackgroundServiceCommand(command, {
        cwd: process.cwd(),
        env: process.env,
      });
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

function printHelp(): void {
  console.log(`Codex Anywhere

Usage:
  codex-anywhere connect
  codex-anywhere add-bot
  codex-anywhere install-service
  codex-anywhere start-service
  codex-anywhere stop-service
  codex-anywhere service-status
  codex-anywhere uninstall-service

Behavior:
  - connect runs guided setup on first launch and starts the Telegram bridge
  - add-bot appends one bot definition to the shared config after connect has migrated older installs
  - macOS service commands manage a LaunchAgent background service
  - Linux service commands manage a user-level systemd background service
  - config/state live under CODEX_ANYWHERE_HOME or your user config directory
`);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Codex Anywhere failed: ${message}`);
  process.exitCode = 1;
});
