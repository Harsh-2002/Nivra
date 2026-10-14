import { randomUUID } from "node:crypto";

/** @typedef {"chromium" | "firefox" | "webkit"} BrowserEngine */
/** @typedef {{ engine: BrowserEngine, origin: string, now?: () => number, quietWindowMs?: number, maxFlushMs?: number, recordLimit?: number }} CspDiagnosticOptions */
/** @typedef {{ token?: unknown, documentId?: unknown, eventId?: unknown, observedAt?: unknown, pathname?: unknown, trusted?: unknown, effectiveDirective?: unknown, blockedURI?: unknown, targetTag?: unknown, appOwnedClass?: unknown, ariaHidden?: unknown, tabIndex?: unknown, hasStyleAttribute?: unknown }} CspViolationReport */
/** @typedef {{ type?: string, text?: string, locationUrl?: string, observedAt?: number }} ConsoleDiagnostic */
/** @typedef {{ sourceValid?: boolean, tokenValid?: boolean }} EvidenceContext */
/** @typedef {{ pathname: string, observedAt: number }} MatchedEvidence */

export const webkitNativeSelectCspConsoleMessage =
  "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.";

const maxRecords = 64;
const maxPairSkewMs = 2000;

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
    { sourceValid = false, tokenValid = false } = {},
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
    if (
      report.targetTag !== "SELECT" ||
      report.appOwnedClass !== true ||
      report.ariaHidden !== "true" ||
      report.tabIndex !== -1 ||
      report.hasStyleAttribute !== false
    ) {
      fault(
        "CSP style violation did not target the hidden Nivra select bubble",
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
  const bindingName = `__nivraCspReport${randomUUID().replaceAll("-", "")}`;
  const token = randomUUID();
  const expectedOrigin = new URL(origin).origin;

  /**
   * @param {{ page: import("playwright").Page, frame: import("playwright").Frame }} source
   * @param {CspViolationReport | null | undefined} report
   */
  function receiveViolation(source, report) {
    let sourceValid = false;
    try {
      const frameUrl = new URL(source.frame.url());
      sourceValid =
        source.page === page &&
        source.frame === page.mainFrame() &&
        frameUrl.origin === expectedOrigin;
    } catch {}
    diagnostics.observeViolation(report, {
      sourceValid,
      tokenValid: report?.token === token,
    });
  }
  await page.exposeBinding(bindingName, receiveViolation);

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
          appOwnedClass:
            target?.classList?.contains("nivra-select-bubble") === true,
          ariaHidden: target?.getAttribute("aria-hidden") ?? null,
          tabIndex: target?.tabIndex ?? null,
          hasStyleAttribute: target?.hasAttribute("style") === true,
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

  return diagnostics;
}
