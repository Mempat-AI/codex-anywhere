import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export interface UpgradeRestartRuntimeOptions {
  platform?: NodeJS.Platform;
  uid?: number;
}

export interface UpgradeRestartProbe {
  command: string;
  markerPath: string;
  logPath: string;
  token: string;
}

export function buildUpgradeServiceRestartCommand(options: {
  nodePath: string;
  cliPath: string;
  storageRoot: string;
  configPath: string;
  statePath: string;
  botId: string;
  chatId: number;
  targetVersionLine: string;
  watchdogMarkerPath: string;
  pathEnv?: string;
  watchdogTimeoutSeconds?: number;
} & UpgradeRestartRuntimeOptions): string {
  const logDir = path.join(options.storageRoot, "logs");
  const logPath = path.join(logDir, "upgrade-restart.log");
  const serviceCommand = `${shellQuote(options.nodePath)} ${shellQuote(options.cliPath)}`;
  const script = buildUpgradeRestartScript({
    serviceCommand,
    nodePath: options.nodePath,
    storageRoot: options.storageRoot,
    logPath,
    configPath: options.configPath,
    statePath: options.statePath,
    botId: options.botId,
    chatId: options.chatId,
    targetVersionLine: options.targetVersionLine,
    watchdogMarkerPath: options.watchdogMarkerPath,
    watchdogTimeoutSeconds: options.watchdogTimeoutSeconds ?? 75,
    pathEnv: options.pathEnv,
  });
  return buildSupervisedUpgradeHelperCommand({
    script,
    logDir,
    logPath,
    storageRoot: options.storageRoot,
    helperName: "upgrade-restart",
    platform: options.platform,
    uid: options.uid,
  });
}

export function buildUpgradeRestartProbeCommand(options: {
  storageRoot: string;
} & UpgradeRestartRuntimeOptions): UpgradeRestartProbe {
  const logDir = path.join(options.storageRoot, "logs");
  const token = randomBytes(8).toString("hex");
  const markerPath = path.join(logDir, `upgrade-restart-test-${token}.ok`);
  const logPath = path.join(logDir, "upgrade-restart-test.log");
  const script = [
    `exec >>${shellQuote(logPath)} 2>&1`,
    `echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') upgrade restart probe started"`,
    `export CODEX_ANYWHERE_HOME=${shellQuote(options.storageRoot)}`,
    `printf %s ${shellQuote(token)} >${shellQuote(markerPath)}`,
    `echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') upgrade restart probe completed"`,
  ].join("\n");
  return {
    command: buildSupervisedUpgradeHelperCommand({
      script,
      logDir,
      logPath,
      storageRoot: options.storageRoot,
      helperName: "upgrade-restart-test",
      platform: options.platform,
      uid: options.uid,
    }),
    markerPath,
    logPath,
    token,
  };
}

export async function waitForUpgradeRestartProbe(
  probe: UpgradeRestartProbe,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() <= deadline) {
    try {
      const marker = await fs.readFile(probe.markerPath, "utf8");
      if (marker.trim() === probe.token) {
        return;
      }
      lastError = new Error(`Probe marker had unexpected contents: ${marker.trim()}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Upgrade restart probe did not complete within ${timeoutMs}ms: ${detail}`);
}

export async function readUpgradeRestartLogTail(logPath: string, maxChars = 2000): Promise<string | null> {
  try {
    const log = await fs.readFile(logPath, "utf8");
    return log.slice(-maxChars).trim() || null;
  } catch {
    return null;
  }
}

function buildUpgradeRestartScript(options: {
  serviceCommand: string;
  nodePath: string;
  storageRoot: string;
  logPath: string;
  configPath: string;
  statePath: string;
  botId: string;
  chatId: number;
  targetVersionLine: string;
  watchdogMarkerPath: string;
  watchdogTimeoutSeconds: number;
  pathEnv?: string;
}): string {
  const { serviceCommand } = options;
  const watchdogCommand = buildUpgradeWatchdogCommand(options);
  return [
    `exec >>${shellQuote(options.logPath)} 2>&1`,
    "sleep 3",
    ...(options.pathEnv ? [`export PATH=${shellQuote(options.pathEnv)}`] : []),
    `export CODEX_ANYWHERE_HOME=${shellQuote(options.storageRoot)}`,
    `rm -f ${shellQuote(options.watchdogMarkerPath)}`,
    `echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') using ${serviceCommand}"`,
    `echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') installed version: $(${serviceCommand} --version 2>&1)"`,
    "for attempt in 1 2 3 4 5; do",
    "  echo \"$(date -u '+%Y-%m-%dT%H:%M:%SZ') codex-anywhere restart-service attempt ${attempt}\"",
    `  if ${serviceCommand} restart-service; then`,
    "    echo \"$(date -u '+%Y-%m-%dT%H:%M:%SZ') codex-anywhere restart-service succeeded\"",
    `    ${watchdogCommand}`,
    "    exit 0",
    "  fi",
    "  echo \"$(date -u '+%Y-%m-%dT%H:%M:%SZ') codex-anywhere restart-service failed\"",
    "  echo \"$(date -u '+%Y-%m-%dT%H:%M:%SZ') codex-anywhere install-service attempt ${attempt}\"",
    `  if ${serviceCommand} install-service; then`,
    "    echo \"$(date -u '+%Y-%m-%dT%H:%M:%SZ') codex-anywhere install-service succeeded\"",
    `    ${watchdogCommand}`,
    "    exit 0",
    "  fi",
    "  echo \"$(date -u '+%Y-%m-%dT%H:%M:%SZ') codex-anywhere install-service failed\"",
    "  sleep 3",
    "done",
    `echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') codex-anywhere service restart attempts exhausted"`,
    `${watchdogCommand} --skip-wait`,
    "exit 1",
  ].join("\n");
}

function buildUpgradeWatchdogCommand(options: {
  nodePath: string;
  configPath: string;
  statePath: string;
  botId: string;
  chatId: number;
  targetVersionLine: string;
  watchdogMarkerPath: string;
  watchdogTimeoutSeconds: number;
  logPath: string;
}): string {
  const script = String.raw`
const fs = require("fs");
const https = require("https");
const args = JSON.parse(process.argv[1]);
const skipWait = process.argv.includes("--skip-wait");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const esc = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function findBotToken(config, botId) {
  if (typeof config.telegramBotToken === "string") return config.telegramBotToken;
  if (Array.isArray(config.bots)) {
    const bot = config.bots.find((entry) => entry && entry.id === botId);
    if (bot && typeof bot.telegramBotToken === "string") return bot.telegramBotToken;
  }
  throw new Error("No Telegram token found for bot " + botId);
}

function tail(filePath, maxChars) {
  try {
    return fs.readFileSync(filePath, "utf8").slice(-maxChars).trim();
  } catch {
    return "";
  }
}

function sendTelegram(token, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = https.request({
      hostname: "api.telegram.org",
      path: "/bot" + token + "/sendMessage",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    }, (response) => {
      let data = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        data += chunk;
      });
      response.on("end", () => {
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
          resolve();
        } else {
          reject(new Error("Telegram send failed: " + response.statusCode + " " + data));
        }
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}

async function waitForMarker() {
  const deadline = Date.now() + args.timeoutSeconds * 1000;
  while (!skipWait && Date.now() <= deadline) {
    if (fs.existsSync(args.markerPath)) {
      console.log(new Date().toISOString() + " upgrade watchdog marker observed");
      return true;
    }
    await sleep(1000);
  }
  return fs.existsSync(args.markerPath);
}

async function markExternalFailure() {
  try {
    const state = readJson(args.statePath);
    if (state && state.pendingUpgradeNotification) {
      state.pendingUpgradeNotification.failureNotifiedAt = Date.now();
      fs.writeFileSync(args.statePath, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    }
  } catch (error) {
    console.error(new Date().toISOString() + " failed to mark upgrade failure: " + error.message);
  }
  try {
    fs.writeFileSync(args.markerPath, "external-failure " + new Date().toISOString() + "\n", { mode: 0o600 });
  } catch (error) {
    console.error(new Date().toISOString() + " failed to write watchdog marker: " + error.message);
  }
}

(async () => {
  if (await waitForMarker()) return;
  const config = readJson(args.configPath);
  const token = findBotToken(config, args.botId);
  const logTail = tail(args.logPath, 1200);
  const lines = [
    "<b>Upgrade restart did not become reachable</b>",
    "Installed target: <code>" + esc(args.targetVersionLine) + "</code>.",
    "The supervisor helper did not see a restarted Telegram bridge within " + args.timeoutSeconds + "s.",
    "Log: <code>" + esc(args.logPath) + "</code>",
  ];
  if (logTail) {
    lines.push("", "<b>Log tail</b>", "<pre>" + esc(logTail) + "</pre>");
  }
  await sendTelegram(token, {
    chat_id: args.chatId,
    text: lines.join("\n"),
    parse_mode: "HTML",
  });
  await markExternalFailure();
  console.log(new Date().toISOString() + " upgrade watchdog failure notification sent");
})().catch((error) => {
  console.error(new Date().toISOString() + " upgrade watchdog failed: " + (error.stack || error.message));
  process.exitCode = 1;
});
`;
  const args = {
    configPath: options.configPath,
    statePath: options.statePath,
    botId: options.botId,
    chatId: options.chatId,
    targetVersionLine: options.targetVersionLine,
    markerPath: options.watchdogMarkerPath,
    timeoutSeconds: options.watchdogTimeoutSeconds,
    logPath: options.logPath,
  };
  return `${shellQuote(options.nodePath)} -e ${shellQuote(script)} ${shellQuote(JSON.stringify(args))}`;
}

function buildSupervisedUpgradeHelperCommand(options: {
  script: string;
  logDir: string;
  logPath: string;
  storageRoot: string;
  helperName: string;
} & UpgradeRestartRuntimeOptions): string {
  if (options.platform === "darwin") {
    return buildMacosUpgradeHelperCommand(options);
  }
  if (options.platform === "linux") {
    return buildLinuxUpgradeHelperCommand(options);
  }
  return buildNohupUpgradeHelperCommand({ script: options.script, logDir: options.logDir });
}

function buildMacosUpgradeHelperCommand(options: {
  script: string;
  logDir: string;
  logPath: string;
  storageRoot: string;
  helperName: string;
  uid?: number;
}): string {
  if (options.uid === undefined) {
    return buildNohupUpgradeHelperCommand({ script: options.script, logDir: options.logDir });
  }
  const helperId = createHash("sha256").update(options.storageRoot).digest("hex").slice(0, 12);
  const label = `ai.mempat.codex-anywhere.${options.helperName}.${helperId}`;
  const domainTarget = `gui/${options.uid}`;
  const plistPath = path.join(options.logDir, `${label}.plist`);
  const plist = renderUpgradeLaunchAgentPlist({
    label,
    script: options.script,
    logPath: options.logPath,
  });
  return [
    `mkdir -p ${shellQuote(options.logDir)}`,
    `printf %s ${shellQuote(plist)} >${shellQuote(plistPath)}`,
    `(launchctl bootout ${shellQuote(domainTarget)} ${shellQuote(plistPath)} >/dev/null 2>&1 || true)`,
    `launchctl bootstrap ${shellQuote(domainTarget)} ${shellQuote(plistPath)}`,
  ].join(" && ");
}

function renderUpgradeLaunchAgentPlist(options: {
  label: string;
  script: string;
  logPath: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(options.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>${escapeXml(options.script)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(options.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(options.logPath)}</string>
</dict>
</plist>
`;
}

function buildLinuxUpgradeHelperCommand(options: {
  script: string;
  logDir: string;
  storageRoot: string;
  helperName: string;
}): string {
  const unitId = createHash("sha256").update(options.storageRoot).digest("hex").slice(0, 12);
  const unitName = `codex-anywhere-${options.helperName}-${unitId}`;
  const systemdScript = [
    `systemctl --user stop ${shellQuote(`${unitName}.service`)} >/dev/null 2>&1 || true`,
    `systemctl --user reset-failed ${shellQuote(`${unitName}.service`)} >/dev/null 2>&1 || true`,
    `systemd-run --user --unit=${shellQuote(unitName)} --collect /bin/sh -c ${shellQuote(options.script)}`,
  ].join("\n");
  const fallbackScript = `nohup sh -c ${shellQuote(options.script)} >/dev/null 2>&1 &`;
  return [
    `mkdir -p ${shellQuote(options.logDir)}`,
    "if command -v systemd-run >/dev/null 2>&1; then",
    systemdScript,
    "else",
    fallbackScript,
    "fi",
  ].join("\n");
}

function buildNohupUpgradeHelperCommand(options: {
  script: string;
  logDir: string;
}): string {
  return `mkdir -p ${shellQuote(options.logDir)} && nohup sh -c ${shellQuote(options.script)} >/dev/null 2>&1 &`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
