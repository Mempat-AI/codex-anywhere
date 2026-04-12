import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildLinuxSystemdUserServiceSpec,
  buildMacosLaunchAgentSpec,
  renderLinuxSystemdUnit,
  renderLaunchAgentPlist,
  resolveServiceProgramArguments,
  runBackgroundServiceCommand,
} from "../src/service.js";

test("buildMacosLaunchAgentSpec uses a stable storage-root-backed label", () => {
  const spec = buildMacosLaunchAgentSpec({
    repoCwd: "/Users/alice/works/codex-anywhere",
    storageRoot: "/Users/alice/.config/codex-anywhere/workspaces/codex-anywhere-7b81419410a5",
    homeDir: "/Users/alice",
    uid: 501,
    pathEnv: "/opt/homebrew/bin:/usr/bin:/bin",
    programArguments: [
      "/opt/homebrew/bin/node",
      "/Users/alice/works/codex-anywhere/node_modules/tsx/dist/cli.mjs",
      "/Users/alice/works/codex-anywhere/src/cli.ts",
      "connect",
    ],
    extraEnv: {
      HOME: "/Users/alice",
      LANG: "en_US.UTF-8",
    },
  });

  assert.match(spec.label, /^ai\.mempat\.codex-anywhere\./);
  assert.equal(
    spec.plistPath,
    `/Users/alice/Library/LaunchAgents/${spec.label}.plist`,
  );
  assert.match(spec.label, /codex-anywhere-7b81419410a5-[0-9a-f]{12}$/);
  assert.equal(spec.workingDirectory, "/Users/alice/works/codex-anywhere");
  assert.deepEqual(spec.programArguments, [
    "/opt/homebrew/bin/node",
    "/Users/alice/works/codex-anywhere/node_modules/tsx/dist/cli.mjs",
    "/Users/alice/works/codex-anywhere/src/cli.ts",
    "connect",
  ]);
  assert.equal(
    spec.environmentVariables.CODEX_ANYWHERE_HOME,
    "/Users/alice/.config/codex-anywhere/workspaces/codex-anywhere-7b81419410a5",
  );
});

test("renderLaunchAgentPlist includes keepalive and launchd paths", () => {
  const spec = buildMacosLaunchAgentSpec({
    repoCwd: "/Users/alice/works/codex-anywhere",
    storageRoot: "/Users/alice/.config/codex-anywhere/workspaces/codex-anywhere-7b81419410a5",
    homeDir: "/Users/alice",
    uid: 501,
    pathEnv: "/opt/homebrew/bin:/usr/bin:/bin",
    programArguments: [
      "/opt/homebrew/bin/node",
      "/Users/alice/works/codex-anywhere/dist/cli.js",
      "connect",
    ],
  });

  const plist = renderLaunchAgentPlist(spec);

  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>CODEX_ANYWHERE_HOME<\/key>/);
  assert.match(plist, /launchd\.stdout\.log/);
  assert.match(plist, /launchd\.stderr\.log/);
});

test("buildLinuxSystemdUserServiceSpec uses a stable storage-root-backed unit path", () => {
  const spec = buildLinuxSystemdUserServiceSpec({
    repoCwd: "/home/alice/works/codex-anywhere",
    storageRoot: "/home/alice/.config/codex-anywhere/workspaces/codex-anywhere-7b81419410a5",
    homeDir: "/home/alice",
    pathEnv: "/usr/local/bin:/usr/bin:/bin",
    programArguments: [
      "/usr/bin/node",
      "/home/alice/works/codex-anywhere/dist/cli.js",
      "connect",
    ],
    extraEnv: {
      HOME: "/home/alice",
      LANG: "en_US.UTF-8",
    },
  });

  assert.match(spec.label, /^ai\.mempat\.codex-anywhere\./);
  assert.equal(
    spec.unitPath,
    `/home/alice/.config/systemd/user/${spec.serviceName}`,
  );
  assert.match(spec.serviceName, /^ai\.mempat\.codex-anywhere\..+\.service$/);
  assert.equal(spec.workingDirectory, "/home/alice/works/codex-anywhere");
  assert.equal(
    spec.environmentVariables.CODEX_ANYWHERE_HOME,
    "/home/alice/.config/codex-anywhere/workspaces/codex-anywhere-7b81419410a5",
  );
});

test("renderLinuxSystemdUnit includes restart policy, environment, and log paths", () => {
  const spec = buildLinuxSystemdUserServiceSpec({
    repoCwd: "/home/alice/works/codex-anywhere",
    storageRoot: "/home/alice/.config/codex-anywhere/workspaces/codex-anywhere-7b81419410a5",
    homeDir: "/home/alice",
    pathEnv: "/usr/local/bin:/usr/bin:/bin",
    programArguments: [
      "/usr/bin/node",
      "/home/alice/works/codex-anywhere/dist/cli.js",
      "connect",
    ],
  });

  const unit = renderLinuxSystemdUnit(spec);

  assert.match(unit, /^Description=Codex Anywhere background bridge/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^WorkingDirectory=\/home\/alice\/works\/codex-anywhere$/m);
  assert.match(unit, /^Environment="CODEX_ANYWHERE_HOME=/m);
  assert.match(unit, /^StandardOutput=append:\/home\/alice\/.*systemd\.stdout\.log$/m);
  assert.match(unit, /^StandardError=append:\/home\/alice\/.*systemd\.stderr\.log$/m);
});

test("resolveServiceProgramArguments prefers source mode when src/cli.ts exists", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-anywhere-service-program-src-"));
  await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
  await fs.writeFile(path.join(tempDir, "src", "cli.ts"), "// src\n", "utf8");

  const programArguments = await resolveServiceProgramArguments({
    packageRoot: tempDir,
    nodePath: "/opt/homebrew/bin/node",
    tsxCliPath: "/tmp/tsx-cli.mjs",
  });

  assert.deepEqual(programArguments, [
    "/opt/homebrew/bin/node",
    "/tmp/tsx-cli.mjs",
    path.join(tempDir, "src", "cli.ts"),
    "connect",
  ]);
});

test("resolveServiceProgramArguments uses dist/cli.js when source files are absent", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-anywhere-service-program-dist-"));
  await fs.mkdir(path.join(tempDir, "dist"), { recursive: true });
  await fs.writeFile(path.join(tempDir, "dist", "cli.js"), "// dist\n", "utf8");

  const programArguments = await resolveServiceProgramArguments({
    packageRoot: tempDir,
    nodePath: "/opt/homebrew/bin/node",
    tsxCliPath: "/tmp/tsx-cli.mjs",
  });

  assert.deepEqual(programArguments, [
    "/opt/homebrew/bin/node",
    path.join(tempDir, "dist", "cli.js"),
    "connect",
  ]);
});

test("install-service prepares config, writes a plist, and bootstraps launchctl", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-anywhere-service-install-"));
  const homeDir = path.join(tempDir, "home");
  const repoDir = path.join(tempDir, "repo");
  const storageRoot = path.join(tempDir, "storage");
  const storagePaths = {
    configPath: path.join(storageRoot, "config.json"),
    statePath: path.join(storageRoot, "state.json"),
  };
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(repoDir, { recursive: true });

  const launchctlCalls: string[][] = [];
  const savedLogs: string[] = [];

  await runBackgroundServiceCommand("install-service", {
    cwd: repoDir,
    env: {
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      HOME: homeDir,
      USER: "alice",
    },
    platform: "darwin",
    homeDir,
    uid: 501,
    storagePaths,
    nodePath: "/opt/homebrew/bin/node",
    tsxCliPath: "/tmp/tsx-cli.mjs",
    loadConfig: async () => null,
    saveConfig: async (configPath, config) => {
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify(config), "utf8");
    },
    runSetupWizard: async () => ({
      version: 1,
      telegramBotToken: "token",
      workspaceCwd: "/Users/alice/workspace",
      ownerUserId: null,
      pollTimeoutSeconds: 20,
      streamEditIntervalMs: 1500,
    }),
    runPreflightChecks: async () => {},
    execFile: async (file, args) => {
      assert.equal(file, "launchctl");
      launchctlCalls.push(args);
      return { stdout: "", stderr: "" };
    },
    log: (message) => {
      savedLogs.push(message);
    },
  });

  const plistFiles = await fs.readdir(path.join(homeDir, "Library", "LaunchAgents"));
  assert.equal(plistFiles.length, 1);
  const plistPath = path.join(homeDir, "Library", "LaunchAgents", plistFiles[0]!);
  const plist = await fs.readFile(plistPath, "utf8");
  assert.match(plist, /<key>Label<\/key>/);
  assert.match(plist, /<string>\/opt\/homebrew\/bin\/node<\/string>/);
  assert.match(plist, /<string>\/tmp\/tsx-cli\.mjs<\/string>/);
  assert.deepEqual(launchctlCalls, [
    ["enable", `gui/501/${plistFiles[0]!.replace(/\.plist$/, "")}`],
    ["bootout", "gui/501", plistPath],
    ["bootstrap", "gui/501", plistPath],
    ["kickstart", "-k", `gui/501/${plistFiles[0]!.replace(/\.plist$/, "")}`],
  ]);
  assert.match(savedLogs.join("\n"), /Installed LaunchAgent/);
});

test("install-service on linux writes a user unit and enables it", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-anywhere-service-install-linux-"));
  const homeDir = path.join(tempDir, "home");
  const repoDir = path.join(tempDir, "repo");
  const storageRoot = path.join(tempDir, "storage");
  const storagePaths = {
    configPath: path.join(storageRoot, "config.json"),
    statePath: path.join(storageRoot, "state.json"),
  };
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(repoDir, { recursive: true });

  const systemctlCalls: string[][] = [];
  const savedLogs: string[] = [];

  await runBackgroundServiceCommand("install-service", {
    cwd: repoDir,
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: homeDir,
      USER: "alice",
    },
    platform: "linux",
    homeDir,
    storagePaths,
    nodePath: "/usr/bin/node",
    tsxCliPath: "/tmp/tsx-cli.mjs",
    loadConfig: async () => null,
    saveConfig: async (configPath, config) => {
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify(config), "utf8");
    },
    runSetupWizard: async () => ({
      version: 1,
      telegramBotToken: "token",
      workspaceCwd: "/home/alice/workspace",
      ownerUserId: null,
      pollTimeoutSeconds: 20,
      streamEditIntervalMs: 1500,
    }),
    runPreflightChecks: async () => {},
    execFile: async (file, args) => {
      assert.equal(file, "systemctl");
      systemctlCalls.push(args);
      return { stdout: "", stderr: "" };
    },
    log: (message) => {
      savedLogs.push(message);
    },
  });

  const unitDir = path.join(homeDir, ".config", "systemd", "user");
  const unitFiles = await fs.readdir(unitDir);
  assert.equal(unitFiles.length, 1);
  const unitPath = path.join(unitDir, unitFiles[0]!);
  const unit = await fs.readFile(unitPath, "utf8");
  assert.match(unit, /^ExecStart="\/usr\/bin\/node" "\/tmp\/tsx-cli\.mjs"/m);
  assert.match(unit, /^Restart=always$/m);
  assert.deepEqual(systemctlCalls, [
    ["--user", "daemon-reload"],
    ["--user", "enable", "--now", unitFiles[0]!],
  ]);
  assert.match(savedLogs.join("\n"), /Installed systemd user service/);
});

test("service-status lists configured multi-bot definitions", async () => {
  const logs: string[] = [];

  await runBackgroundServiceCommand("service-status", {
    platform: "darwin",
    homeDir: "/tmp/home",
    uid: 501,
    storagePaths: {
      configPath: "/tmp/codex-anywhere/config.json",
      statePath: "/tmp/codex-anywhere/state.json",
    },
    loadConfig: async () => ({
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
        {
          id: "bot-b",
          label: "Bot B",
          telegramBotToken: "token-b",
          workspaceCwd: "/tmp/workspace-b",
          ownerUserId: 1,
          pollTimeoutSeconds: 20,
          streamEditIntervalMs: 1500,
        },
      ],
    }),
    execFile: async () => ({ stdout: "", stderr: "" }),
    log: (message) => {
      logs.push(message);
    },
  });

  const combined = logs.join("\n");
  assert.match(combined, /configured-bots: 2/);
  assert.match(combined, /bot bot-a: workspace=\/tmp\/workspace-a/);
  assert.match(combined, /bot bot-b: workspace=\/tmp\/workspace-b/);
});
