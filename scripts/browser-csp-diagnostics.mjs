import { randomUUID } from "node:crypto";

/** @typedef {"chromium" | "firefox" | "webkit"} BrowserEngine */
/** @typedef {{ engine: BrowserEngine, origin: string, now?: () => number, quietWindowMs?: number, maxFlushMs?: number, recordLimit?: number }} CspDiagnosticOptions */
/** @typedef {{ token?: unknown, documentId?: unknown, eventId?: unknown, observedAt?: unknown, pathname?: unknown, trusted?: unknown, effectiveDirective?: unknown, blockedURI?: unknown, targetNodeType?: unknown, targetTag?: unknown, appOwnedClass?: unknown, ariaHidden?: unknown, tabIndex?: unknown, hasStyleAttribute?: unknown, sourceFile?: unknown, lineNumber?: unknown, columnNumber?: unknown }} CspViolationReport */
/** @typedef {{ type?: string, text?: string, locationUrl?: string, observedAt?: number }} ConsoleDiagnostic */
/** @typedef {{ sourceValid?: boolean, tokenValid?: boolean, nativeSelectConstructorValid?: boolean }} EvidenceContext */
/** @typedef {{ pathname: string, observedAt: number }} MatchedEvidence */

export const webkitNativeSelectCspConsoleMessage =
  "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.";

const maxRecords = 64;
const maxPairSkewMs = 2000;
const maxSourceBytes = 2 * 1024 * 1024;
const maxCachedSourceBytes = 6 * 1024 * 1024;
const maxCachedSources = 3;
const sourceFetchTimeoutMs = 2500;
const maxConcurrentSourceFetches = 4;

/** @param {string | undefined} value @param {string} origin */
function documentPath(value, origin) {
  try {
    const url = new URL(value);
    return url.origin === origin ? url.pathname : null;
  } catch {
    return null;
  }
}

/** @param {unknown} value */
function isPathname(value) {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("?") &&
    !value.includes("#")
  );
}

/** @param {string} source @param {number} lineNumber @param {number} columnNumber */
export function isNativeSelectConstructorAt(source, lineNumber, columnNumber) {
  if (
    !Number.isSafeInteger(lineNumber) ||
    lineNumber < 1 ||
    !Number.isSafeInteger(columnNumber) ||
    columnNumber < 1
  )
    return false;

  let currentLine = 1;
  let lineStart = 0;
  while (currentLine < lineNumber) {
    const newline = source.indexOf("\n", lineStart);
    if (newline < 0) return false;
    lineStart = newline + 1;
    currentLine += 1;
  }
  const lineEnd = source.indexOf("\n", lineStart);
  const line = source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd);
  const reportedIndex = columnNumber - 1;
  if (reportedIndex >= line.length) return false;

  const nativeSelectCall =
    /(?<![\w$])(?:[$\w]+\.)+createElement\(\s*(["'])select\1\s*(?:,\s*\{\s*is\s*:\s*[^{}]*\})?\s*\)/g;
  for (const match of line.matchAll(nativeSelectCall)) {
    const callIndex = match.index + match[0].indexOf("(");
    if (callIndex === reportedIndex) return true;
  }
  return false;
}

/**
 * @param {{ origin: string, request: import("playwright").APIRequestContext }} options
 */
export function createNativeSelectSourceVerifier({ origin, request }) {
  const expectedOrigin = new URL(origin).origin;
  /** @type {Map<string, { source: string, bytes: number }>} */
  const sources = new Map();
  /** @type {Map<string, Promise<{ source: string, bytes: number } | null>>} */
  const pendingSources = new Map();
  let cachedBytes = 0;

  async function loadSource(pathname) {
    const cached = sources.get(pathname);
    if (cached) {
      sources.delete(pathname);
      sources.set(pathname, cached);
      return cached.source;
    }

    let pending = pendingSources.get(pathname);
    if (!pending) {
      if (pendingSources.size >= maxConcurrentSourceFetches) return null;
      pending = (async () => {
        let response;
        try {
          response = await request.get(new URL(pathname, expectedOrigin).href, {
            timeout: sourceFetchTimeoutMs,
            maxRedirects: 0,
            headers: { "accept-encoding": "identity" },
          });
          if (response.status() !== 200) return null;
          const headers = response.headers();
          const contentType = headers["content-type"]?.split(";")[0].trim();
          if (
            contentType !== "application/javascript" &&
            contentType !== "text/javascript"
          )
            return null;
          const contentLength = Number(headers["content-length"]);
          if (
            !Number.isSafeInteger(contentLength) ||
            contentLength < 1 ||
            contentLength > maxSourceBytes
          )
            return null;
          const body = await response.body();
          if (
            body.byteLength !== contentLength ||
            body.byteLength > maxSourceBytes
          )
            return null;
          const source = new TextDecoder("utf-8", { fatal: true }).decode(body);
          if (
            cachedBytes + body.byteLength > maxCachedSourceBytes ||
            sources.size >= maxCachedSources
          )
            return null;
          const result = { source, bytes: body.byteLength };
          sources.set(pathname, result);
          cachedBytes += body.byteLength;
          return result;
        } catch {
          return null;
        } finally {
          await response?.dispose().catch(() => {});
        }
      })();
      pendingSources.set(pathname, pending);
    }

    try {
      const result = await pending;
      return result?.source ?? null;
    } finally {
      if (pendingSources.get(pathname) === pending)
        pendingSources.delete(pathname);
    }
  }

  /** @param {CspViolationReport} report */
  return async function verifyNativeSelectConstructor(report) {
    if (
      report.targetNodeType !== 9 ||
      report.targetTag !== null ||
      typeof report.sourceFile !== "string" ||
      !Number.isSafeInteger(report.lineNumber) ||
      !Number.isSafeInteger(report.columnNumber)
    )
      return false;

    let url;
    try {
      url = new URL(report.sourceFile, expectedOrigin);
    } catch {
      return false;
    }
    if (
      url.origin !== expectedOrigin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/_next\/static\/chunks\/[^/]+\.js$/.test(url.pathname)
    )
      return false;

    const source = await loadSource(url.pathname);
    return (
      source !== null &&
      isNativeSelectConstructorAt(
        source,
        report.lineNumber,
        report.columnNumber,
      )
    );
  };
}

/**
 * @param {CspDiagnosticOptions} options
 * @returns {{ deferConsole: (message?: ConsoleDiagnostic) => boolean, observeViolation: (report: CspViolationReport | null | undefined, context?: EvidenceContext) => void, flush: () => Promise<void>, result: () => { matchedCount: number, errors: string[] } }}
 */
export function createBrowserCspDiagnostics({
  engine,
  origin,
  now = Date.now,
  quietWindowMs = 200,
  maxFlushMs = 2000,
  recordLimit = maxRecords,
}) {
  const expectedOrigin = new URL(origin).origin;
  /** @type {Array<{ pathname: string, observedAt: number }>} */
  const pendingWarnings = [];
  /** @type {MatchedEvidence[]} */
  const pendingEvidence = [];
  /** @type {Set<string>} */
  const seenEvents = new Set();
  /** @type {string[]} */
  const faults = [];
  let warningCount = 0;
  let evidenceCount = 0;
  let warningOverflow = 0;
  let evidenceOverflow = 0;
  let faultOverflow = 0;
  let matchedCount = 0;
  let lastActivity = Date.now();

  function activity() {
    lastActivity = Date.now();
  }

  /** @param {string} message */
  function fault(message) {
    activity();
    if (faults.length < recordLimit) faults.push(message);
    else faultOverflow += 1;
  }

  function pairAvailableRecords() {
    for (let warningIndex = 0; warningIndex < pendingWarnings.length;) {
      const warning = pendingWarnings[warningIndex];
      const evidenceIndex = pendingEvidence.findIndex(
        (evidence) =>
          evidence.pathname === warning.pathname &&
          Math.abs(evidence.observedAt - warning.observedAt) <= maxPairSkewMs,
      );
      if (evidenceIndex < 0) {
        warningIndex += 1;
        continue;
      }
      pendingWarnings.splice(warningIndex, 1);
      pendingEvidence.splice(evidenceIndex, 1);
      matchedCount += 1;
    }
  }

  /** @param {ConsoleDiagnostic} [message] */
  function deferConsole({ type, text, locationUrl, observedAt = now() } = {}) {
    if (
      engine !== "webkit" ||
      type !== "error" ||
      text !== webkitNativeSelectCspConsoleMessage
    ) {
      return false;
    }

    activity();
    warningCount += 1;
    if (warningCount > recordLimit) {
      warningOverflow += 1;
      return true;
    }

    const pathname = documentPath(locationUrl, expectedOrigin);
    if (!pathname || !Number.isFinite(observedAt)) {
      fault("WebKit stylesheet CSP warning lacked app document context");
      return true;
    }

    pendingWarnings.push({ pathname, observedAt });
    pairAvailableRecords();
    return true;
  }

  /**
   * @param {CspViolationReport | null | undefined} report
   * @param {EvidenceContext} [context]
   */
  function observeViolation(
    report,
    {
      sourceValid = false,
      tokenValid = false,
      nativeSelectConstructorValid = false,
    } = {},
  ) {
    activity();
    evidenceCount += 1;
    if (evidenceCount > recordLimit) {
      evidenceOverflow += 1;
      return;
    }

    if (engine !== "webkit") {
      fault("Unexpected CSP violation outside WebKit");
      return;
    }
    if (!sourceValid || !tokenValid) {
      fault("CSP violation lacked trusted main-document binding context");
      return;
    }
    if (!report || typeof report !== "object") {
      fault("CSP violation metadata was missing");
      return;
    }

    const eventKey =
      typeof report.documentId === "string" &&
      Number.isSafeInteger(report.eventId) &&
      report.eventId >= 0
        ? `${report.documentId}:${report.eventId}`
        : null;
    if (!eventKey) {
      fault("CSP violation metadata lacked document event identity");
      return;
    }
    if (seenEvents.has(eventKey)) {
      fault("Duplicate CSP violation evidence was rejected");
      return;
    }
    seenEvents.add(eventKey);

    const pathname = report.pathname;
    if (
      report.trusted !== true ||
      !isPathname(pathname) ||
      typeof report.observedAt !== "number" ||
      !Number.isFinite(report.observedAt)
    ) {
      fault("CSP violation metadata was not a trusted document event");
      return;
    }
    if (
      report.effectiveDirective !== "style-src-attr" ||
      report.blockedURI !== "inline"
    ) {
      fault("Unexpected stylesheet or non-inline CSP violation");
      return;
    }
    const hiddenSelect =
      report.targetNodeType === 1 &&
      report.targetTag === "SELECT" &&
      report.appOwnedClass === true &&
      report.ariaHidden === "true" &&
      report.tabIndex === -1 &&
      report.hasStyleAttribute === false;
    const verifiedWebKitSelectCreation =
      report.targetNodeType === 9 &&
      report.targetTag === null &&
      report.appOwnedClass === false &&
      report.ariaHidden === null &&
      report.tabIndex === null &&
      report.hasStyleAttribute === false &&
      nativeSelectConstructorValid === true;
    if (!hiddenSelect && !verifiedWebKitSelectCreation) {
      fault(
        "CSP style violation did not target the hidden Nivra select bubble or its verified WebKit constructor",
      );
      return;
    }

    pendingEvidence.push({ pathname, observedAt: report.observedAt });
    pairAvailableRecords();
  }

  async function flush() {
    const deadline = Date.now() + maxFlushMs;
    while (quietWindowMs > 0 && Date.now() - lastActivity < quietWindowMs) {
      const remainingQuiet = quietWindowMs - (Date.now() - lastActivity);
      const remainingTotal = deadline - Date.now();
      if (remainingTotal <= 0) {
        fault(
          "CSP diagnostics did not settle before the bounded flush deadline",
        );
        break;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(remainingQuiet, remainingTotal)),
      );
      pairAvailableRecords();
    }
    if (Date.now() >= deadline && Date.now() - lastActivity < quietWindowMs)
      fault("CSP diagnostics did not settle before the bounded flush deadline");
    pairAvailableRecords();
  }

  function result() {
    const errors = [...faults];
    if (pendingWarnings.length)
      errors.push(
        `${pendingWarnings.length} WebKit stylesheet CSP warning(s) had no one-to-one trusted native-select evidence`,
      );
    if (warningOverflow)
      errors.push(
        `${warningOverflow} CSP console warning(s) exceeded the diagnostic bound`,
      );
    if (evidenceOverflow)
      errors.push(
        `${evidenceOverflow} CSP event(s) exceeded the diagnostic bound`,
      );
    if (faultOverflow)
      errors.push(
        `${faultOverflow} additional CSP diagnostic failure(s) exceeded the diagnostic bound`,
      );
    return { matchedCount, errors };
  }

  return { deferConsole, observeViolation, flush, result };
}

/**
 * @param {import("playwright").Page} page
 * @param {{ engine: BrowserEngine, origin: string }} options
 */
export async function installBrowserCspDiagnostics(page, { engine, origin }) {
  const diagnostics = createBrowserCspDiagnostics({ engine, origin });
  const verifyNativeSelectConstructor = createNativeSelectSourceVerifier({
    origin,
    request: page.request,
  });
  /** @type {Set<Promise<void>>} */
  const pendingViolations = new Set();
  const bindingName = `__nivraCspReport${randomUUID().replaceAll("-", "")}`;
  const token = randomUUID();
  const expectedOrigin = new URL(origin).origin;

  /**
   * @param {{ page: import("playwright").Page, frame: import("playwright").Frame }} source
   * @param {CspViolationReport | null | undefined} report
   */
  async function receiveViolation(source, report) {
    let sourceValid = false;
    try {
      const frameUrl = new URL(source.frame.url());
      sourceValid =
        source.page === page &&
        source.frame === page.mainFrame() &&
        frameUrl.origin === expectedOrigin;
    } catch {}
    const tokenValid = report?.token === token;
    const documentTarget =
      report?.targetNodeType === 9 && report?.targetTag === null;
    let nativeSelectConstructorValid = false;
    if (sourceValid && tokenValid && documentTarget)
      nativeSelectConstructorValid =
        await verifyNativeSelectConstructor(report);
    diagnostics.observeViolation(report, {
      sourceValid,
      tokenValid,
      nativeSelectConstructorValid,
    });
  }
  await page.exposeBinding(bindingName, (source, report) => {
    const pending = receiveViolation(source, report);
    pendingViolations.add(pending);
    void pending.finally(() => pendingViolations.delete(pending));
    return pending;
  });

  /** @param {{ bridgeName: string, secret: string }} args */
  function captureSecurityPolicyViolations({ bridgeName, secret }) {
    const bridge = Reflect.get(window, bridgeName);
    try {
      Reflect.deleteProperty(window, bridgeName);
    } catch {}
    if (typeof bridge !== "function") return;

    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const documentId = Array.from(bytes, (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
    let eventId = 0;
    document.addEventListener(
      "securitypolicyviolation",
      (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const report = {
          token: secret,
          documentId,
          eventId: eventId++,
          observedAt: Date.now(),
          pathname: location.pathname,
          trusted: event.isTrusted === true,
          effectiveDirective: event.effectiveDirective,
          blockedURI: event.blockedURI,
          targetTag: target?.tagName ?? null,
          targetNodeType: target?.nodeType ?? event.target?.nodeType ?? null,
          appOwnedClass:
            target?.classList?.contains("nivra-select-bubble") === true,
          ariaHidden: target?.getAttribute("aria-hidden") ?? null,
          tabIndex: target?.tabIndex ?? null,
          hasStyleAttribute: target?.hasAttribute("style") === true,
          sourceFile: event.sourceFile,
          lineNumber: event.lineNumber,
          columnNumber: event.columnNumber,
        };
        void bridge(report).catch(() => {});
      },
      true,
    );
  }

  await page.addInitScript(captureSecurityPolicyViolations, {
    bridgeName: bindingName,
    secret: token,
  });

  return {
    ...diagnostics,
    async flush() {
      const deadline = Date.now() + sourceFetchTimeoutMs + 500;
      while (pendingViolations.size && Date.now() < deadline)
        await Promise.allSettled([...pendingViolations]);
      if (pendingViolations.size)
        diagnostics.observeViolation(null, {
          sourceValid: false,
          tokenValid: false,
        });
      await diagnostics.flush();
    },
  };
}
