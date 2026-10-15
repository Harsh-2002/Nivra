import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

/** @typedef {"chromium" | "firefox" | "webkit"} BrowserEngine */
/** @typedef {{ engine: BrowserEngine, origin: string, now?: () => number, windowMs?: number, quietWindowMs?: number, maxFlushMs?: number, recordLimit?: number }} FetchDiagnosticOptions */
/** @typedef {{ token?: unknown, type?: unknown, documentId?: unknown, eventId?: unknown, origin?: unknown, pathname?: unknown, trusted?: unknown }} DocumentEvent */

export const webkitNativeFetchCancellationName = "Fetch API cannot load http";
export const webkitNativeFetchCancellationSuffix =
  " due to access control checks.";

const backgroundReadPaths = new Set([
  "/api/v1/tags",
  "/api/v1/status",
  "/api/v1/overview",
  "/api/v1/completions",
]);
const notesPreviewKeys = new Set([
  "view",
  "sort",
  "q",
  "limit",
  "preview",
  "offset",
]);
const journalListKeys = new Set(["period", "limit", "q", "after"]);
const calendarRangeKeys = new Set([
  "from",
  "to",
  "timezone",
  "mode",
  "limit",
  "preview",
  "includeCompleted",
  "offset",
]);
const maxRecords = 128;
const navigationWindowMs = 2000;
const nativeControlAttempts = 20;

/** @param {string} value @param {string} origin */
function sameOriginUrl(value, origin) {
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

/** @param {URL} url */
function isEligibleCalendarRange(url) {
  if (url.search.length > 1024) return false;
  const params = url.searchParams;
  const once = (key) => params.getAll(key).length === 1;
  if ([...params.keys()].some((key) => !calendarRangeKeys.has(key)))
    return false;
  if (
    !["from", "to", "timezone", "mode", "limit", "includeCompleted"].every(once)
  )
    return false;
  const date = /^\d{4}-\d{2}-\d{2}$/;
  const count = /^(0|[1-9]\d{0,3})$/;
  const preview = params.getAll("preview");
  const offset = params.getAll("offset");
  return (
    date.test(params.get("from") ?? "") &&
    date.test(params.get("to") ?? "") &&
    /^[A-Za-z0-9_+/-]{1,64}$/.test(params.get("timezone") ?? "") &&
    ["planning", "activity"].includes(params.get("mode") ?? "") &&
    count.test(params.get("limit") ?? "") &&
    ["0", "1"].includes(params.get("includeCompleted") ?? "") &&
    preview.length <= 1 &&
    (preview.length === 0 || count.test(preview[0])) &&
    offset.length <= 1 &&
    (offset.length === 0 || /^(0|[1-9]\d{0,6})$/.test(offset[0]))
  );
}

/** @param {URL} url */
function isEligibleReadUrl(url) {
  if (backgroundReadPaths.has(url.pathname)) return url.search.length <= 512;
  if (url.pathname === "/api/v1/journals") {
    if (url.search.length > 6144) return false;
    const params = url.searchParams;
    const keys = [...params.keys()];
    const query = params.getAll("q");
    const after = params.getAll("after");
    return (
      keys.every((key) => journalListKeys.has(key)) &&
      params.getAll("period").length === 1 &&
      ["daily", "weekly", "monthly"].includes(params.get("period") ?? "") &&
      params.getAll("limit").length === 1 &&
      params.get("limit") === "60" &&
      query.length <= 1 &&
      (query.length === 0 || query[0].length <= 300) &&
      after.length <= 1 &&
      (after.length === 0 || after[0].length <= 512)
    );
  }
  if (url.pathname === "/api/v1/calendar/range")
    return isEligibleCalendarRange(url);
  if (url.pathname !== "/api/v1/notes" || url.search.length > 4096)
    return false;
  const params = url.searchParams;
  const keys = [...params.keys()];
  if (keys.some((key) => !notesPreviewKeys.has(key))) return false;
  if (
    ["view", "sort", "q", "limit", "preview"].some(
      (key) => params.getAll(key).length !== 1,
    )
  )
    return false;
  const query = params.get("q");
  const offset = params.getAll("offset");
  return (
    params.get("view") === "all" &&
    ["updated", "created", "title"].includes(params.get("sort") ?? "") &&
    query !== null &&
    query.length <= 300 &&
    params.get("limit") === "61" &&
    params.get("preview") === "1" &&
    offset.length <= 1 &&
    (offset.length === 0 ||
      (/^(0|[1-9]\d*)$/.test(offset[0]) && Number(offset[0]) <= 1_000_000))
  );
}

/** @param {unknown} error @param {string} origin */
export function parseNativeFetchCancellation(error, origin) {
  if (
    !error ||
    typeof error !== "object" ||
    /** @type {{ name?: unknown }} */ (error).name !==
      webkitNativeFetchCancellationName ||
    typeof (/** @type {{ message?: unknown }} */ (error).message) !== "string"
  )
    return null;

  const message = /** @type {{ message: string }} */ (error).message;
  if (!message.endsWith(webkitNativeFetchCancellationSuffix)) return null;
  let requested = message.slice(0, -webkitNativeFetchCancellationSuffix.length);
  if (requested.startsWith("//")) requested = `http:${requested}`;
  else if (/^\/[^/\s]+:\d+\//.test(requested))
    requested = `http://${requested.slice(1)}`;
  else if (!/^https?:\/\//i.test(requested)) return null;
  const url = sameOriginUrl(requested, origin);
  if (!url || url.hash || !isEligibleReadUrl(url)) return null;
  return { origin: url.origin, pathname: url.pathname };
}

/**
 * @param {FetchDiagnosticOptions} options
 */
export function createBrowserFetchDiagnostics({
  engine,
  origin,
  now = Date.now,
  windowMs = navigationWindowMs,
  quietWindowMs = 200,
  maxFlushMs = 2000,
  recordLimit = maxRecords,
}) {
  const expectedOrigin = new URL(origin).origin;
  windowMs = Math.max(0, Math.min(navigationWindowMs, windowMs));
  /** @type {Map<string, { pathname: string, readyAt: number }>} */
  const documents = new Map();
  /** @type {Set<string>} */
  const faultedDocuments = new Set();
  /** @type {Set<string>} */
  const seenEvents = new Set();
  /** @type {Array<{ documentId: string, startedAt: number }>} */
  const navigations = [];
  /** @type {Map<string, { pathname: string, method: string, observedAt: number, finishedAt: number | null }>} */
  const apiRequests = new Map();
  /** @type {Array<{ documentId: string, pathname: string, observedAt: number, message: string }>} */
  const candidates = [];
  /** @type {string[]} */
  const faults = [];
  let observedEvents = 0;
  let deferredCount = 0;
  let lastActivity = now();
  let overflow = 0;
  let nextApiRequestId = 0;

  /** @param {string} message */
  function fail(message) {
    if (faults.length < recordLimit) faults.push(message);
    else overflow += 1;
  }

  function activity() {
    lastActivity = now();
  }

  /** @param {string} pathname @param {number} observedAt */
  function invalidateMutationCandidates(pathname, observedAt) {
    for (const candidate of candidates) {
      if (
        candidate.pathname === pathname &&
        Math.abs(candidate.observedAt - observedAt) <= windowMs
      ) {
        fail("Native fetch diagnostic overlapped a matching mutation request");
      }
    }
  }

  function prune() {
    const cutoff = now() - windowMs;
    while (navigations.length && navigations[0].startedAt < cutoff)
      navigations.shift();
    for (const [id, request] of apiRequests) {
      if (request.finishedAt !== null && request.finishedAt < cutoff)
        apiRequests.delete(id);
    }
  }

  /** @param {DocumentEvent | null | undefined} report @param {{ sourceValid?: boolean, tokenValid?: boolean }} context */
  function observeDocumentEvent(
    report,
    { sourceValid = false, tokenValid = false } = {},
  ) {
    activity();
    observedEvents += 1;
    if (observedEvents > recordLimit) {
      overflow += 1;
      return false;
    }
    if (!sourceValid || !tokenValid || !report || typeof report !== "object") {
      fail(
        "Fetch diagnostic event lacked trusted main-document binding context",
      );
      return false;
    }
    if (
      report.trusted !== true ||
      report.origin !== expectedOrigin ||
      typeof report.pathname !== "string" ||
      !report.pathname.startsWith("/") ||
      report.pathname.startsWith("//") ||
      typeof report.documentId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        report.documentId,
      ) ||
      !Number.isSafeInteger(report.eventId) ||
      report.eventId < 0
    ) {
      fail("Fetch diagnostic event metadata was invalid or untrusted");
      return false;
    }
    const eventKey = `${report.documentId}:${report.eventId}`;
    if (seenEvents.has(eventKey)) {
      fail("Duplicate fetch diagnostic event was rejected");
      return false;
    }
    if (seenEvents.size >= recordLimit) {
      overflow += 1;
      return false;
    }
    seenEvents.add(eventKey);
    if (report.type === "ready") {
      if (documents.has(report.documentId)) {
        fail("Duplicate document monitor readiness report");
        return false;
      }
      if (documents.size >= recordLimit) {
        overflow += 1;
        return false;
      }
      documents.set(report.documentId, {
        pathname: report.pathname,
        readyAt: now(),
      });
      return true;
    }
    const document = documents.get(report.documentId);
    if (!document || document.pathname !== report.pathname) {
      fail("Fetch diagnostic event came from an unmonitored document");
      return false;
    }
    if (report.type === "error" || report.type === "unhandledrejection") {
      faultedDocuments.add(report.documentId);
      fail(`Uncaught browser ${report.type} event in a monitored document`);
      return false;
    }
    fail("Fetch diagnostic event type was not recognized");
    return false;
  }

  /** @param {{ url: string, method: string, observedAt?: number, requestId?: string }} request */
  function observeApiRequest({
    url: value,
    method,
    observedAt = now(),
    requestId,
  }) {
    const url = sameOriginUrl(value, expectedOrigin);
    if (!url || !isEligibleReadUrl(url)) return;
    const normalizedMethod = method.toUpperCase();
    if (normalizedMethod === "GET") return null;
    activity();
    prune();
    if (apiRequests.size >= recordLimit) {
      overflow += 1;
      return null;
    }
    const id = requestId ?? `observed-${nextApiRequestId++}`;
    invalidateMutationCandidates(url.pathname, observedAt);
    apiRequests.set(id, {
      pathname: url.pathname,
      method: normalizedMethod,
      observedAt,
      finishedAt: null,
    });
    return id;
  }

  /** @param {string | undefined} requestId @param {number} [finishedAt] */
  function finishApiRequest(requestId, finishedAt = now()) {
    const request = requestId ? apiRequests.get(requestId) : null;
    if (!request || request.finishedAt !== null) return;
    request.finishedAt = finishedAt;
    activity();
    invalidateMutationCandidates(request.pathname, finishedAt);
    prune();
  }

  /** @param {{ url: string, method: string, isMainFrame: boolean, isNavigation: boolean, observedAt?: number, sourceDocumentId?: string | null }} navigation */
  function observeNavigation({
    url: value,
    method,
    isMainFrame,
    isNavigation,
    observedAt = now(),
    sourceDocumentId,
  }) {
    if (!isNavigation || !isMainFrame) return;
    activity();
    navigations.length = 0;
    prune();
    if (method.toUpperCase() !== "GET") return;
    const url = sameOriginUrl(value, expectedOrigin);
    if (!url) return;
    if (
      typeof sourceDocumentId !== "string" ||
      !documents.has(sourceDocumentId)
    ) {
      if (documents.size > 0)
        fail("Main-document navigation began without a ready error monitor");
      return;
    }
    if (navigations.length >= recordLimit) {
      overflow += 1;
      return;
    }
    navigations.push({ documentId: sourceDocumentId, startedAt: observedAt });
  }

  /** @param {unknown} error @param {number} [observedAt] */
  function deferPageError(error, observedAt = now()) {
    activity();
    if (engine !== "webkit") return false;
    const parsed = parseNativeFetchCancellation(error, expectedOrigin);
    if (!parsed) return false;
    prune();
    const navigation = [...navigations]
      .reverse()
      .find(
        (candidate) =>
          observedAt >= candidate.startedAt &&
          observedAt - candidate.startedAt <= windowMs,
      );
    if (!navigation || !documents.has(navigation.documentId)) return false;
    const matchingRequests = [...apiRequests.values()].filter(
      (request) =>
        request.pathname === parsed.pathname &&
        (request.finishedAt === null ||
          Math.abs(request.finishedAt - observedAt) <= windowMs),
    );
    if (matchingRequests.some((request) => request.method !== "GET"))
      return false;
    if (faultedDocuments.has(navigation.documentId)) return false;
    if (candidates.length >= recordLimit) {
      overflow += 1;
      return false;
    }
    candidates.push({
      documentId: navigation.documentId,
      pathname: parsed.pathname,
      observedAt,
      message: `${webkitNativeFetchCancellationName} for ${parsed.pathname} during document navigation`,
    });
    deferredCount += 1;
    return true;
  }

  async function flush() {
    const deadline = Date.now() + maxFlushMs;
    while (quietWindowMs > 0 && Date.now() - lastActivity < quietWindowMs) {
      const remaining = Math.min(
        quietWindowMs - (Date.now() - lastActivity),
        deadline - Date.now(),
      );
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
    if (Date.now() >= deadline && Date.now() - lastActivity < quietWindowMs)
      fail(
        "Fetch diagnostic events did not settle before the bounded deadline",
      );
  }

  function result() {
    const errors = [...faults];
    for (const candidate of candidates) {
      if (faultedDocuments.has(candidate.documentId))
        errors.push(
          `Native-looking pageerror accompanied an uncaught event: ${candidate.message}`,
        );
    }
    if (overflow)
      errors.push(`${overflow} fetch diagnostic record(s) exceeded the bound`);
    return { deferredCount, errors };
  }

  return {
    observeDocumentEvent,
    observeApiRequest,
    finishApiRequest,
    observeNavigation,
    deferPageError,
    flush,
    result,
  };
}

/** @param {import("playwright").Page} page @param {{ engine: BrowserEngine, origin: string }} options */
export async function installBrowserFetchDiagnostics(page, options) {
  const diagnostics = createBrowserFetchDiagnostics(options);
  if (options.engine !== "webkit") return diagnostics;

  const bindingName = `__nivraFetchReport${randomUUID().replaceAll("-", "")}`;
  const token = randomUUID();
  const expectedOrigin = new URL(options.origin).origin;
  let currentDocumentId = null;
  /** @type {Set<Promise<void>>} */
  const pendingEvents = new Set();

  await page.exposeBinding(bindingName, (source, report) => {
    const pending = Promise.resolve().then(() => {
      let sourceValid = false;
      try {
        sourceValid = source.page === page && source.frame === page.mainFrame();
      } catch {}
      const accepted = diagnostics.observeDocumentEvent(report, {
        sourceValid,
        tokenValid: report?.token === token,
      });
      if (report?.type === "ready" && accepted)
        currentDocumentId = report.documentId;
    });
    pendingEvents.add(pending);
    void pending.then(
      () => pendingEvents.delete(pending),
      () => pendingEvents.delete(pending),
    );
    return pending;
  });
  await page.addInitScript(
    ({ bindingName, token }) => {
      const bridge = Reflect.get(window, bindingName);
      try {
        Reflect.deleteProperty(window, bindingName);
      } catch {}
      if (typeof bridge !== "function") return;
      const documentId = crypto.randomUUID();
      let eventId = 0;
      const send = (type, trusted) => {
        void bridge({
          token,
          type,
          documentId,
          eventId: eventId++,
          origin: location.origin,
          pathname: location.pathname,
          trusted,
        }).catch(() => {});
      };
      addEventListener(
        "error",
        (event) => {
          if (event instanceof ErrorEvent && event.target === window)
            send("error", event.isTrusted);
        },
        true,
      );
      addEventListener(
        "unhandledrejection",
        (event) => send("unhandledrejection", event.isTrusted),
        true,
      );
      send("ready", true);
    },
    { bindingName, token },
  );

  const trackedApiRequests = new WeakMap();
  page.on("request", (request) => {
    try {
      const value = request.url();
      const url = new URL(value);
      if (url.origin === expectedOrigin && isEligibleReadUrl(url)) {
        const requestId = diagnostics.observeApiRequest({
          url: value,
          method: request.method(),
          requestId: randomUUID(),
        });
        if (requestId) trackedApiRequests.set(request, requestId);
      }
      if (!request.isNavigationRequest()) return;
      let isMainFrame = false;
      try {
        isMainFrame = request.frame() === page.mainFrame();
      } catch {}
      diagnostics.observeNavigation({
        url: value,
        method: request.method(),
        isMainFrame,
        isNavigation: true,
        sourceDocumentId: currentDocumentId,
      });
    } catch {
      if (request.isNavigationRequest())
        diagnostics.observeNavigation({
          url: request.url(),
          method: request.method(),
          isMainFrame: false,
          isNavigation: true,
          sourceDocumentId: null,
        });
    }
  });
  const finishTrackedApiRequest = (request) => {
    const requestId = trackedApiRequests.get(request);
    if (requestId) diagnostics.finishApiRequest(requestId);
  };
  page.on("requestfinished", finishTrackedApiRequest);
  page.on("requestfailed", finishTrackedApiRequest);
  return {
    ...diagnostics,
    async flush() {
      const deadline = Date.now() + 2000;
      while (pendingEvents.size && Date.now() < deadline)
        await Promise.allSettled([...pendingEvents]);
      if (pendingEvents.size)
        diagnostics.observeDocumentEvent(null, {
          sourceValid: false,
          tokenValid: false,
        });
      await diagnostics.flush();
    },
  };
}

/** @param {import("playwright").Browser} browser */
export async function verifyWebKitFetchDiagnosticControls(browser) {
  const server = createServer();
  const sockets = new Set();
  const pendingResponses = new Set();
  /** @type {Map<string, { seen: () => void, gate: Promise<void>, release: () => void }>} */
  const holds = new Map();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("request", async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (
      url.pathname === "/api/v1/tags" ||
      url.pathname === "/api/v1/notes" ||
      url.pathname === "/api/v1/journals" ||
      url.pathname === "/api/v1/calendar/range"
    ) {
      pendingResponses.add(response);
      response.on("close", () => pendingResponses.delete(response));
      return;
    }
    if (url.pathname === "/hold") {
      const hold = holds.get(url.searchParams.get("id") ?? "");
      if (!hold) {
        response.writeHead(404).end();
        return;
      }
      hold.seen();
      await hold.gate;
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>hold complete</title>");
      return;
    }
    if (url.pathname === "/target") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>target</title>");
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><title>source</title><script>
      window.started = false;
      window.trigger = (kind) => {
        const error = Object.assign(new Error("http://127.0.0.1:${String(server.address()?.port)}/api/v1/tags due to access control checks."), { name: "Fetch API cannot load http" });
        setTimeout(() => {
          if (kind === "throw") throw error;
          if (kind === "reject-error") Promise.reject(error);
          if (kind === "reject-string") Promise.reject(error.message);
        }, 0);
      };
      window.startFetches = (path = "/api/v1/tags") => {
        window.started = true;
        const poll = () => { fetch(path).catch(() => {}); setTimeout(poll, 2); };
        poll();
      };
    </script>`);
  });

  // Held requests never complete, so without this they pile up and saturate the
  // browser's per-host connection pool; later fetches then queue instead of starting.
  const releaseHeldRequests = () => {
    for (const response of pendingResponses) response.destroy();
    pendingResponses.clear();
    for (const socket of sockets) socket.destroy();
  };
  const waitForHeldRequest = async () => {
    const deadline = Date.now() + 2000;
    while (pendingResponses.size === 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    return pendingResponses.size;
  };
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not start local WebKit diagnostics control server");
  const origin = `http://127.0.0.1:${address.port}`;
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const diagnostics = await installBrowserFetchDiagnostics(page, {
    engine: "webkit",
    origin,
    quietWindowMs: 50,
    maxFlushMs: 1000,
  });
  const fatalPageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => {
    if (!diagnostics.deferPageError(error)) fatalPageErrors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  try {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      releaseHeldRequests();
      await page.goto(`${origin}/source`);
      await page.evaluate(() => window.startFetches());
      await waitForHeldRequest();
      await page.goto(`${origin}/target`);
    }
    await diagnostics.flush();
    const positiveResult = diagnostics.result();
    if (positiveResult.errors.length || fatalPageErrors.length)
      throw new Error(
        `Native WebKit cancellation control produced fatal diagnostics: ${[...positiveResult.errors, ...fatalPageErrors].join("; ")}`,
      );
    if (positiveResult.deferredCount < 1)
      throw new Error(
        "WebKit control did not reproduce a native fetch pageerror",
      );

    // WebKit emits the cancellation pageerror only for some in-flight fetches, so a
    // single navigation is not a reliable positive control; bound the retries instead.
    const reproduceNativeCancellation = async (path, label) => {
      const held = [];
      for (let attempt = 1; attempt <= nativeControlAttempts; attempt += 1) {
        releaseHeldRequests();
        const before = diagnostics.result().deferredCount;
        await page.goto(`${origin}/source`);
        await page.evaluate((target) => window.startFetches(target), path);
        // Navigate only once the server holds a request, so one is really in flight.
        held.push(await waitForHeldRequest());
        await page.waitForTimeout(5);
        await page.goto(`${origin}/target`);
        await diagnostics.flush();
        const result = diagnostics.result();
        if (result.errors.length || fatalPageErrors.length)
          throw new Error(
            `${label} cancellation control produced fatal diagnostics: ${[...result.errors, ...fatalPageErrors].join("; ")}`,
          );
        if (result.deferredCount > before) return attempt;
      }
      throw new Error(
        `WebKit control did not reproduce a native ${label} fetch pageerror in ${nativeControlAttempts} attempts (requests held per attempt: ${held.join(",")}; fatal page errors: ${fatalPageErrors.length})`,
      );
    };
    const notesPreview = new URLSearchParams({
      view: "all",
      sort: "updated",
      q: "",
      limit: "61",
      preview: "1",
    }).toString();
    const notesPreviewAttempts = await reproduceNativeCancellation(
      `/api/v1/notes?${notesPreview}`,
      "notes preview",
    );
    const journalList = new URLSearchParams({
      period: "daily",
      limit: "60",
    }).toString();
    const journalAttempts = await reproduceNativeCancellation(
      `/api/v1/journals?${journalList}`,
      "journal list",
    );
    const calendarRange = new URLSearchParams({
      from: "2027-03-21",
      to: "2027-03-28",
      timezone: "UTC",
      mode: "planning",
      limit: "500",
      preview: "50",
      includeCompleted: "0",
    }).toString();
    const calendarAttempts = await reproduceNativeCancellation(
      `/api/v1/calendar/range?${calendarRange}`,
      "calendar range",
    );

    let uncaughtCount = 0;
    let consoleCount = 0;
    for (const kind of ["throw", "reject-error", "reject-string"]) {
      const id = `${kind}-${randomUUID()}`;
      let signalSeen;
      const seen = new Promise((resolve) => {
        signalSeen = resolve;
      });
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      holds.set(id, { seen: signalSeen, gate, release });
      await page.goto(`${origin}/source`);
      const navigation = page.goto(
        `${origin}/hold?id=${encodeURIComponent(id)}`,
      );
      await seen;
      await page.evaluate((kind) => window.trigger(kind), kind);
      await page.waitForTimeout(20);
      release();
      await navigation;
      holds.delete(id);
      await diagnostics.flush();
      const result = diagnostics.result();
      if (
        !result.errors.some((entry) =>
          /uncaught browser (error|unhandledrejection)/i.test(entry),
        )
      )
        throw new Error(`WebKit ${kind} control was not retained as fatal`);
      uncaughtCount += 1;
    }

    await page.goto(`${origin}/source`);
    const nativeLookingConsole = `${origin}/api/v1/tags due to access control checks.`;
    await page.evaluate((text) => console.error(text), nativeLookingConsole);
    await page.waitForTimeout(20);
    if (!consoleErrors.some((text) => text.includes(nativeLookingConsole)))
      throw new Error(
        "Native-looking console.error was not retained by the strict console handler",
      );
    consoleCount += 1;
    return {
      deferredCount: positiveResult.deferredCount,
      notesPreviewAttempts,
      journalAttempts,
      calendarAttempts,
      uncaughtControls: uncaughtCount,
      strictConsoleControls: consoleCount,
    };
  } finally {
    for (const hold of holds.values()) hold.release();
    await context.close().catch(() => {});
    for (const response of pendingResponses) response.destroy();
    await new Promise((resolve) => server.close(resolve));
    for (const socket of sockets) socket.destroy();
  }
}
