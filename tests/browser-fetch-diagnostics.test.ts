import assert from "node:assert/strict";
import test from "node:test";
import {
  createBrowserFetchDiagnostics,
  parseNativeFetchCancellation,
  webkitNativeFetchCancellationName,
  webkitNativeFetchCancellationSuffix,
} from "../scripts/browser-fetch-diagnostics.mjs";

const origin = "http://127.0.0.1:3015";
const message = `${origin}/api/v1/tags${webkitNativeFetchCancellationSuffix}`;
const notesPreviewUrl = new URLSearchParams({
  view: "all",
  sort: "updated",
  q: "",
  limit: "61",
  preview: "1",
}).toString();
const notesPreviewMessage = `${origin}/api/v1/notes?${notesPreviewUrl}${webkitNativeFetchCancellationSuffix}`;
const nativeError = Object.assign(new Error(message), {
  name: webkitNativeFetchCancellationName,
});
let now = 1000;

function makeDiagnostics(engine: "chromium" | "firefox" | "webkit" = "webkit") {
  now = 1000;
  return createBrowserFetchDiagnostics({
    engine,
    origin,
    now: () => now,
    quietWindowMs: 0,
  });
}

function ready(diagnostics: ReturnType<typeof makeDiagnostics>) {
  diagnostics.observeDocumentEvent(
    {
      token: "valid",
      type: "ready",
      documentId: "22f5bde6-9dcb-4d04-9d22-685250e809fc",
      eventId: 0,
      origin,
      pathname: "/tasks",
      trusted: true,
    },
    { sourceValid: true, tokenValid: true },
  );
}

function navigation(diagnostics: ReturnType<typeof makeDiagnostics>) {
  diagnostics.observeNavigation({
    url: `${origin}/calendar?date=2026-10-14`,
    method: "GET",
    isMainFrame: true,
    isNavigation: true,
    observedAt: now,
    sourceDocumentId: "22f5bde6-9dcb-4d04-9d22-685250e809fc",
  });
}

test("defers only the exact native read cancellation during document navigation", () => {
  assert.deepEqual(parseNativeFetchCancellation(nativeError, origin), {
    origin,
    pathname: "/api/v1/tags",
  });
  const overviewError = Object.assign(
    new Error(
      `${origin}/api/v1/overview?date=2026-10-14&timezone=UTC${webkitNativeFetchCancellationSuffix}`,
    ),
    { name: webkitNativeFetchCancellationName },
  );
  assert.equal(
    parseNativeFetchCancellation(overviewError, origin)?.pathname,
    "/api/v1/overview",
  );
  const notesPreviewError = Object.assign(new Error(notesPreviewMessage), {
    name: webkitNativeFetchCancellationName,
  });
  assert.equal(
    parseNativeFetchCancellation(notesPreviewError, origin)?.pathname,
    "/api/v1/notes",
  );
  const diagnostics = makeDiagnostics();
  ready(diagnostics);
  diagnostics.observeApiRequest({
    url: `${origin}/api/v1/tags?limit=50`,
    method: "GET",
  });
  navigation(diagnostics);
  assert.equal(diagnostics.deferPageError(nativeError), true);
  assert.deepEqual(diagnostics.result(), { deferredCount: 1, errors: [] });
});

test("legacy loopback error formatting is accepted only for the same origin", () => {
  const legacy = Object.assign(
    new Error(
      `/127.0.0.1:3015/api/v1/tags${webkitNativeFetchCancellationSuffix}`,
    ),
    { name: webkitNativeFetchCancellationName },
  );
  assert.equal(
    parseNativeFetchCancellation(legacy, origin)?.pathname,
    "/api/v1/tags",
  );
  assert.equal(
    parseNativeFetchCancellation(legacy, "http://localhost:3015"),
    null,
  );
});

test("SPA, subframe, foreign, stale and unmonitored navigation contexts stay fatal", () => {
  const spa = makeDiagnostics();
  ready(spa);
  assert.equal(spa.deferPageError(nativeError), false);

  const subframe = makeDiagnostics();
  ready(subframe);
  subframe.observeNavigation({
    url: `${origin}/calendar`,
    method: "GET",
    isMainFrame: false,
    isNavigation: true,
    sourceDocumentId: "22f5bde6-9dcb-4d04-9d22-685250e809fc",
  });
  assert.equal(subframe.deferPageError(nativeError), false);

  const foreign = makeDiagnostics();
  ready(foreign);
  foreign.observeNavigation({
    url: "https://example.invalid/calendar",
    method: "GET",
    isMainFrame: true,
    isNavigation: true,
    sourceDocumentId: "22f5bde6-9dcb-4d04-9d22-685250e809fc",
  });
  assert.equal(foreign.deferPageError(nativeError), false);

  for (const invalidNavigation of [
    {
      url: "https://example.invalid/calendar",
      method: "GET",
      sourceDocumentId: "22f5bde6-9dcb-4d04-9d22-685250e809fc",
    },
    {
      url: `${origin}/calendar`,
      method: "POST",
      sourceDocumentId: "22f5bde6-9dcb-4d04-9d22-685250e809fc",
    },
    { url: `${origin}/calendar`, method: "GET", sourceDocumentId: null },
  ]) {
    const invalidated = makeDiagnostics();
    ready(invalidated);
    navigation(invalidated);
    invalidated.observeNavigation({
      ...invalidNavigation,
      isMainFrame: true,
      isNavigation: true,
      observedAt: now,
    });
    assert.equal(invalidated.deferPageError(nativeError), false);
  }

  const stale = makeDiagnostics();
  ready(stale);
  navigation(stale);
  now += 2001;
  assert.equal(stale.deferPageError(nativeError), false);

  const unmonitored = makeDiagnostics();
  ready(unmonitored);
  unmonitored.observeNavigation({
    url: `${origin}/calendar`,
    method: "GET",
    isMainFrame: true,
    isNavigation: true,
    sourceDocumentId: null,
  });
  assert.equal(unmonitored.deferPageError(nativeError), false);
  assert.match(
    unmonitored.result().errors.join(" "),
    /without a ready error monitor/,
  );
});

test("only listed read paths and exact native error signatures qualify", () => {
  for (const pathname of [
    "/api/v1/tasks",
    "/api/v1/notes",
    "/api/v1/favorites",
    "/api/v1/tags/123",
    "/api/v1/tags/../tasks",
    "/api/v1/tags#fragment",
    `/api/v1/tags?${"q".repeat(513)}`,
  ]) {
    const error = Object.assign(
      new Error(`${origin}${pathname}${webkitNativeFetchCancellationSuffix}`),
      { name: webkitNativeFetchCancellationName },
    );
    assert.equal(parseNativeFetchCancellation(error, origin), null, pathname);
  }
  assert.equal(
    parseNativeFetchCancellation(
      Object.assign(new Error(message), { name: "TypeError" }),
      origin,
    ),
    null,
  );
  assert.equal(
    parseNativeFetchCancellation(
      Object.assign(new Error(`${message} extra`), {
        name: webkitNativeFetchCancellationName,
      }),
      origin,
    ),
    null,
  );
  assert.equal(
    parseNativeFetchCancellation(
      Object.assign(
        new Error(
          `https://evil.invalid/api/v1/tags${webkitNativeFetchCancellationSuffix}`,
        ),
        { name: webkitNativeFetchCancellationName },
      ),
      origin,
    ),
    null,
  );
  assert.equal(
    parseNativeFetchCancellation(
      Object.assign(
        new Error(`/api/v1/tags${webkitNativeFetchCancellationSuffix}`),
        { name: webkitNativeFetchCancellationName },
      ),
      origin,
    ),
    null,
  );
  assert.equal(makeDiagnostics("chromium").deferPageError(nativeError), false);
});

test("notes cancellation requires the bounded workspace preview-list query", () => {
  const validSorts = ["updated", "created", "title"];
  for (const sort of validSorts) {
    const url = new URL(`${origin}/api/v1/notes`);
    url.search = new URLSearchParams({
      view: "all",
      sort,
      q: "wireless battery",
      limit: "61",
      preview: "1",
      offset: "60",
    }).toString();
    assert.equal(
      parseNativeFetchCancellation(
        Object.assign(
          new Error(`${url.href}${webkitNativeFetchCancellationSuffix}`),
          { name: webkitNativeFetchCancellationName },
        ),
        origin,
      )?.pathname,
      "/api/v1/notes",
    );
  }

  const invalidQueries = [
    "",
    "view=all&sort=updated&limit=61&preview=1",
    `view=all&sort=updated&q=${"x".repeat(301)}&limit=61&preview=1`,
    "view=all&sort=updated&q=&limit=100&preview=1",
    "view=all&sort=updated&q=&limit=61&preview=0",
    "view=all&sort=other&q=&limit=61&preview=1",
    "view=favorites&sort=updated&q=&limit=61&preview=1",
    "view=all&sort=updated&q=&limit=61&preview=1&tag=123",
    "view=all&sort=updated&q=&limit=61&preview=1&offset=1000001",
    "view=all&view=all&sort=updated&q=&limit=61&preview=1",
  ];
  for (const query of invalidQueries) {
    const target = `${origin}/api/v1/notes${query ? `?${query}` : ""}`;
    const error = Object.assign(
      new Error(`${target}${webkitNativeFetchCancellationSuffix}`),
      { name: webkitNativeFetchCancellationName },
    );
    assert.equal(parseNativeFetchCancellation(error, origin), null, target);
  }

  const bareNotes = makeDiagnostics();
  assert.equal(
    bareNotes.observeApiRequest({
      url: `${origin}/api/v1/notes`,
      method: "POST",
    }),
    undefined,
  );
  assert.equal(
    parseNativeFetchCancellation(
      Object.assign(
        new Error(
          `${origin}/api/v1/notes${webkitNativeFetchCancellationSuffix}`,
        ),
        { name: webkitNativeFetchCancellationName },
      ),
      origin,
    ),
    null,
  );
});

test("journal cancellation requires the bounded workspace journal-list query", () => {
  const validQueries = [
    "period=daily&limit=60",
    "period=weekly&limit=60&q=field+notes",
    `period=monthly&limit=60&q=&after=${encodeURIComponent("opaque.cursor.v1")}`,
  ];
  for (const query of validQueries) {
    const error = Object.assign(
      new Error(
        `${origin}/api/v1/journals?${query}${webkitNativeFetchCancellationSuffix}`,
      ),
      { name: webkitNativeFetchCancellationName },
    );
    assert.equal(
      parseNativeFetchCancellation(error, origin)?.pathname,
      "/api/v1/journals",
    );
  }

  const invalidQueries = [
    "",
    "period=yearly&limit=60",
    "period=daily&limit=61",
    `period=daily&limit=60&q=${"x".repeat(301)}`,
    `period=daily&limit=60&after=${"c".repeat(513)}`,
    "period=daily&limit=60&from=2026-01-01",
    "period=daily&limit=60&to=2026-01-31",
    "period=daily&period=weekly&limit=60",
    "period=daily&limit=60&after=cursor&after=other",
  ];
  for (const query of invalidQueries) {
    const target = `${origin}/api/v1/journals${query ? `?${query}` : ""}`;
    const error = Object.assign(
      new Error(`${target}${webkitNativeFetchCancellationSuffix}`),
      { name: webkitNativeFetchCancellationName },
    );
    assert.equal(parseNativeFetchCancellation(error, origin), null, target);
  }

  const createJournal = makeDiagnostics();
  assert.equal(
    createJournal.observeApiRequest({
      url: `${origin}/api/v1/journals`,
      method: "POST",
    }),
    undefined,
  );
  assert.equal(
    parseNativeFetchCancellation(
      Object.assign(
        new Error(
          `${origin}/api/v1/journals${webkitNativeFetchCancellationSuffix}`,
        ),
        { name: webkitNativeFetchCancellationName },
      ),
      origin,
    ),
    null,
  );
});

test("a matching mutation request and real uncaught events remain fatal", () => {
  const mutation = makeDiagnostics();
  ready(mutation);
  mutation.observeApiRequest({ url: `${origin}/api/v1/tags`, method: "POST" });
  navigation(mutation);
  assert.equal(mutation.deferPageError(nativeError), false);

  const longRunningMutation = makeDiagnostics();
  ready(longRunningMutation);
  longRunningMutation.observeApiRequest({
    url: `${origin}/api/v1/tags`,
    method: "POST",
    requestId: "long-running",
  });
  now += 3000;
  navigation(longRunningMutation);
  assert.equal(longRunningMutation.deferPageError(nativeError), false);

  const recentlyCompletedMutation = makeDiagnostics();
  ready(recentlyCompletedMutation);
  recentlyCompletedMutation.observeApiRequest({
    url: `${origin}/api/v1/tags`,
    method: "PATCH",
    requestId: "recently-completed",
  });
  now += 5;
  recentlyCompletedMutation.finishApiRequest("recently-completed");
  navigation(recentlyCompletedMutation);
  assert.equal(recentlyCompletedMutation.deferPageError(nativeError), false);

  const notesMutation = makeDiagnostics();
  ready(notesMutation);
  notesMutation.observeApiRequest({
    url: `${origin}/api/v1/notes?${notesPreviewUrl}`,
    method: "POST",
  });
  navigation(notesMutation);
  assert.equal(
    notesMutation.deferPageError(
      Object.assign(new Error(notesPreviewMessage), {
        name: webkitNativeFetchCancellationName,
      }),
    ),
    false,
  );

  const lateNotesMutation = makeDiagnostics();
  ready(lateNotesMutation);
  navigation(lateNotesMutation);
  const notesPreviewError = Object.assign(new Error(notesPreviewMessage), {
    name: webkitNativeFetchCancellationName,
  });
  assert.equal(lateNotesMutation.deferPageError(notesPreviewError), true);
  lateNotesMutation.observeApiRequest({
    url: `${origin}/api/v1/notes?${notesPreviewUrl}`,
    method: "POST",
  });
  assert.ok(
    lateNotesMutation
      .result()
      .errors.some((entry) => /mutation request/.test(entry)),
  );

  const journalMutation = makeDiagnostics();
  ready(journalMutation);
  journalMutation.observeApiRequest({
    url: `${origin}/api/v1/journals?period=daily&limit=60`,
    method: "POST",
  });
  navigation(journalMutation);
  assert.equal(
    journalMutation.deferPageError(
      Object.assign(
        new Error(
          `${origin}/api/v1/journals?period=daily&limit=60${webkitNativeFetchCancellationSuffix}`,
        ),
        { name: webkitNativeFetchCancellationName },
      ),
    ),
    false,
  );

  const delayedMutationEvidence = makeDiagnostics();
  ready(delayedMutationEvidence);
  navigation(delayedMutationEvidence);
  assert.equal(delayedMutationEvidence.deferPageError(nativeError), true);
  delayedMutationEvidence.observeApiRequest({
    url: `${origin}/api/v1/tags`,
    method: "DELETE",
    requestId: "observed-after-pageerror",
  });
  assert.ok(
    delayedMutationEvidence
      .result()
      .errors.some((entry) => /mutation request/.test(entry)),
  );

  const actualError = makeDiagnostics();
  ready(actualError);
  navigation(actualError);
  assert.equal(actualError.deferPageError(nativeError), true);
  actualError.observeDocumentEvent(
    {
      token: "valid",
      type: "error",
      documentId: "22f5bde6-9dcb-4d04-9d22-685250e809fc",
      eventId: 1,
      origin,
      pathname: "/tasks",
      trusted: true,
    },
    { sourceValid: true, tokenValid: true },
  );
  assert.ok(
    actualError
      .result()
      .errors.some((entry) => /uncaught browser error/i.test(entry)),
  );
  assert.ok(
    actualError
      .result()
      .errors.some((entry) =>
        /Native-looking pageerror accompanied/.test(entry),
      ),
  );

  const rejection = makeDiagnostics();
  ready(rejection);
  navigation(rejection);
  rejection.observeDocumentEvent(
    {
      token: "valid",
      type: "unhandledrejection",
      documentId: "22f5bde6-9dcb-4d04-9d22-685250e809fc",
      eventId: 1,
      origin,
      pathname: "/tasks",
      trusted: true,
    },
    { sourceValid: true, tokenValid: true },
  );
  assert.equal(rejection.deferPageError(nativeError), false);
  assert.ok(
    rejection
      .result()
      .errors.some((entry) => /unhandledrejection/i.test(entry)),
  );
});

test("untrusted or malformed document events fail closed", () => {
  const diagnostics = makeDiagnostics();
  diagnostics.observeDocumentEvent(
    {
      token: "wrong",
      type: "ready",
      documentId: "22f5bde6-9dcb-4d04-9d22-685250e809fc",
      eventId: 0,
      origin,
      pathname: "/tasks",
      trusted: true,
    },
    { sourceValid: true, tokenValid: false },
  );
  assert.match(diagnostics.result().errors.join(" "), /trusted main-document/);
});

test("defers only validated calendar range read cancellations", () => {
  const range = (query: string) =>
    Object.assign(
      new Error(
        `${origin}/api/v1/calendar/range?${query}${webkitNativeFetchCancellationSuffix}`,
      ),
      { name: webkitNativeFetchCancellationName },
    );
  const week =
    "from=2027-03-21&to=2027-03-28&timezone=UTC&mode=planning&limit=500&preview=50&includeCompleted=0";
  const day =
    "from=2027-03-27&to=2027-03-28&timezone=Europe%2FLondon&mode=activity&limit=50&includeCompleted=1&offset=50";
  assert.equal(
    parseNativeFetchCancellation(range(week), origin)?.pathname,
    "/api/v1/calendar/range",
  );
  assert.equal(
    parseNativeFetchCancellation(range(day), origin)?.pathname,
    "/api/v1/calendar/range",
  );
  for (const bad of [
    `${week}&unexpected=1`,
    week.replace("from=2027-03-21", "from=tomorrow"),
    week.replace("mode=planning", "mode=admin"),
    `${week}&from=2027-03-22`,
    week.replace("includeCompleted=0", "includeCompleted=2"),
    week.replace("timezone=UTC", "timezone=../../etc"),
    week.replace("limit=500&", ""),
  ])
    assert.equal(parseNativeFetchCancellation(range(bad), origin), null, bad);
});
