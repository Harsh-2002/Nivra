import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDateTime, formatDay, formatTime } from "../src/lib/dates";

test("shared formatters give one date and time style for every input type", () => {
  const moment = new Date(2026, 9, 16, 15, 45, 12);
  const english = Intl.DateTimeFormat()
    .resolvedOptions()
    .locale.startsWith("en");
  for (const value of [moment, moment.getTime(), moment.toISOString()]) {
    const day = formatDay(value);
    const time = formatTime(value);
    const both = formatDateTime(value);
    assert.doesNotMatch(time, /:12/, "seconds are never shown");
    assert.doesNotMatch(both, /:12/);
    if (english) {
      assert.equal(day, "Oct 16, 2026");
      assert.match(time, /^3:45\s?PM$/);
      assert.match(both, /^Oct 16, 2026,? (at )?3:45\s?PM$/);
    }
  }
});
