import assert from "node:assert/strict";

export default async function verifyPlanning(page) {
  const base = new URL(page.url());
  const configuredPhoneWidth = (process.env.NIVRA_AUDIT_WIDTHS ?? "")
    .split(",")
    .map(Number)
    .find((width) => width >= 320 && width < 768 && width !== 390);
  const phoneWidths = configuredPhoneWidth
    ? [390, configuredPhoneWidth]
    : [390];
  if (base.port !== "3015")
    throw new Error("Use the disposable Review Owner server on port 3015.");
  const status = await page.request.get(new URL("/api/v1/status", base).href);
  if ((await status.json()).owner?.name !== "Review Owner")
    throw new Error("The disposable Review Owner session is required.");

  page.setDefaultTimeout(10000);
  const checks = [];
  const check = (condition, name) => {
    assert.ok(condition, name);
    checks.push(name);
  };
  const button = (name) => page.getByRole("button", { name, exact: true });
  const textbox = (name) => page.getByRole("textbox", { name, exact: true });
  const api = async (path, method = "GET", data) => {
    const response = await page.request.fetch(
      new URL("/api/v1/" + path, base).href,
      { method, data },
    );
    if (!response.ok())
      throw new Error(
        "Planning fixture request failed: " +
          method +
          " " +
          path +
          " " +
          response.status(),
      );
    if (response.status() === 204) return null;
    return response.json();
  };
  async function verifyMobileTaskDialog(width) {
    const expectedViewport = { width, height: 844 };
    await page.setViewportSize(expectedViewport);
    check(
      await page.locator(".schedule-time-grid").isHidden(),
      `${width}px mobile uses the agenda instead of the desktop time grid`,
    );
    await button("New task").click();
    const taskDialog = page.locator(".planning-task-dialog");
    await taskDialog.waitFor();
    let dialogBounds = await taskDialog.boundingBox();
    let viewportBounds = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    const matchesViewport = () =>
      dialogBounds?.x === 0 &&
      dialogBounds.y === 0 &&
      dialogBounds.width === expectedViewport.width &&
      dialogBounds.height === expectedViewport.height &&
      viewportBounds.width === expectedViewport.width &&
      viewportBounds.height === expectedViewport.height;
    let fullScreen = matchesViewport();
    const layoutDeadline = Date.now() + 1000;
    while (!fullScreen && Date.now() < layoutDeadline) {
      await page.waitForTimeout(40);
      dialogBounds = await taskDialog.boundingBox();
      viewportBounds = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }));
      fullScreen = matchesViewport();
    }
    check(
      fullScreen,
      `${width}px task scheduler uses exact fullscreen bounds (dialog ${JSON.stringify(dialogBounds)}, viewport ${JSON.stringify(viewportBounds)})`,
    );
    const touchTarget = await button("Cancel").boundingBox();
    check(
      touchTarget.height >= 44,
      `${width}px mobile task scheduler actions meet the 44px target`,
    );
    await button("Cancel").click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
  }

  const stamp = Date.now();
  const planningDate = new Date();
  planningDate.setUTCDate(planningDate.getUTCDate() + 45 + (stamp % 120));
  const planningDateValue = planningDate.toISOString().slice(0, 10);
  const dueDate = new Date(planningDate);
  dueDate.setUTCDate(dueDate.getUTCDate() + 30);
  const firstTitle = "Planning checklist " + stamp;
  const secondTitle = "Planning slot task " + stamp;
  const first = await api("tasks", "POST", {
    title: firstTitle,
    dueDate: dueDate.toISOString().slice(0, 10),
    plannedDate: planningDateValue,
  });
  const second = await api("tasks", "POST", { title: secondTitle });
  let recurringEvent;
  const cleanup = async () => {
    if (recurringEvent) {
      try {
        const event = await api("events/" + recurringEvent.id);
        await api("events/" + recurringEvent.id, "DELETE", {
          revision: event.revision,
          scope: "series",
        });
      } catch {}
    }
    for (const id of [first.id, second.id]) {
      try {
        const task = await api("tasks/" + id);
        await api("tasks/" + id, "DELETE", { revision: task.revision });
      } catch {}
    }
  };

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    if (new URL(page.url()).pathname !== "/tasks")
      await page.goto(new URL("/tasks", base).href);
    await page.locator(".tasks-panel").waitFor();
    await button("Actions for " + firstTitle).click();
    await page.getByRole("menuitem", { name: "View details" }).click();
    await page.getByRole("heading", { name: "Task details" }).waitFor();
    check(
      !(await page.getByRole("textbox", { name: "Edit task" }).count()),
      "Task opens in a read-only details view",
    );

    const addStep = textbox("Add a checklist step");
    await addStep.fill("Check the battery connection");
    await addStep.press("Enter");
    await page
      .getByRole("checkbox", {
        name: "Complete step: Check the battery connection",
      })
      .waitFor();
    await addStep.fill("Review the load test");
    await button("Add checklist step").click();
    await page
      .getByRole("button", { name: "Edit step: Review the load test" })
      .waitFor();
    await page
      .getByRole("checkbox", {
        name: "Complete step: Check the battery connection",
      })
      .click();
    await button("Move Review the load test up").click();
    await page
      .getByRole("button", { name: "Edit step: Review the load test" })
      .click();
    const stepEditor = textbox("Edit step: Review the load test");
    await stepEditor.fill("Inspect the load test");
    await stepEditor.press("Enter");
    await page.getByText("1 of 2 complete", { exact: true }).waitFor();
    const storedSteps = await api("tasks/" + first.id + "/steps");
    assert.deepEqual(
      storedSteps.items.map((step) => step.text),
      ["Inspect the load test", "Check the battery connection"],
    );
    check(
      storedSteps.items[1].completed,
      "Checklist completion and keyboard reordering persist",
    );

    await button("Edit task").click();
    await button("Reserve time").click();
    await textbox("Start time").fill("10:00");
    await button("Save task").click();
    await page.getByRole("heading", { name: "Task details" }).waitFor();
    const scheduled = await api("tasks/" + first.id);
    assert.equal(scheduled.schedule?.start.slice(11), "10:00");
    assert.equal(scheduled.schedule?.durationMinutes, 30);
    assert.equal(scheduled.plannedDate, scheduled.schedule?.start.slice(0, 10));
    check(
      true,
      "Task time block and planned date save together without creating an event",
    );

    const scheduledDate = scheduled.schedule.start.slice(0, 10);
    await page.goto(
      new URL(
        "/calendar?date=" + scheduledDate + "&view=week&mode=planning",
        base,
      ).href,
    );
    await page.locator(".schedule-panel").waitFor();
    await page.locator(".schedule-time-grid").waitFor();
    assert.equal(
      new URL(page.url()).searchParams.get("date"),
      scheduledDate,
      "Calendar keeps the selected date in the URL on initial navigation",
    );
    const timezone = await page.evaluate(
      () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    recurringEvent = await api("events", "POST", {
      title: "Recurring move scope " + stamp,
      description: "",
      location: "",
      allDay: false,
      start: scheduled.schedule.start.slice(0, 10) + "T12:00",
      end: scheduled.schedule.start.slice(0, 10) + "T12:30",
      timezone,
      disambiguation: "reject",
      recurrence: {
        frequency: "daily",
        interval: 1,
        weekdays: [],
        ordinal: null,
        monthDay: null,
        until: null,
        count: 3,
      },
      links: [],
      reminders: [],
    });
    await page.reload();
    await page.locator(".schedule-time-grid").waitFor();
    assert.equal(
      new URL(page.url()).searchParams.get("date"),
      scheduledDate,
      "Calendar keeps the selected date in the URL after reload",
    );
    const recurringBlock = page
      .locator(".schedule-time-entry-open")
      .filter({ hasText: "Recurring move scope " + stamp })
      .first();
    await recurringBlock.waitFor();
    await recurringBlock.scrollIntoViewIfNeeded();
    const blockBox = await recurringBlock.boundingBox();
    assert.ok(blockBox);
    await page.mouse.move(
      blockBox.x + blockBox.width / 2,
      blockBox.y + blockBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      blockBox.x + blockBox.width / 2,
      blockBox.y + blockBox.height / 2 + 12,
      { steps: 2 },
    );
    await page.mouse.up();
    await page.getByRole("heading", { name: "Edit event" }).waitFor();
    const scopeSelect = page.getByRole("combobox", {
      name: "Apply changes to",
    });
    await scopeSelect.waitFor();
    await scopeSelect.click();
    await page.getByRole("option", { name: "This occurrence" }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("heading", { name: "Edit event" }).waitFor();
    await page
      .locator('[data-slot="select-content"]')
      .waitFor({ state: "hidden" });
    await button("Cancel").waitFor();
    assert.equal(
      await scopeSelect.evaluate(
        (element) => document.activeElement === element,
      ),
      true,
      "Escape restores focus to the recurrence scope control",
    );
    check(
      true,
      "Escape closes the recurrence menu and keeps the event editor open",
    );
    await page
      .locator(".schedule-details summary")
      .filter({ hasText: "Repeat and reminders" })
      .click();
    const clockSelect = page.getByRole("combobox", {
      name: "Repeated clock time",
    });
    await clockSelect.click();
    await page.getByRole("option", { name: "Ask me to choose" }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("heading", { name: "Edit event" }).waitFor();
    await page
      .locator('[data-slot="select-content"]')
      .waitFor({ state: "hidden" });
    assert.equal(
      await clockSelect.evaluate(
        (element) => document.activeElement === element,
      ),
      true,
      "Escape restores focus to the repeated-time control",
    );
    check(
      true,
      "Escape also closes a form Select without dismissing the event editor",
    );
    await page.keyboard.press("Escape");
    await page
      .locator('[data-slot="dialog-content"].schedule-editor')
      .waitFor({ state: "hidden" });
    await page.locator(".schedule-time-grid").waitFor();
    check(
      true,
      "A second Escape closes the clean event editor after its menu is dismissed",
    );

    const slotLabel =
      "Plan a task on " + scheduled.schedule.start.slice(0, 10) + " at 10:30";
    const occupiedSlotLabel =
      "Plan a task on " + scheduled.schedule.start.slice(0, 10) + " at 10:00";
    const previousSlotLabel =
      "Plan a task on " + scheduled.schedule.start.slice(0, 10) + " at 09:30";
    const previousSlot = button(previousSlotLabel);
    await previousSlot.focus();
    await page.keyboard.press("ArrowDown");
    assert.equal(
      await page.evaluate(() =>
        document.activeElement?.getAttribute("aria-label"),
      ),
      slotLabel,
      "ArrowDown skips the occupied task block and focuses the next empty slot",
    );
    assert.equal(await button(occupiedSlotLabel).count(), 0);
    check(
      true,
      "Keyboard navigation skips an event-occupied time slot without stalling",
    );
    const shortBlock = page
      .locator(".schedule-time-entry")
      .filter({ hasText: firstTitle });
    const nextSlot = button(slotLabel);
    const shortBlockBounds = await shortBlock.boundingBox();
    const nextSlotBounds = await nextSlot.boundingBox();
    assert.ok(shortBlockBounds && nextSlotBounds);
    check(
      shortBlockBounds.y + shortBlockBounds.height <= nextSlotBounds.y + 1,
      "A 30-minute time block stays inside its half-hour slot",
    );
    await button(slotLabel).click();
    await page.getByRole("heading", { name: "Plan a task" }).waitFor();
    await textbox("Find an open task").fill(secondTitle);
    const candidate = page
      .locator(".planning-task-result")
      .filter({ hasText: secondTitle });
    await candidate.waitFor();
    await candidate.click();
    await page.locator("#calendar-new-task-duration").fill("60");
    await button("Schedule task").click();
    const placed = await api("tasks/" + second.id);
    assert.equal(placed.schedule?.start.slice(11), "10:30");
    assert.equal(placed.schedule?.durationMinutes, 60);
    check(
      placed.schedule?.start.slice(0, 10) ===
        scheduled.schedule.start.slice(0, 10),
      "An existing open task can be placed into a clicked calendar slot",
    );

    const taskBlock = page
      .locator(".schedule-time-entry")
      .filter({ hasText: secondTitle });
    await taskBlock.waitFor();
    const extendButton = button("Extend " + secondTitle + " by 15 minutes");
    const resizeResponsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/v1/tasks/" + second.id) &&
        response.request().method() === "PATCH",
    );
    await extendButton.focus();
    await extendButton.press("Enter");
    const resizeResponse = await resizeResponsePromise;
    assert.ok(
      resizeResponse.ok(),
      `Task resize failed: ${resizeResponse.status()}`,
    );
    const extended = await api("tasks/" + second.id);
    assert.equal(extended.schedule?.durationMinutes, 75);
    check(
      true,
      "Keyboard-accessible resize preserves the canonical task block",
    );

    const downloadPromise = page.waitForEvent("download");
    await button("Export").click();
    await page.getByRole("heading", { name: "Export calendar" }).waitFor();
    await button("Download snapshot").click();
    const calendarDownload = await downloadPromise;
    check(
      calendarDownload.suggestedFilename().endsWith(".ics"),
      "Calendar export downloads an iCalendar snapshot",
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.locator(".schedule-panel").waitFor();
    for (const width of phoneWidths) await verifyMobileTaskDialog(width);
    check(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "Planning screens do not overflow the mobile viewport",
    );
    return { passed: checks };
  } finally {
    await cleanup();
  }
}
