import assert from "node:assert/strict";
import test from "node:test";

import {
  buildApprovalPolicyInteractiveSession,
  buildExperimentalInteractiveSession,
  buildFastInteractiveSession,
  buildSandboxInteractiveSession,
  buildLocalInteractiveFollowUpSteps,
  buildModelInteractiveSession,
  buildReviewInteractiveSession,
  buildVerboseInteractiveSession,
} from "../src/localCommandInteractions.js";

test("buildModelInteractiveSession includes reset and available models", () => {
  const session = buildModelInteractiveSession(
    [
      { model: "gpt-5.4", isDefault: true },
      { model: "gpt-5.4-mini", isDefault: false },
    ],
    {
      threadId: null,
      activeTurnId: null,
      verbose: false,
      queueNextArmed: false,
      queuedTurnInput: null,
      pendingTurnInput: null,
      model: "gpt-5.4",
      reasoningEffort: "high",
      personality: null,
      collaborationModeName: null,
      collaborationMode: null,
      serviceTier: null,
      approvalPolicy: null,
      sandboxMode: null,
      lastAssistantMessage: null,
    },
  );

  assert.ok(session);
  assert.equal(session?.steps[0]?.key, "model");
  assert.equal(session?.steps[0]?.options?.[0]?.value, "__reset__");
  assert.equal(session?.meta.command, "model");
});

test("buildLocalInteractiveFollowUpSteps adds model effort step", () => {
  assert.deepEqual(buildLocalInteractiveFollowUpSteps("model", { model: "__reset__" }), []);
  assert.equal(
    buildLocalInteractiveFollowUpSteps("model", { model: "gpt-5.4" }, {
      models: [
        {
          model: "gpt-5.4",
          supportedReasoningEfforts: [
            { reasoningEffort: "low" },
            { reasoningEffort: "xhigh" },
          ],
        },
      ],
    })[0]?.key,
    "reasoningEffort",
  );
});

test("buildLocalInteractiveFollowUpSteps uses model-advertised effort options", () => {
  const step = buildLocalInteractiveFollowUpSteps("model", { model: "gpt-5.4" }, {
    models: [
      {
        model: "gpt-5.4",
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Fast" },
          { reasoningEffort: "xhigh", description: "Deep" },
        ],
      },
    ],
  })[0];

  assert.deepEqual(step?.options?.map((option) => option.value), [
    "__default__",
    "low",
    "xhigh",
  ]);
  assert.match(step?.options?.[2]?.label ?? "", /X-High/);
});

test("buildExperimentalInteractiveSession builds feature choices", () => {
  const session = buildExperimentalInteractiveSession([
    { name: "foo", enabled: true, stage: "beta" },
  ]);

  assert.ok(session);
  assert.equal(session?.steps[0]?.key, "featureName");
  assert.equal(session?.meta.command, "experimental");
});

test("buildLocalInteractiveFollowUpSteps adds review detail prompt", () => {
  assert.deepEqual(
    buildLocalInteractiveFollowUpSteps("review", { targetKind: "uncommittedChanges" }),
    [],
  );
  assert.equal(
    buildLocalInteractiveFollowUpSteps("review", { targetKind: "commit" })[0]?.key,
    "targetValue",
  );
});

test("simple slash command sessions expose expected keys", () => {
  const fast = buildFastInteractiveSession({
    threadId: null,
    activeTurnId: null,
    verbose: false,
    queueNextArmed: false,
    queuedTurnInput: null,
    pendingTurnInput: null,
    model: null,
    reasoningEffort: null,
    personality: null,
    collaborationModeName: null,
    collaborationMode: null,
    serviceTier: "fast",
    approvalPolicy: null,
    sandboxMode: null,
    lastAssistantMessage: null,
  });
  const approvals = buildApprovalPolicyInteractiveSession({
    threadId: null,
    activeTurnId: null,
    verbose: false,
    queueNextArmed: false,
    queuedTurnInput: null,
    pendingTurnInput: null,
    model: null,
    reasoningEffort: null,
    personality: null,
    collaborationModeName: null,
    collaborationMode: null,
    serviceTier: null,
    approvalPolicy: "on-request",
    sandboxMode: null,
    lastAssistantMessage: null,
  });
  const sandbox = buildSandboxInteractiveSession({
    threadId: null,
    activeTurnId: null,
    verbose: false,
    queueNextArmed: false,
    queuedTurnInput: null,
    pendingTurnInput: null,
    model: null,
    reasoningEffort: null,
    personality: null,
    collaborationModeName: null,
    collaborationMode: null,
    serviceTier: null,
    approvalPolicy: null,
    sandboxMode: "read-only",
    lastAssistantMessage: null,
  });
  const review = buildReviewInteractiveSession();
  const verbose = buildVerboseInteractiveSession({
    threadId: null,
    activeTurnId: null,
    verbose: false,
    queueNextArmed: false,
    queuedTurnInput: null,
    pendingTurnInput: null,
    model: null,
    reasoningEffort: null,
    personality: null,
    collaborationModeName: null,
    collaborationMode: null,
    serviceTier: null,
    approvalPolicy: null,
    sandboxMode: null,
    lastAssistantMessage: null,
  });

  assert.equal(fast.meta.command, "fast");
  assert.equal(approvals.meta.command, "permissions");
  assert.equal(sandbox.meta.command, "sandbox");
  assert.equal(review.meta.command, "review");
  assert.equal(verbose.meta.command, "verbose");
});
