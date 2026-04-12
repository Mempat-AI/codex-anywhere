import assert from "node:assert/strict";
import test from "node:test";

import {
  formatSessionCallbackData,
  parseSessionCallbackData,
} from "../src/sessions.js";

test("session callback data round-trips", () => {
  const encoded = formatSessionCallbackData(
    "takeover",
    "019d6fef-786e-74a1-a59b-400820c026b0",
  );
  assert.equal(encoded, "ses:takeover:019d6fef-786e-74a1-a59b-400820c026b0");
  assert.deepEqual(parseSessionCallbackData(encoded), {
    action: "takeover",
    value: "019d6fef-786e-74a1-a59b-400820c026b0",
  });
});

test("session pagination callback data round-trips", () => {
  const encoded = formatSessionCallbackData("more", "token-1234");
  assert.equal(encoded, "ses:more:token-1234");
  assert.deepEqual(parseSessionCallbackData(encoded), {
    action: "more",
    value: "token-1234",
  });
});

test("session callback parser rejects invalid payloads", () => {
  assert.equal(parseSessionCallbackData("bad"), null);
  assert.equal(parseSessionCallbackData("ses:noop:thread"), null);
  assert.equal(parseSessionCallbackData("ses:takeover:"), null);
});
