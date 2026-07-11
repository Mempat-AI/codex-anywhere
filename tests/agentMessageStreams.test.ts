import assert from "node:assert/strict";
import test from "node:test";

import { agentStreamKey, streamGroupId } from "../src/agentMessageStreams.js";

test("streamGroupId keeps each commentary preamble in its own stream group", () => {
  assert.equal(streamGroupId("item-1", "commentary"), "item-1");
  assert.equal(streamGroupId("item-2", "final_answer"), "item-2");
});

test("agentStreamKey keeps preambles and final answers item-scoped", () => {
  assert.equal(
    agentStreamKey("thread-1", "turn-1", streamGroupId("item-1", "commentary")),
    "thread-1:turn-1:item-1",
  );
  assert.equal(
    agentStreamKey("thread-1", "turn-1", streamGroupId("item-2", "final_answer")),
    "thread-1:turn-1:item-2",
  );
});
