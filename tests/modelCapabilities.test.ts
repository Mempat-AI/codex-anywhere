import assert from "node:assert/strict";
import test from "node:test";

import {
  modelReasoningEfforts,
  normalizeReasoningEffortValue,
  reasoningEffortUsageForModel,
} from "../src/modelCapabilities.js";

test("modelReasoningEfforts reads Codex supportedReasoningEfforts metadata", () => {
  assert.deepEqual(
    modelReasoningEfforts({
      model: "gpt-5.4",
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Fast" },
        { reasoningEffort: "xhigh", description: "Deep" },
      ],
    }),
    [
      { value: "low", label: "Low", description: "Fast" },
      { value: "xhigh", label: "X-High", description: "Deep" },
    ],
  );
});

test("normalizeReasoningEffortValue normalizes display aliases without enforcing a fixed enum", () => {
  assert.equal(normalizeReasoningEffortValue("X-High"), "xhigh");
  assert.equal(normalizeReasoningEffortValue("x_high"), "xhigh");
  assert.equal(normalizeReasoningEffortValue("custom-effort"), "customeffort");
});

test("reasoningEffortUsageForModel reports missing metadata conservatively", () => {
  assert.equal(reasoningEffortUsageForModel({ model: "legacy" }), "no advertised reasoning-effort options");
});
