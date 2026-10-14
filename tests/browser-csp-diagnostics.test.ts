import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { request } from "playwright";
import {
  createBrowserCspDiagnostics,
  createNativeSelectSourceVerifier,
  isNativeSelectConstructorAt,
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
  targetNodeType: number;
  targetTag: string | null;
  appOwnedClass: boolean;
  ariaHidden: string | null;
  tabIndex: number | null;
  hasStyleAttribute: boolean;
  sourceFile?: string;
  lineNumber?: number;
  columnNumber?: number;
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
    targetNodeType: 1,
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

test("pairs document-target evidence only at the exact native select constructor", async () => {
  const diagnostics = makeDiagnostics();
  diagnostics.observeViolation(
    validEvidence({
      targetNodeType: 9,
      targetTag: null,
      appOwnedClass: false,
      ariaHidden: null,
      tabIndex: null,
    }),
    {
      sourceValid: true,
      tokenValid: true,
      nativeSelectConstructorValid: true,
    },
  );
  observeWarning(diagnostics);
  await diagnostics.flush();
  assert.deepEqual(diagnostics.result(), { matchedCount: 1, errors: [] });

  const unverified = makeDiagnostics();
  unverified.observeViolation(
    validEvidence({
      targetNodeType: 9,
      targetTag: null,
      appOwnedClass: false,
      ariaHidden: null,
      tabIndex: null,
    }),
    { sourceValid: true, tokenValid: true },
  );
  observeWarning(unverified);
  await unverified.flush();
  assert.equal(unverified.result().matchedCount, 0);
  assert.match(
    unverified.result().errors.join(" "),
    /verified WebKit constructor/,
  );
});

test("checks native select constructor locations exactly", () => {
  const source =
    'case"select":a=o.createElement("select",{is:r.is}):o.createElement("select"),r.multiple=a.multiple=!0';
  const firstOpen =
    source.indexOf('createElement("select"') + "createElement".length;
  const secondOpen =
    source.indexOf('createElement("select")', firstOpen) +
    "createElement".length;
  assert.equal(isNativeSelectConstructorAt(source, 1, firstOpen + 1), true);
  assert.equal(isNativeSelectConstructorAt(source, 1, secondOpen + 1), true);
  assert.equal(isNativeSelectConstructorAt(source, 1, firstOpen + 2), false);
  assert.equal(isNativeSelectConstructorAt(source, 1, 1), false);
  assert.equal(
    isNativeSelectConstructorAt('x.createElement("span")', 1, 16),
    false,
  );
  assert.equal(
    isNativeSelectConstructorAt('mycreateElement("select")', 1, 17),
    false,
  );
  assert.equal(
    isNativeSelectConstructorAt('someObject.badcreateElement("select")', 1, 28),
    false,
  );
  assert.equal(
    isNativeSelectConstructorAt('createElement("select")', 1, 14),
    false,
  );
  assert.equal(
    isNativeSelectConstructorAt('x.createElement("select")', 2, 16),
    false,
  );
  assert.equal(
    isNativeSelectConstructorAt('x.createElement("select")', 1, 0),
    false,
  );
});

test("fetches same-origin React-like source and rejects nearby author-style sources", async (t) => {
  const snippets = new Map<string, string>([
    [
      "/_next/static/chunks/react.js",
      'case"select":a=o.createElement("select"),r.multiple=a.multiple=!0',
    ],
    [
      "/_next/static/chunks/author.js",
      'e.style.width="2px";o.createElement("span")',
    ],
    [
      "/_next/static/chunks/wrong-select.js",
      'o.createElement("div");o.createElement("select")',
    ],
  ]);
  const server = createServer((incoming, outgoing) => {
    const body = snippets.get(incoming.url ?? "");
    if (body === undefined) {
      outgoing.writeHead(404).end();
      return;
    }
    outgoing.writeHead(200, {
      "content-type": "application/javascript; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    outgoing.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const testOrigin = `http://127.0.0.1:${address.port}`;
  const api = await request.newContext();
  t.after(() => api.dispose());
  const verify = createNativeSelectSourceVerifier({
    origin: testOrigin,
    request: api,
  });
  function report(
    sourceFile: string,
    source: string,
    targetNodeType = 9,
    marker = 'createElement("select")',
  ) {
    const markerStart = source.indexOf(marker);
    const openParen = marker.indexOf("(");
    return validEvidence({
      targetNodeType,
      targetTag: null,
      appOwnedClass: false,
      ariaHidden: null,
      tabIndex: null,
      sourceFile,
      lineNumber: 1,
      columnNumber:
        markerStart < 0
          ? -1
          : markerStart + (openParen < 0 ? 1 : openParen + 1),
    });
  }

  const validSource = snippets.get("/_next/static/chunks/react.js");
  assert.ok(validSource);
  assert.equal(
    await verify(report("/_next/static/chunks/react.js", validSource)),
    true,
  );
  const authorSource = snippets.get("/_next/static/chunks/author.js");
  assert.ok(authorSource);
  assert.equal(
    await verify(
      report(
        "/_next/static/chunks/author.js",
        authorSource,
        9,
        "e.style.width",
      ),
    ),
    false,
  );
  const wrongSelectSource = snippets.get(
    "/_next/static/chunks/wrong-select.js",
  );
  assert.ok(wrongSelectSource);
  assert.equal(
    await verify(
      report(
        "/_next/static/chunks/wrong-select.js",
        wrongSelectSource,
        9,
        'createElement("div")',
      ),
    ),
    false,
  );
  assert.equal(
    await verify(
      report(
        "https://attacker.invalid/_next/static/chunks/react.js",
        validSource,
      ),
    ),
    false,
  );
  assert.equal(
    await verify(report("/_next/static/chunks/../evil.js", validSource)),
    false,
  );
  assert.equal(
    await verify(report("/_next/static/chunks/react.js?next=1", validSource)),
    false,
  );
  assert.equal(
    await verify(report("/_next/static/chunks/react.js", validSource, 1)),
    false,
  );
});

test("does not accept document evidence with inconsistent target metadata", async (t) => {
  const base = validEvidence({
    targetNodeType: 9,
    targetTag: null,
    appOwnedClass: false,
    ariaHidden: null,
    tabIndex: null,
  });
  const cases: Array<readonly [string, Partial<Evidence>]> = [
    ["document with style attribute", { hasStyleAttribute: true }],
    ["document with element tag", { targetTag: "SELECT" }],
    ["non-document target", { targetNodeType: 1 }],
    ["document with select class", { appOwnedClass: true }],
  ];

  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      const diagnostics = makeDiagnostics();
      diagnostics.observeViolation(
        { ...base, ...overrides },
        {
          sourceValid: true,
          tokenValid: true,
          nativeSelectConstructorValid: true,
        },
      );
      observeWarning(diagnostics);
      await diagnostics.flush();
      assert.equal(diagnostics.result().matchedCount, 0);
      assert.ok(diagnostics.result().errors.length > 0);
    });
  }
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
