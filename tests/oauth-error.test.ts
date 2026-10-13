import { test } from "node:test";
import assert from "node:assert/strict";
import { oauthErrorMessage } from "../src/lib/oauth-error";

test("OAuth errors use fixed, actionable messages for known codes", () => {
  assert.deepEqual(oauthErrorMessage("invalid_client"), {
    title: "Couldn’t verify this client registration",
    description: "Restart the connection from your MCP client.",
  });
  assert.deepEqual(oauthErrorMessage("invalid_request"), {
    title: "The connection request is incomplete",
    description: "Restart the connection from your MCP client.",
  });
});

test("unknown and provider-controlled errors use one generic message", () => {
  const generic = {
    title: "This connection could not continue",
    description: "Start a new connection from your MCP client.",
  };

  assert.deepEqual(oauthErrorMessage("provider-private-detail"), generic);
  assert.deepEqual(oauthErrorMessage("client_id=untrusted-value"), generic);
  assert.deepEqual(oauthErrorMessage(undefined), generic);
  assert.deepEqual(oauthErrorMessage(["invalid_client"]), generic);
});
