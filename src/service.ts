import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { summarizeConfiguredBots } from "./configModel.js";
import { prepareCodexAnywhereConfig } from "./configuration.js";
import { getStoragePaths } from "./paths.js";
import { loadConfig } from "./persistence.js";
import type { StoredConfig, StoragePaths } from "./types.js";

const execFileAsync = promisify(execFileCallback);
const require = createRequire(import.meta.url);
const LAUNCH_AGENT_DOMAIN = "gui";
const LAUNCH_AGENT_LABEL_PREFIX = "ai.mempat.codex-anywhere";

export type BackgroundServiceCommand =
  | "install-service"
  | "start-service"
  | "stop-service"
  | "service-status"
  | "uninstall-service";

export interface LaunchAgentSpec {
  label: string;
  domainTarget: string;
  serviceTarget: string;
  plistPath: string;
  stdoutPath: string;
  stderrPath: string;
  workingDirectory: string;
  storageRoot: string;
  programArguments: string[];
  environmentVariables: Record<string, string>;
}

export interface LinuxSystemdServiceSpec {
  label: string;
  serviceName: string;
  unitPath: string;
  workingDirectory: string;
  storageRoot: string;
  stdoutPath: string;
  stderrPath: string;
  programArguments: string[];
  environmentVariables: Record<string, string>;
}

interface ExecFileResult {
  stdout: string;
  stderr: string;
}

interface ServiceExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

type ServiceExecFile = (
  file: string,
  args: string[],
  options?: ServiceExecOptions,
) => Promise<ExecFileResult>;

export interface RunBackgroundServiceCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  packageRoot?: string;
  storagePaths?: StoragePaths;
  loadConfig?: (configPath: string) => Promise<StoredConfig | null>;
  saveConfig?: (configPath: string, config: StoredConfig) => Promise<void>;
  runSetupWizard?: (defaultWorkspaceCwd: string) => Promise<StoredConfig>;
  runPreflightChecks?: (config: StoredConfig) => Promise<void>;
  execFile?: ServiceExecFile;
  log?: (message: string) => void;
  homeDir?: string;
  uid?: number;
  nodePath?: string;
  tsxCliPath?: string;
}

export function buildMacosLaunchAgentSpec(options: {
  repoCwd: string;
  storageRoot: string;
  homeDir: string;
  uid: number;
  pathEnv: string;
  programArguments: string[];
  extraEnv?: Record<string, string | undefined>;
}): LaunchAgentSpec {
  const serviceId = buildServiceId(options.storageRoot);
  const label = `${LAUNCH_AGENT_LABEL_PREFIX}.${serviceId}`;
  const launchAgentsDir = path.join(options.homeDir, "Library", "LaunchAgents");
  const domainTarget = `${LAUNCH_AGENT_DOMAIN}/${options.uid}`;
  const serviceTarget = `${domainTarget}/${label}`;
  const logDir = path.join(options.storageRoot, "logs");
  const environmentVariables = sanitizeEnvironmentVariables({
    PATH: options.pathEnv,
    CODEX_ANYWHERE_HOME: options.storageRoot,
    ...options.extraEnv,
  });

  return {
    label,
    domainTarget,
    serviceTarget,
    plistPath: path.join(launchAgentsDir, `${label}.plist`),
    stdoutPath: path.join(logDir, "launchd.stdout.log"),
    stderrPath: path.join(logDir, "launchd.stderr.log"),
    workingDirectory: options.repoCwd,
    storageRoot: options.storageRoot,
    programArguments: options.programArguments,
    environmentVariables,
  };
}

export function buildLinuxSystemdUserServiceSpec(options: {
  repoCwd: string;
  storageRoot: string;
  homeDir: string;
  configHome?: string;
  pathEnv: string;
  programArguments: string[];
  extraEnv?: Record<string, string | undefined>;
}): LinuxSystemdServiceSpec {
  const serviceId = buildServiceId(options.storageRoot);
  const label = `${LAUNCH_AGENT_LABEL_PREFIX}.${serviceId}`;
  const systemdConfigHome = options.configHome ?? path.join(options.homeDir, ".config");
  const unitDir = path.join(systemdConfigHome, "systemd", "user");
  const serviceName = `${label}.service`;
  const logDir = path.join(options.storageRoot, "logs");
  const environmentVariables = sanitizeEnvironmentVariables({
    PATH: options.pathEnv,
    CODEX_ANYWHERE_HOME: options.storageRoot,
    ...options.extraEnv,
  });

  return {
    label,
    serviceName,
    unitPath: path.join(unitDir, serviceName),
    workingDirectory: options.repoCwd,
    storageRoot: options.storageRoot,
    stdoutPath: path.join(logDir, "systemd.stdout.log"),
    stderrPath: path.join(logDir, "systemd.stderr.log"),
    programArguments: options.programArguments,
    environmentVariables,
  };
}

export function renderLaunchAgentPlist(spec: LaunchAgentSpec): string {
  const programArguments = spec.programArguments
    .map((argument) => `    <string>${escapeXml(argument)}</string>`)
    .join("\n");
  const environmentVariables = Object.entries(spec.environmentVariables)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, value]) =>
        `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(spec.label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(spec.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${environmentVariables}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(spec.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(spec.stderrPath)}</string>
</dict>
</plist>
`;
}

export function renderLinuxSystemdUnit(spec: LinuxSystemdServiceSpec): string {
  const environmentVariables = Object.entries(spec.environmentVariables)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `Environment=${quoteSystemdEnv(key, value)}`)
    .join("\n");
  const environmentSection = environmentVariables ? `${environmentVariables}\n` : "";

  return `[Unit]
Description=Codex Anywhere background bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${escapeSystemdSettingValue(spec.workingDirectory)}
ExecStart=${spec.programArguments.map(quoteSystemdValue).join(" ")}
${environmentSection}Restart=always
RestartSec=5
StandardOutput=append:${escapeSystemdSettingValue(spec.stdoutPath)}
StandardError=append:${escapeSystemdSettingValue(spec.stderrPath)}

[Install]
WantedBy=default.target
`;
}

export async function runBackgroundServiceCommand(
  command: BackgroundServiceCommand,
  options: RunBackgroundServiceCommandOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const storagePaths = options.storagePaths ?? getStoragePaths(env);
  const storageRoot = path.dirname(storagePaths.configPath);
  const homeDir = options.homeDir ?? os.homedir();
  const execFile = options.execFile ?? execFileAsync;
  const log = options.log ?? console.log;
  const packageRoot = options.packageRoot ?? resolvePackageRoot();
  const existingConfig =
    (await (options.loadConfig ?? loadConfig)(storagePaths.configPath)) ?? null;
  const programArguments = await resolveServiceProgramArguments({
    packageRoot,
    nodePath: options.nodePath ?? process.execPath,
    tsxCliPath: options.tsxCliPath,
  });

  if (platform === "darwin") {
    const uid = options.uid ?? currentUid();
    const spec = buildMacosLaunchAgentSpec({
      repoCwd: packageRoot,
      storageRoot,
      homeDir,
      uid,
      pathEnv: env.PATH ?? "",
      programArguments,
      extraEnv: {
        HOME: env.HOME ?? homeDir,
        LANG: env.LANG,
        LC_ALL: env.LC_ALL,
        TMPDIR: env.TMPDIR,
        USER: env.USER,
      },
    });

  switch (command) {
    case "install-service":
      await prepareCodexAnywhereConfig({
        cwd,
        env,
        storagePaths,
        loadConfig: options.loadConfig,
        saveConfig: options.saveConfig,
        runSetupWizard: options.runSetupWizard,
        runPreflightChecks: options.runPreflightChecks,
        log,
        allowSetupWizard: true,
      });
      await installLaunchAgent(spec, execFile);
      log(`Installed LaunchAgent ${spec.label}`);
      log(`Plist: ${spec.plistPath}`);
      log(`Logs: ${spec.stdoutPath}`);
      return;
    case "start-service":
      await assertLaunchAgentInstalled(spec);
      if (!existingConfig) {
        throw new Error(
          "Codex Anywhere is not configured yet. Run `npm run connect` or `pnpm run connect` once before starting the service.",
        );
      }
      await startLaunchAgent(spec, execFile);
      log(`Started LaunchAgent ${spec.label}`);
      return;
    case "stop-service":
      await assertLaunchAgentInstalled(spec);
      await stopLaunchAgent(spec, execFile);
      log(`Stopped LaunchAgent ${spec.label}`);
      return;
    case "service-status":
      await printLaunchAgentStatus(spec, execFile, log, existingConfig);
        return;
    case "uninstall-service":
      await uninstallLaunchAgent(spec, execFile);
      log(`Removed LaunchAgent ${spec.label}`);
      return;
  }

  if (platform === "linux") {
    const spec = buildLinuxSystemdUserServiceSpec({
      repoCwd: packageRoot,
      storageRoot,
      homeDir,
      configHome: env.XDG_CONFIG_HOME,
      pathEnv: env.PATH ?? "",
      programArguments,
      extraEnv: {
        HOME: env.HOME ?? homeDir,
        LANG: env.LANG,
        LC_ALL: env.LC_ALL,
        USER: env.USER,
      },
    });

    switch (command) {
      case "install-service":
        await prepareCodexAnywhereConfig({
          cwd,
          env,
          storagePaths,
          loadConfig: options.loadConfig,
          saveConfig: options.saveConfig,
          runSetupWizard: options.runSetupWizard,
          runPreflightChecks: options.runPreflightChecks,
          log,
          allowSetupWizard: true,
        });
        await installLinuxSystemdUnit(spec, execFile);
        log(`Installed systemd user service ${spec.serviceName}`);
        log(`Unit: ${spec.unitPath}`);
        log(`Logs: ${spec.stdoutPath}`);
        return;
      case "start-service":
        await assertLinuxSystemdUnitInstalled(spec);
        if (!existingConfig) {
          throw new Error(
            "Codex Anywhere is not configured yet. Run `npm run connect` or `pnpm run connect` once before starting the service.",
          );
        }
        await startLinuxSystemdUnit(spec, execFile);
        log(`Started systemd user service ${spec.serviceName}`);
        return;
      case "stop-service":
        await assertLinuxSystemdUnitInstalled(spec);
        await stopLinuxSystemdUnit(spec, execFile);
        log(`Stopped systemd user service ${spec.serviceName}`);
        return;
      case "service-status":
        await printLinuxSystemdStatus(spec, execFile, log, existingConfig);
        return;
      case "uninstall-service":
        await uninstallLinuxSystemdUnit(spec, execFile);
        log(`Removed systemd user service ${spec.serviceName}`);
        return;
    }
  }

  throw new Error(`Background service management is not implemented on ${platform}.`);
}

async function installLaunchAgent(
  spec: LaunchAgentSpec,
  execFile: ServiceExecFile,
): Promise<void> {
  await fs.mkdir(path.dirname(spec.plistPath), { recursive: true });
  await fs.mkdir(path.dirname(spec.stdoutPath), { recursive: true });
  await fs.writeFile(spec.plistPath, renderLaunchAgentPlist(spec), "utf8");
  await runLaunchctl(execFile, ["enable", spec.serviceTarget], { ignoreFailure: true });
  await runLaunchctl(execFile, ["bootout", spec.domainTarget, spec.plistPath], {
    ignoreFailure: true,
  });
  await runLaunchctl(execFile, ["bootstrap", spec.domainTarget, spec.plistPath]);
  await runLaunchctl(execFile, ["kickstart", "-k", spec.serviceTarget]);
}

async function startLaunchAgent(
  spec: LaunchAgentSpec,
  execFile: ServiceExecFile,
): Promise<void> {
  await runLaunchctl(execFile, ["enable", spec.serviceTarget], { ignoreFailure: true });
  await runLaunchctl(execFile, ["bootout", spec.domainTarget, spec.plistPath], {
    ignoreFailure: true,
  });
  await runLaunchctl(execFile, ["bootstrap", spec.domainTarget, spec.plistPath]);
  await runLaunchctl(execFile, ["kickstart", "-k", spec.serviceTarget]);
}

async function stopLaunchAgent(
  spec: LaunchAgentSpec,
  execFile: ServiceExecFile,
): Promise<void> {
  await runLaunchctl(execFile, ["disable", spec.serviceTarget], { ignoreFailure: true });
  await runLaunchctl(execFile, ["bootout", spec.domainTarget, spec.plistPath], {
    ignoreFailure: true,
  });
}

async function uninstallLaunchAgent(
  spec: LaunchAgentSpec,
  execFile: ServiceExecFile,
): Promise<void> {
  await runLaunchctl(execFile, ["disable", spec.serviceTarget], { ignoreFailure: true });
  await runLaunchctl(execFile, ["bootout", spec.domainTarget, spec.plistPath], {
    ignoreFailure: true,
  });
  await fs.rm(spec.plistPath, { force: true });
}

async function printLaunchAgentStatus(
  spec: LaunchAgentSpec,
  execFile: ServiceExecFile,
  log: (message: string) => void,
  config: StoredConfig | null,
): Promise<void> {
  const installed = await fileExists(spec.plistPath);
  const loaded = await runLaunchctl(execFile, ["print", spec.serviceTarget], {
    ignoreFailure: true,
  });
  const lines = [
    `platform: darwin`,
    `label: ${spec.label}`,
    `plist: ${spec.plistPath}`,
    `installed: ${installed ? "yes" : "no"}`,
    `loaded: ${loaded.ok ? "yes" : "no"}`,
    `storage-root: ${spec.storageRoot}`,
    `stdout-log: ${spec.stdoutPath}`,
    `stderr-log: ${spec.stderrPath}`,
  ];
  if (config) {
    const bots = summarizeConfiguredBots(config);
    lines.push(`configured-bots: ${bots.length}`);
    for (const bot of bots) {
      lines.push(`bot ${bot.id}: workspace=${bot.workspaceCwd}`);
    }
  }
  if (loaded.stdout.trim()) {
    lines.push("");
    lines.push("launchctl print:");
    lines.push(loaded.stdout.trim());
  } else if (!installed) {
    lines.push("");
    lines.push("LaunchAgent plist is not installed.");
  }
  log(lines.join("\n"));
}

async function installLinuxSystemdUnit(
  spec: LinuxSystemdServiceSpec,
  execFile: ServiceExecFile,
): Promise<void> {
  await fs.mkdir(path.dirname(spec.unitPath), { recursive: true });
  await fs.mkdir(path.dirname(spec.stdoutPath), { recursive: true });
  await fs.writeFile(spec.unitPath, renderLinuxSystemdUnit(spec), "utf8");
  await runSystemctl(execFile, ["--user", "daemon-reload"]);
  await runSystemctl(execFile, ["--user", "enable", "--now", spec.serviceName]);
}

async function startLinuxSystemdUnit(
  spec: LinuxSystemdServiceSpec,
  execFile: ServiceExecFile,
): Promise<void> {
  await runSystemctl(execFile, ["--user", "daemon-reload"]);
  await runSystemctl(execFile, ["--user", "enable", "--now", spec.serviceName]);
}

async function stopLinuxSystemdUnit(
  spec: LinuxSystemdServiceSpec,
  execFile: ServiceExecFile,
): Promise<void> {
  await runSystemctl(execFile, ["--user", "disable", "--now", spec.serviceName], {
    ignoreFailure: true,
  });
}

async function uninstallLinuxSystemdUnit(
  spec: LinuxSystemdServiceSpec,
  execFile: ServiceExecFile,
): Promise<void> {
  await runSystemctl(execFile, ["--user", "disable", "--now", spec.serviceName], {
    ignoreFailure: true,
  });
  await fs.rm(spec.unitPath, { force: true });
  await runSystemctl(execFile, ["--user", "daemon-reload"]);
}

async function printLinuxSystemdStatus(
  spec: LinuxSystemdServiceSpec,
  execFile: ServiceExecFile,
  log: (message: string) => void,
  config: StoredConfig | null,
): Promise<void> {
  const installed = await fileExists(spec.unitPath);
  const active = await runSystemctl(execFile, ["--user", "is-active", spec.serviceName], {
    ignoreFailure: true,
  });
  const enabled = await runSystemctl(execFile, ["--user", "is-enabled", spec.serviceName], {
    ignoreFailure: true,
  });
  const detail = await runSystemctl(execFile, ["--user", "status", spec.serviceName], {
    ignoreFailure: true,
  });
  const lines = [
    `platform: linux`,
    `label: ${spec.label}`,
    `unit: ${spec.unitPath}`,
    `installed: ${installed ? "yes" : "no"}`,
    `enabled: ${enabled.ok ? enabled.stdout.trim() || "yes" : "no"}`,
    `active: ${active.ok ? active.stdout.trim() || "yes" : "no"}`,
    `storage-root: ${spec.storageRoot}`,
    `stdout-log: ${spec.stdoutPath}`,
    `stderr-log: ${spec.stderrPath}`,
  ];
  if (config) {
    const bots = summarizeConfiguredBots(config);
    lines.push(`configured-bots: ${bots.length}`);
    for (const bot of bots) {
      lines.push(`bot ${bot.id}: workspace=${bot.workspaceCwd}`);
    }
  }
  if (detail.stdout.trim()) {
    lines.push("");
    lines.push("systemctl --user status:");
    lines.push(detail.stdout.trim());
  } else if (!installed) {
    lines.push("");
    lines.push("systemd user service is not installed.");
  }
  log(lines.join("\n"));
}

async function assertLaunchAgentInstalled(spec: LaunchAgentSpec): Promise<void> {
  if (!(await fileExists(spec.plistPath))) {
    throw new Error(
      `LaunchAgent is not installed yet: ${spec.plistPath}\nRun \`npm run service:install\` or \`pnpm run service:install\` first.`,
    );
  }
}

async function assertLinuxSystemdUnitInstalled(spec: LinuxSystemdServiceSpec): Promise<void> {
  if (!(await fileExists(spec.unitPath))) {
    throw new Error(
      `systemd user service is not installed yet: ${spec.unitPath}\nRun \`npm run service:install\` or \`pnpm run service:install\` first.`,
    );
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function currentUid(): number {
  if (typeof process.getuid !== "function") {
    throw new Error("Unable to determine the current user id for launchctl.");
  }
  return process.getuid();
}

function resolvePackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export async function resolveServiceProgramArguments(options: {
  packageRoot: string;
  nodePath: string;
  tsxCliPath?: string;
}): Promise<string[]> {
  const sourceCliPath = path.join(options.packageRoot, "src", "cli.ts");
  if (await fileExists(sourceCliPath)) {
    return [options.nodePath, options.tsxCliPath ?? resolveTsxCliPath(), sourceCliPath, "connect"];
  }

  const builtCliPath = path.join(options.packageRoot, "dist", "cli.js");
  if (await fileExists(builtCliPath)) {
    return [options.nodePath, builtCliPath, "connect"];
  }

  throw new Error(
    `Unable to find a runnable Codex Anywhere CLI entrypoint under ${options.packageRoot}. Expected src/cli.ts or dist/cli.js.`,
  );
}

function resolveTsxCliPath(): string {
  try {
    return require.resolve("tsx/cli");
  } catch {
    const packageJsonPath = require.resolve("tsx/package.json");
    const packageJson = require(packageJsonPath) as { bin?: string | Record<string, string> };
    const binEntry =
      typeof packageJson.bin === "string"
        ? packageJson.bin
        : packageJson.bin?.tsx;
    if (!binEntry) {
      throw new Error("Unable to resolve the tsx CLI entrypoint.");
    }
    return path.join(path.dirname(packageJsonPath), binEntry);
  }
}

function sanitizeEnvironmentVariables(
  variables: Record<string, string | undefined>,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(variables)) {
    if (value) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function buildServiceId(storageRoot: string): string {
  const basename = path.basename(storageRoot) || "codex-anywhere";
  const slug = basename
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const hash = createHash("sha256").update(storageRoot).digest("hex").slice(0, 12);
  return slug ? `${slug}-${hash}` : hash;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function quoteSystemdValue(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function quoteSystemdEnv(key: string, value: string): string {
  return `${quoteSystemdValue(`${key}=${value}`)}`;
}

function escapeSystemdSettingValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(" ", "\\ ");
}

async function runLaunchctl(
  execFile: ServiceExecFile,
  args: string[],
  options: { ignoreFailure?: boolean } = {},
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const result = await execFile("launchctl", args, {
      env: process.env,
    });
    return {
      ok: true,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const stdout = extractProcessOutput(error, "stdout");
    const stderr = extractProcessOutput(error, "stderr");
    if (options.ignoreFailure) {
      return {
        ok: false,
        stdout,
        stderr,
      };
    }
    throw new Error(formatLaunchctlError(args, stderr || stdout));
  }
}

function extractProcessOutput(
  error: unknown,
  key: "stdout" | "stderr",
): string {
  if (!error || typeof error !== "object" || !(key in error)) {
    return "";
  }
  const value = error[key as keyof typeof error];
  return typeof value === "string" ? value : "";
}

function formatLaunchctlError(args: string[], output: string): string {
  const suffix = output.trim() ? `: ${output.trim()}` : "";
  return `launchctl ${args.join(" ")} failed${suffix}`;
}

async function runSystemctl(
  execFile: ServiceExecFile,
  args: string[],
  options: { ignoreFailure?: boolean } = {},
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const result = await execFile("systemctl", args, {
      env: process.env,
    });
    return {
      ok: true,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const stdout = extractProcessOutput(error, "stdout");
    const stderr = extractProcessOutput(error, "stderr");
    if (options.ignoreFailure) {
      return {
        ok: false,
        stdout,
        stderr,
      };
    }
    throw new Error(formatSystemctlError(args, stderr || stdout));
  }
}

function formatSystemctlError(args: string[], output: string): string {
  const suffix = output.trim() ? `: ${output.trim()}` : "";
  return `systemctl ${args.join(" ")} failed${suffix}`;
}
