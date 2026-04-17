import assert from "node:assert/strict";
import test from "node:test";

import {
  codexSlashHelpText,
  isRecognizedCodexSlashCommand,
  normalizeApprovalPolicy,
  normalizeReasoningEffort,
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
  assert.equal(isRecognizedCodexSlashCommand("model"), true);
  assert.equal(isRecognizedCodexSlashCommand("plan"), true);
  assert.equal(isRecognizedCodexSlashCommand("definitely-not-a-command"), false);
});

test("normalizeApprovalPolicy accepts common aliases", () => {
  assert.equal(normalizeApprovalPolicy("unless-trusted"), "untrusted");
  assert.equal(normalizeApprovalPolicy("on_request"), "on-request");
  assert.equal(normalizeApprovalPolicy("bad"), null);
});

test("normalizeReasoningEffort only accepts supported values", () => {
  assert.equal(normalizeReasoningEffort("high"), "high");
  assert.equal(normalizeReasoningEffort("minimal"), "minimal");
  assert.equal(normalizeReasoningEffort("extreme"), null);
});

test("codexSlashHelpText mentions /omx bridge support", () => {
  assert.match(codexSlashHelpText(), /\/omx \[args]/);
});

test("codexSlashHelpText mentions /computer plugin support", () => {
  assert.match(codexSlashHelpText(), /\/computer <task>/);
  assert.match(codexSlashHelpText(), /Computer Use must be enabled from the Codex app/);
});
