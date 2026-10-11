export default async function review(page) {
  if (new URL(page.url()).port !== "3004")
    throw new Error("Disposable review server required.");
  await page.setViewportSize({ width: 1440, height: 900 });
  const results = [];
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
    results.push(message);
  };
  const base = new URL(page.url()).origin;
  await page.evaluate(async () => {
    const status = await (await fetch("/api/v1/status")).json();
    if (!status.setup) throw new Error("Empty synthetic owner required.");
    const setup = await fetch("/api/v1/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Background Review Owner",
        username: "backgroundreview",
        password: crypto.randomUUID() + crypto.randomUUID(),
      }),
    });
    if (!setup.ok) throw new Error("Synthetic setup failed.");
    const settings = await fetch("/api/v1/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ onboardingStep: "complete" }),
    });
    if (!settings.ok) throw new Error("Synthetic onboarding failed.");
  });
  await page.reload();
  await page
    .getByRole("button", { name: "Bookmarks", exact: true })
    .first()
    .click();
  await page
    .getByPlaceholder("https://…")
    .fill("http://127.0.0.1/synthetic-preview");
  await page.getByRole("button", { name: "Save link", exact: true }).click();
  await page.getByText("Fetching preview…", { exact: true }).waitFor();
  check(true, "Bookmark acknowledgement exposes a pending preview");
  await page
    .getByText("Preview unavailable. Retry from the card menu.", {
      exact: true,
    })
    .waitFor({ timeout: 30000 });
  check(true, "SSE replaces pending state after bounded preview failure");
  await page
    .getByRole("button", { name: "Artifacts", exact: true })
    .first()
    .click();
  const uploaded = await page.evaluate(async () => {
    const form = new FormData();
    form.set(
      "file",
      new File(
        ["Background searchable nebula document"],
        "background-nebula.txt",
        { type: "text/plain" },
      ),
    );
    const response = await fetch("/api/v1/artifacts", {
      method: "POST",
      body: form,
    });
    if (!response.ok) throw new Error("Synthetic upload failed");
    return await response.json();
  });
  check(
    uploaded.extraction === "pending",
    "File acknowledgement precedes text extraction",
  );
  await page
    .getByText("Background searchable nebula document", { exact: false })
    .first()
    .waitFor({ timeout: 30000 });
  check(true, "SSE updates the artifact shelf without a reload");
  await page
    .getByRole("button", { name: "Search", exact: true })
    .first()
    .click();
  await page.getByPlaceholder("Search everything…").fill("nebula");
  await page
    .getByText("Background searchable nebula document", { exact: false })
    .first()
    .waitFor();
  check(true, "Extracted text is discoverable in unified search");
  await page.keyboard.press("Escape");
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles("tests/fixtures/ocr-sample.png");
  await page
    .getByRole("button", { name: "Open ocr-sample.png", exact: true })
    .click();
  await page
    .locator(".artifact-viewer")
    .getByText("Reading text…", { exact: false })
    .waitFor({ timeout: 30000 });
  await page
    .getByRole("textbox", { name: "Title", exact: true })
    .fill("Unfinished local title");
  await page
    .locator(".artifact-viewer pre")
    .filter({ hasText: "Northwind" })
    .waitFor({ timeout: 30000 });
  check(
    (await page
      .getByRole("textbox", { name: "Title", exact: true })
      .inputValue()) === "Unfinished local title",
    "SSE updates an open OCR viewer and preserves its unfinished title",
  );
  const snapshot = async (width, theme) => {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate((theme) => {
      document.documentElement.classList.toggle("dark", theme === "dark");
    }, theme);
    await page.waitForTimeout(200);
    check(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
      `${width}px ${theme} has no page overflow`,
    );
    const box = await page.locator(".artifact-viewer").boundingBox();
    check(
      box.x >= 0 && box.x + box.width <= width + 1,
      `${width}px ${theme} keeps viewer within viewport`,
    );
    await page.screenshot({
      path: `/tmp/nivra-background-${width}-${theme}.png`,
    });
  };
  for (const width of [1440, 390, 320])
    for (const theme of ["light", "dark"]) await snapshot(width, theme);
  const events = await page.evaluate(async () => {
    const controller = new AbortController();
    const response = await fetch("/api/v1/completions", {
      signal: controller.signal,
    });
    const reader = response.body.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value);
    controller.abort();
    return {
      type: response.headers.get("content-type"),
      cache: response.headers.get("cache-control"),
      chunk,
    };
  });
  check(
    events.type.startsWith("text/event-stream") &&
      events.cache.includes("no-store") &&
      events.chunk.includes("event: resync"),
    "Production stream flushes uncached resync immediately",
  );
  return { base, results };
}
