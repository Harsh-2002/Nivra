import assert from "node:assert/strict";
import test from "node:test";
import {
  createBrowserCspDiagnostics,
  webkitNativeSelectCspConsoleMessage,
} from "../scripts/browser-csp-diagnostics.mjs";

const origin = "http://localhost:3015";
type Diagnostics = ReturnType<typeof createBrowserCspDiagnostics>;
type Evidence = {
  token?: unknown;
  documentId: string;
  eventId: number;
  observedAt: number;
  pathname: string;
  trusted: unknown;
  effectiveDirective: string;
  blockedURI: string;
  targetTag: string;
  appOwnedClass: boolean;
  ariaHidden: string | null;
  tabIndex: number;
  hasStyleAttribute: boolean;
};

function validEvidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    documentId: "9b63dc347bb84a19a58534c68b05ae61",
    eventId: 0,
    observedAt: 1000,
    pathname: "/tasks",
    trusted: true,
    effectiveDirective: "style-src-attr",
    blockedURI: "inline",
    targetTag: "SELECT",
    appOwnedClass: true,
    ariaHidden: "true",
    tabIndex: -1,
    hasStyleAttribute: false,
    ...overrides,
  };
}

function makeDiagnostics(
  options: {
    engine?: "chromium" | "firefox" | "webkit";
    recordLimit?: number;
  } = {},
): Diagnostics {
  return createBrowserCspDiagnostics({
    engine: "webkit",
    origin,
    now: () => 1000,
    quietWindowMs: 0,
    ...options,
  });
}

function observeWarning(
  diagnostics: Diagnostics,
  pathname = "/tasks",
  observedAt = 1001,
): boolean {
  return diagnostics.deferConsole({
    type: "error",
    text: webkitNativeSelectCspConsoleMessage,
    locationUrl: `${origin}${pathname}`,
    observedAt,
  });
}

test("pairs one exact WebKit CSP warning with trusted hidden-select evidence", async () => {
  const diagnostics = makeDiagnostics();
  diagnostics.observeViolation(validEvidence(), {
    sourceValid: true,
    tokenValid: true,
  });
  assert.equal(observeWarning(diagnostics), true);
  await diagnostics.flush();
  assert.deepEqual(diagnostics.result(), { matchedCount: 1, errors: [] });
});

test("keeps exact warnings fatal when evidence is absent or document context is missing", async () => {
  const missing = makeDiagnostics();
  assert.equal(
    missing.deferConsole({
      type: "error",
      text: webkitNativeSelectCspConsoleMessage,
      locationUrl: "",
      observedAt: 1000,
    }),
    true,
  );
  await missing.flush();
  assert.equal(missing.result().matchedCount, 0);
  assert.ok(missing.result().errors.length > 0);

  const absent = makeDiagnostics();
  observeWarning(absent);
  await absent.flush();
  assert.equal(absent.result().matchedCount, 0);
  assert.match(absent.result().errors.join(" "), /no one-to-one/);
});

test("requires a bounded timestamp and the exact console document pathname", async () => {
  const mismatches: Array<[string, number]> = [
    ["/calendar", 1001],
    ["/tasks", 4000],
  ];
  for (const [pathname, observedAt] of mismatches) {
    const diagnostics = makeDiagnostics();
    diagnostics.observeViolation(validEvidence({ pathname, observedAt }), {
      sourceValid: true,
      tokenValid: true,
    });
    observeWarning(diagnostics, "/tasks", 1001);
    await diagnostics.flush();
    assert.equal(diagnostics.result().matchedCount, 0);
    assert.match(diagnostics.result().errors.join(" "), /no one-to-one/);
  }
});

test("does not defer similar console errors, other message types, or non-WebKit warnings", () => {
  const webkitDiagnostics = makeDiagnostics();
  assert.equal(
    webkitDiagnostics.deferConsole({
      type: "error",
      text: `${webkitNativeSelectCspConsoleMessage} extra`,
      locationUrl: `${origin}/tasks`,
    }),
    false,
  );
  assert.equal(
    webkitDiagnostics.deferConsole({
      type: "warning",
      text: webkitNativeSelectCspConsoleMessage,
      locationUrl: `${origin}/tasks`,
    }),
    false,
  );

  const chromiumDiagnostics = makeDiagnostics({ engine: "chromium" });
  assert.equal(observeWarning(chromiumDiagnostics), false);
  assert.equal(chromiumDiagnostics.result().matchedCount, 0);
});

test("rejects non-select, stylesheet, unknown-class, styled, and untrusted evidence", async (t) => {
  const cases: Array<readonly [string, Partial<Evidence>]> = [
    ["style-src-elem", { effectiveDirective: "style-src-elem" }],
    ["non-inline source", { blockedURI: "https://example.test/a.css" }],
    ["non-select target", { targetTag: "STYLE" }],
    ["unknown class", { appOwnedClass: false }],
    ["visible select", { ariaHidden: null, tabIndex: 0 }],
    ["authored style", { hasStyleAttribute: true }],
    ["untrusted event", { trusted: false }],
  ];

  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      const diagnostics = makeDiagnostics();
      diagnostics.observeViolation(validEvidence(overrides), {
        sourceValid: true,
        tokenValid: true,
      });
      observeWarning(diagnostics);
      await diagnostics.flush();
      assert.equal(diagnostics.result().matchedCount, 0);
      assert.ok(diagnostics.result().errors.length > 0);
    });
  }
});

test("requires trusted same-page binding context and the per-run token", async () => {
  for (const context of [
    { sourceValid: false, tokenValid: true },
    { sourceValid: true, tokenValid: false },
  ]) {
    const diagnostics = makeDiagnostics();
    diagnostics.observeViolation(validEvidence(), context);
    observeWarning(diagnostics);
    await diagnostics.flush();
    assert.equal(diagnostics.result().matchedCount, 0);
    assert.ok(diagnostics.result().errors.length > 0);
  }
});

test("treats every CSP violation from another browser engine as fatal", () => {
  const diagnostics = makeDiagnostics({ engine: "chromium" });
  diagnostics.observeViolation(validEvidence(), {
    sourceValid: true,
    tokenValid: true,
  });
  assert.match(diagnostics.result().errors.join(" "), /outside WebKit/);
});

test("evidence is one-use; a cloned event cannot consume a second warning", async () => {
  const diagnostics = makeDiagnostics();
  const evidence = validEvidence();
  diagnostics.observeViolation(evidence, {
    sourceValid: true,
    tokenValid: true,
  });
  diagnostics.observeViolation(evidence, {
    sourceValid: true,
    tokenValid: true,
  });
  observeWarning(diagnostics);
  observeWarning(diagnostics);
  await diagnostics.flush();

  assert.equal(diagnostics.result().matchedCount, 1);
  assert.match(diagnostics.result().errors.join(" "), /Duplicate/);
  assert.match(diagnostics.result().errors.join(" "), /no one-to-one/);
});

test("bounds diagnostic records and fails closed on overflow", async () => {
  const diagnostics = makeDiagnostics({ recordLimit: 1 });
  observeWarning(diagnostics);
  observeWarning(diagnostics);
  await diagnostics.flush();
  assert.equal(diagnostics.result().matchedCount, 0);
  assert.match(
    diagnostics.result().errors.join(" "),
    /exceeded the diagnostic bound/,
  );
});
