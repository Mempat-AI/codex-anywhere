import assert from "node:assert/strict";
import test from "node:test";

import {
  codexSlashHelpText,
  isRecognizedCodexSlashCommand,
  normalizeApprovalPolicy,
  normalizeReasoningEffort,
  normalizeSandboxMode,
  parseTelegramSlashCommand,
} from "../src/slashCommands.js";

test("parseTelegramSlashCommand handles bot mentions and args", () => {
  assert.deepEqual(parseTelegramSlashCommand("/model@codexanywhere gpt-5.4 high"), {
    name: "model",
    args: "gpt-5.4 high",
  });
});

test("parseTelegramSlashCommand returns null for plain text", () => {
  assert.equal(parseTelegramSlashCommand("fix tests"), null);
});

test("recognized Codex slash commands include supported and unsupported names", () => {
  assert.equal(isRecognizedCodexSlashCommand("goal"), true);
  assert.equal(isRecognizedCodexSlashCommand("model"), true);
  assert.equal(isRecognizedCodexSlashCommand("plan"), true);
  assert.equal(isRecognizedCodexSlashCommand("reload"), true);
  assert.equal(isRecognizedCodexSlashCommand("upgrade"), true);
  assert.equal(isRecognizedCodexSlashCommand("version"), true);
  assert.equal(isRecognizedCodexSlashCommand("definitely-not-a-command"), false);
});

test("normalizeApprovalPolicy accepts common aliases", () => {
  assert.equal(normalizeApprovalPolicy("unless-trusted"), "untrusted");
  assert.equal(normalizeApprovalPolicy("on_request"), "on-request");
  assert.equal(normalizeApprovalPolicy("bad"), null);
});

test("normalizeSandboxMode accepts common aliases", () => {
  assert.equal(normalizeSandboxMode("readonly"), "read-only");
  assert.equal(normalizeSandboxMode("workspace_write"), "workspace-write");
  assert.equal(normalizeSandboxMode("danger"), "danger-full-access");
  assert.equal(normalizeSandboxMode("bad"), null);
});

test("normalizeReasoningEffort only accepts supported values", () => {
  assert.equal(normalizeReasoningEffort("high"), "high");
  assert.equal(normalizeReasoningEffort("minimal"), "minimal");
  assert.equal(normalizeReasoningEffort("extreme"), null);
});

test("codexSlashHelpText mentions /omx bridge support", () => {
  assert.match(codexSlashHelpText(), /\/omx \[args]/);
});

test("codexSlashHelpText mentions /sandbox support", () => {
  assert.match(codexSlashHelpText(), /\/sandbox \[status\|read-only\|workspace-write\|danger-full-access]/);
});

test("codexSlashHelpText mentions /computer plugin support", () => {
  assert.match(codexSlashHelpText(), /\/computer <task>/);
  assert.match(codexSlashHelpText(), /Computer Use must be enabled from the Codex app/);
});

test("codexSlashHelpText mentions /version support", () => {
  assert.match(codexSlashHelpText(), /\/version/);
});

test("codexSlashHelpText mentions /reload support", () => {
  assert.match(codexSlashHelpText(), /\/reload/);
});

test("codexSlashHelpText mentions /upgrade support", () => {
  assert.match(codexSlashHelpText(), /\/upgrade/);
});

test("codexSlashHelpText mentions /goal support", () => {
  assert.match(codexSlashHelpText(), /\/goal \[status\|set <objective>\|clear]/);
});

test("codexSlashHelpText mentions /account support", () => {
  assert.equal(isRecognizedCodexSlashCommand("account"), true);
  assert.match(codexSlashHelpText(), /\/account \[status\|login\|switch\|logout]/);
});
