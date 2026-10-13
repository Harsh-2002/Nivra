import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyConsoleMessage,
  ignoredWebKitViewportWarning,
} from "../scripts/browser-diagnostics.mjs";

test("only WebKit's exact ignored interactive-widget warning is classified separately", () => {
  assert.equal(
    classifyConsoleMessage("webkit", "error", ignoredWebKitViewportWarning),
    "unsupported-feature-warning",
  );
  assert.equal(
    classifyConsoleMessage("webkit", "warning", ignoredWebKitViewportWarning),
    "unsupported-feature-warning",
  );

  for (const engine of ["chromium", "firefox"]) {
    assert.equal(
      classifyConsoleMessage(engine, "error", ignoredWebKitViewportWarning),
      "error",
    );
  }

  for (const message of [
    'Viewport argument key "interactive-widgets" not recognized and ignored.',
    'Viewport argument key "interactive-widget" not recognized.',
    `Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script`,
    "Fetch API cannot load http://localhost:3015/api/v1/tags due to access control checks.",
  ]) {
    assert.equal(classifyConsoleMessage("webkit", "error", message), "error");
  }

  assert.equal(
    classifyConsoleMessage("webkit", "warning", "Unrelated browser warning."),
    "other",
  );
});
