export default async function verifyNivra(page, phase) {
  const base = new URL(page.url());
  if (base.port !== "3004")
    throw new Error("Use the disposable review server on port 3004.");
  const status = await page.request.get(new URL("/api/v1/status", base).href);
  if ((await status.json()).owner?.name !== "Review Owner")
    throw new Error("The disposable Review Owner session is required.");
  page.setDefaultTimeout(10000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(base.origin);
  await page.getByRole("button", { name: "Tasks", exact: true }).waitFor();
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  const passed = [];
  const check = (condition, name) => {
    if (!condition) throw new Error(name);
    passed.push(name);
  };
  const button = (name) => page.getByRole("button", { name, exact: true });
  const textbox = (name) => page.getByRole("textbox", { name, exact: true });
  const api = async (path, method = "GET", data) => {
    const response = await page.request.fetch(`${base.origin}/api/v1/${path}`, {
      method,
      data,
    });
    if (!response.ok())
      throw new Error(
        `Fixture API failed: ${method} ${path} ${response.status()}`,
      );
    return response.json();
  };
  const stamp = Date.now();
  if (phase === "tasks") {
    await button("Tasks").click();
    const first = `Regression alpha ${stamp}`;
    const second = `Regression beta ${stamp}`;
    for (const title of [first, second]) {
      await textbox("New task").fill(title);
      await button("Add task").click();
      await page
        .getByRole("checkbox", { name: `Complete ${title}`, exact: true })
        .waitFor();
    }
    check(true, "Task creation through UI");
    await page
      .getByRole("checkbox", { name: `Complete ${first}`, exact: true })
      .click();
    await page.getByRole("button", { name: /^Completed / }).click();
    await page
      .getByRole("checkbox", { name: `Reopen ${first}`, exact: true })
      .click();
    await page.getByRole("button", { name: /^Open \d+$/ }).click();
    await page
      .getByRole("checkbox", { name: `Complete ${first}`, exact: true })
      .waitFor();
    check(true, "Task completion and reopening");
    await button(`Actions for ${first}`).click();
    await page
      .getByRole("menuitem", { name: "Edit task", exact: true })
      .click();
    await textbox("Edit task").fill(`${first} edited`);
    check(
      await button(`Actions for ${second}`).isDisabled(),
      "Another task cannot overwrite an edit draft",
    );
    check(
      await textbox("Search tasks").isDisabled(),
      "Search cannot hide a task edit draft",
    );
    check(
      await button("Refresh tasks").isDisabled(),
      "Refresh cannot invalidate an active task edit",
    );
    await button("Bookmarks").click();
    await page.getByRole("alertdialog").waitFor();
    await button("Cancel").click();
    check(
      (await textbox("Edit task").inputValue()) === `${first} edited`,
      "Cancelled navigation preserves task draft",
    );
    check(
      await page.evaluate(
        () =>
          !window.dispatchEvent(
            new Event("beforeunload", { cancelable: true }),
          ),
      ),
      "Task edits guard browser navigation",
    );
    await button("Save").click();
    await page
      .getByRole("checkbox", { name: `Complete ${first} edited`, exact: true })
      .waitFor();
    await page.keyboard.press("Control+k");
    check(
      await page
        .getByRole("combobox", { name: "Search everything", exact: true })
        .evaluate((element) => element === document.activeElement),
      "Global search keyboard shortcut from tasks",
    );
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    const failure = (route) =>
      route.request().method() === "POST"
        ? route.fulfill({
            status: 500,
            contentType: "application/json",
            body: '{"error":"Simulated task failure"}',
          })
        : route.continue();
    await page.route("**/api/v1/tasks", failure);
    try {
      await textbox("New task").fill("Retain this failed task");
      await button("Add task").click();
      await page
        .getByRole("alert")
        .filter({ hasText: "Simulated task failure" })
        .waitFor();
      check(
        (await textbox("New task").inputValue()) === "Retain this failed task",
        "Failed task creation preserves input",
      );
    } finally {
      await page.unroute("**/api/v1/tasks", failure);
    }
    await textbox("New task").fill("");
    await button(`Actions for ${second}`).click();
    await page
      .getByRole("menuitem", { name: "Delete task", exact: true })
      .click();
    await page.getByRole("alertdialog").waitFor();
    await button("Cancel").click();
    await page.getByRole("alertdialog").waitFor({ state: "hidden" });
    check(
      await button(`Actions for ${second}`).isVisible(),
      "Cancelled task deletion preserves task",
    );
    await button(`Actions for ${second}`).click();
    await page
      .getByRole("menuitem", { name: "Delete task", exact: true })
      .click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Delete task", exact: true })
      .click();
    await button(`Actions for ${second}`).waitFor({ state: "hidden" });
    check(true, "Confirmed task deletion");
  } else if (phase === "bookmarks") {
    await button("Bookmarks").click();
    await page.locator(".bookmark-grid").waitFor();
    const url = `http://127.0.0.1/audit-${stamp}`;
    await textbox("Link").fill(url);
    await textbox("Collection (optional)").fill("Regression");
    await button("Save link").click();
    await page.locator(`.bookmark-link[href="${url}"]`).waitFor();
    check(
      true,
      "Unfetchable URL saves a fallback bookmark without private-network fetch",
    );
    await textbox("Link").fill(url);
    await button("Save link").click();
    await page
      .getByRole("alert")
      .filter({ hasText: /already saved/i })
      .waitFor();
    check(
      (await textbox("Link").inputValue()) === url,
      "Duplicate bookmark preserves input with an error",
    );
    await textbox("Link").fill("");
    const card = page
      .locator(".bookmark-card")
      .filter({ has: page.locator(`a[href="${url}"]`) });
    await card.getByRole("button", { name: /Actions for/ }).click();
    await page
      .getByRole("menuitem", { name: "Edit details", exact: true })
      .click();
    await textbox("Title").fill(`Regression bookmark ${stamp}`);
    check(
      await textbox("Search bookmarks").isDisabled(),
      "Search cannot hide bookmark edit draft",
    );
    check(
      await page
        .getByRole("combobox", { name: "Filter bookmark collection" })
        .isDisabled(),
      "Collection filter protects bookmark edit draft",
    );
    await button("Tasks").click();
    await page.getByRole("alertdialog").waitFor();
    await button("Cancel").click();
    check(
      (await textbox("Title").inputValue()) === `Regression bookmark ${stamp}`,
      "Cancelled navigation preserves bookmark draft",
    );
    await page
      .locator(".bookmark-edit")
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await card
      .getByRole("link")
      .filter({ hasText: `Regression bookmark ${stamp}` })
      .waitFor();
    await card.getByRole("button", { name: /favorite/i }).click();
    check(
      (await api("bookmarks")).some(
        (item) => item.url === url && item.favorite,
      ),
      "Bookmark favorite persists",
    );
    await textbox("Search bookmarks").fill("Regrssion");
    await card.waitFor();
    check(true, "Bookmark typo-tolerant search through UI");
    await textbox("Search bookmarks").fill("");
    await card.getByRole("button", { name: /Actions for/ }).click();
    await page
      .getByRole("menuitem", { name: "Refresh preview", exact: true })
      .click();
    await page
      .getByRole("alert")
      .filter({ hasText: /preview/i })
      .waitFor();
    check(
      (await api("bookmarks")).some(
        (item) =>
          item.url === url && item.title === `Regression bookmark ${stamp}`,
      ),
      "Failed preview refresh preserves authored metadata",
    );
    await page.reload();
    await button("Bookmarks").click();
    await card.waitFor();
    check(true, "Bookmark survives reload");
  } else if (phase === "notes") {
    await button("New note ⌥ N").click();
    await textbox("Note title").fill(`Regression note ${stamp}`);
    await textbox("Note content").fill("A durable searchable thought");
    await page.locator(".save-status.saved").waitFor();
    const id = await page
      .locator("[data-note-id]")
      .getAttribute("data-note-id");
    const failure = (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({
            status: 500,
            contentType: "application/json",
            body: '{"error":"Simulated note failure"}',
          })
        : route.continue();
    await page.route(`**/api/v1/notes/${id}`, failure);
    try {
      await textbox("Note title").fill("Retain failed note edit");
      await page.locator(".save-error").waitFor();
      check(
        (await textbox("Note title").inputValue()) ===
          "Retain failed note edit",
        "Failed autosave preserves note draft",
      );
    } finally {
      await page.unroute(`**/api/v1/notes/${id}`, failure);
    }
    await button("Try again").click();
    await page.locator(".save-status.saved").waitFor();
    check(
      (await api(`notes/${id}`)).title === "Retain failed note edit",
      "Autosave retry persists draft",
    );
    const saved = await api(`notes/${id}`);
    await api(`notes/${id}`, "PATCH", {
      revision: saved.revision,
      title: "Remote revision wins",
      document: saved.document,
      tags: saved.tags.map((tag) => tag.id),
    });
    await textbox("Note title").fill("Local conflict draft");
    await page.locator(".save-status.conflict").waitFor();
    check(
      (await api(`notes/${id}`)).title === "Remote revision wins",
      "Revision conflict cannot overwrite remote edit",
    );
    check(
      (await textbox("Note title").inputValue()) === "Local conflict draft",
      "Conflict preserves local draft",
    );
    await button("Save as new note").click();
    await page.locator(".save-status.saved").waitFor();
    check(
      (await page.locator("[data-note-id]").getAttribute("data-note-id")) !==
        id,
      "Conflict draft can be recovered as a separate note",
    );
    await button("Share and publish note").click();
    await button("Preview note").click();
    await page.locator(".publish-preview .bn-editor").waitFor();
    check(
      (await page.locator(".publish-preview").innerText()).includes(
        "A durable searchable thought",
      ),
      "Reader preview renders note content",
    );
    await button("Back to sharing").click();
    await button("Publish note").click();
    await textbox("Share link").waitFor();
    const link = await textbox("Share link").inputValue();
    check(
      new URL(link).pathname.startsWith("/share/"),
      "Sharing uses /share/ URL",
    );
    const context = await page.context().browser().newContext();
    try {
      const reader = await context.newPage();
      await reader.goto(link);
      await reader.locator(".publication-page .bn-editor").waitFor();
      const text = await reader.locator("body").innerText();
      check(
        text.includes("Shared note") &&
          text.includes("A durable searchable thought") &&
          !text.includes("Nivra"),
        "Anonymous sharing is readable without branding",
      );
      check(
        (await context.request.get(`${base.origin}/api/v1/notes`)).status() ===
          401,
        "Shared reader cannot access private notes",
      );
      await button("Stop sharing").click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Stop sharing", exact: true })
        .click();
      await button("Publish note").waitFor();
      check(
        (
          await context.request.get(
            `${base.origin}/api/v1/published/${new URL(link).pathname.split("/").pop()}`,
          )
        ).status() === 404,
        "Revoking share removes anonymous access",
      );
    } finally {
      await context.close();
    }
    await button("Close").click();
    await page.reload();
    await textbox("Search notes").fill("durble");
    await page.locator(".note-list-item").first().waitFor();
    check(true, "Notes and fuzzy full-text search survive reload");
  } else if (phase === "artifacts") {
    const title = `Imported-${stamp}`;
    const markdown =
      '# Imported regression\n\nMarkdown survived.\n\n```typescript\nconst greeting: string = "hello";\n```\n\n```mermaid\ngraph TD; A-->B\n```\n\n| Name | Value |\n| --- | --- |\n| Test | 42 |\n';
    await button("Settings").click();
    await page
      .getByRole("tab", { name: "Import & export", exact: true })
      .click();
    await page
      .locator(".settings-dialog input[type=file]")
      .first()
      .setInputFiles({
        name: `${title}.md`,
        mimeType: "text/markdown",
        buffer: Buffer.from(markdown),
      });
    await button("Import 1 file").click();
    await page.getByText("1 note imported.", { exact: true }).waitFor();
    await button("Close").click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await textbox("Search notes").fill(title);
    await page.locator(".note-list-item").filter({ hasText: title }).click();
    await textbox("Note content").waitFor();
    check(
      (await textbox("Note content").innerText()).includes(
        "Markdown survived.",
      ),
      "Markdown import renders authored text",
    );
    check(
      (await page.locator(".bn-editor table").count()) === 1,
      "Markdown table renders",
    );
    check(
      (await page
        .getByRole("combobox", { name: "Code language", exact: true })
        .count()) > 0,
      "Markdown source code renders with language control",
    );
    const id = await page
      .locator("[data-note-id]")
      .getAttribute("data-note-id");
    const note = await api(`notes/${id}`);
    check(
      note.document.blocks.some((block) => block.type === "diagram"),
      "Mermaid Markdown import preserves a diagram block",
    );
    await page.locator('[data-content-type="diagram"] svg').first().waitFor();
    check(true, "Mermaid diagram renders as SVG");
    await page
      .locator('[data-content-type="paragraph"] .bn-inline-content')
      .last()
      .click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/drawing");
    await page.getByRole("option", { name: /^Drawing/ }).click();
    await button("Edit drawing").first().click();
    const canvas = page.locator(".excalidraw canvas").first();
    await canvas.waitFor();
    const bounds = await canvas.boundingBox();
    await page.mouse.click(bounds.x + 100, bounds.y + 100);
    await page.keyboard.press("r");
    await page.mouse.move(bounds.x + 100, bounds.y + 100);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 280, bounds.y + 180, { steps: 8 });
    await page.mouse.up();
    await button("Save drawing").click();
    await page.locator(".canvas-dialog").waitFor({ state: "hidden" });
    await page
      .getByRole("img", { name: "Drawing preview", exact: true })
      .waitFor();
    await page.locator(".save-status.saved").waitFor();
    check(
      (await api(`notes/${id}`)).document.blocks.some(
        (block) => block.type === "canvas" && block.props.preview,
      ),
      "Drawing save persists editable scene and preview",
    );
    await button("Note actions").click();
    await page
      .getByRole("menuitem", { name: "Move to trash", exact: true })
      .click();
    await button("Trash").click();
    await page.locator(".note-list-item").filter({ hasText: title }).click();
    await page.locator(".trash-banner").waitFor();
    check(
      (await api(`notes/${id}`)).trashedAt !== null,
      "Trash state persists",
    );
    await page
      .locator(".trash-banner")
      .getByRole("button", { name: "Restore", exact: true })
      .click();
    await page.locator(".trash-banner").waitFor({ state: "hidden" });
    check(
      (await api(`notes/${id}`)).trashedAt === null,
      "Restore recovers note from trash",
    );
    await button("Notes").click();
    await textbox("Search notes").fill(title);
    await page.locator(".note-list-item").filter({ hasText: title }).click();
    await textbox("Note title").waitFor();
    const longTitle = "Long title 中文 العربية " + "Unbroken".repeat(30);
    await textbox("Note title").fill(longTitle);
    await page.locator(".save-status.saved").waitFor();
    await page.setViewportSize({ width: 320, height: 844 });
    await page.waitForFunction(() => {
      const e = document.querySelector(".note-title");
      return e && e.scrollHeight <= e.clientHeight + 2;
    });
    check(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "Long multilingual title fits narrow viewport without clipping",
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await textbox("Note title").fill(title);
    await page.locator(".save-status.saved").waitFor();
  } else if (phase === "security") {
    const context = await page.context().browser().newContext();
    try {
      for (const path of [
        "notes",
        "tags",
        "tasks",
        "bookmarks",
        "backups",
        "files/missing",
        "export/bundle",
        "settings",
      ]) {
        check(
          (
            await context.request.get(`${base.origin}/api/v1/${path}`)
          ).status() === 401,
          `Anonymous ${path} denied`,
        );
      }
      const csrf = await page.request.post(`${base.origin}/api/v1/tasks`, {
        headers: { origin: "https://other.invalid" },
        data: { title: "Cross-origin attempt" },
      });
      check(csrf.status() === 403, "Cross-origin mutation denied");
      const invalid = await page.request.post(
        `${base.origin}/api/v1/bookmarks`,
        { data: { url: "javascript:alert(1)" } },
      );
      check(invalid.status() === 400, "Unsafe bookmark protocol denied");
      const response = await page.request.get(`${base.origin}/api/v1/notes`);
      check(
        response.headers()["cache-control"] === "no-store",
        "Private API forbids caching",
      );
    } finally {
      await context.close();
    }
  } else
    throw new Error("Choose tasks, bookmarks, notes, artifacts or security.");
  return { phase, passed, count: passed.length };
}
