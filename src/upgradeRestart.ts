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
} & UpgradeRestartRuntimeOptions): string {
  const logDir = path.join(options.storageRoot, "logs");
  const logPath = path.join(logDir, "upgrade-restart.log");
  const serviceCommand = `${shellQuote(options.nodePath)} ${shellQuote(options.cliPath)}`;
  const script = buildUpgradeRestartScript({
    serviceCommand,
    storageRoot: options.storageRoot,
    logPath,
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
  storageRoot: string;
  logPath: string;
}): string {
  const { serviceCommand } = options;
  return [
    `exec >>${shellQuote(options.logPath)} 2>&1`,
    "sleep 3",
    `export CODEX_ANYWHERE_HOME=${shellQuote(options.storageRoot)}`,
    `echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') using ${serviceCommand}"`,
    `echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') installed version: $(${serviceCommand} --version 2>&1)"`,
    "for attempt in 1 2 3 4 5; do",
    "  echo \"$(date -u '+%Y-%m-%dT%H:%M:%SZ') codex-anywhere restart-service attempt ${attempt}\"",
    `  if ${serviceCommand} restart-service; then`,
    "    echo \"$(date -u '+%Y-%m-%dT%H:%M:%SZ') codex-anywhere restart-service succeeded\"",
    "    exit 0",
    "  fi",
    "  echo \"$(date -u '+%Y-%m-%dT%H:%M:%SZ') codex-anywhere restart-service failed\"",
    "  echo \"$(date -u '+%Y-%m-%dT%H:%M:%SZ') codex-anywhere install-service attempt ${attempt}\"",
    `  if ${serviceCommand} install-service; then`,
    "    echo \"$(date -u '+%Y-%m-%dT%H:%M:%SZ') codex-anywhere install-service succeeded\"",
    "    exit 0",
    "  fi",
    "  echo \"$(date -u '+%Y-%m-%dT%H:%M:%SZ') codex-anywhere install-service failed\"",
    "  sleep 3",
    "done",
    "exit 1",
  ].join("\n");
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
