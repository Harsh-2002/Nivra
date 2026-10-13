import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function run(source: string) {
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", source],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr || child.stdout);
}

test("client schemas skip Zod's CSP eval probe while server schemas keep JIT", async (t) => {
  await t.test(
    "browser configuration runs before shared schemas are built",
    () => {
      run(`
      import assert from "node:assert/strict";
      globalThis.window = {};
      let probes = 0;
      const NativeFunction = globalThis.Function;
      globalThis.Function = new Proxy(NativeFunction, {
        construct(target, args, newTarget) {
          if (new Error().stack?.includes("/node_modules/zod/")) {
            probes += 1;
            throw new EvalError("blocked by CSP");
          }
          return Reflect.construct(target, args, newTarget);
        },
      });
      const { taskScheduleSchema } = await import("./src/lib/task-planning.ts");
      assert.equal(probes, 0);
      assert.equal(taskScheduleSchema.safeParse({
        start: "2026-10-13T09:00",
        timezone: "UTC",
        durationMinutes: 30,
        disambiguation: "reject",
      }).success, true);
      assert.equal(taskScheduleSchema.safeParse({
        start: "2026-10-13T09:00",
        timezone: "UTC",
        durationMinutes: 2,
        disambiguation: "reject",
      }).success, false);
      assert.equal(probes, 0);
    `);
    },
  );

  await t.test(
    "Node configuration leaves server JIT behavior unchanged",
    () => {
      run(`
      import assert from "node:assert/strict";
      assert.equal(typeof window, "undefined");
      let probes = 0;
      const NativeFunction = globalThis.Function;
      globalThis.Function = new Proxy(NativeFunction, {
        construct(target, args, newTarget) {
          if (new Error().stack?.includes("/node_modules/zod/")) probes += 1;
          return Reflect.construct(target, args, newTarget);
        },
      });
      const { z } = await import("./src/lib/zod.ts");
      assert.notEqual(z.config().jitless, true);
      assert.equal(
        z.object({ value: z.string() }).safeParse({ value: "ok" }).success,
        true,
      );
      assert.ok(probes > 0);
      assert.notEqual(z.config().jitless, true);
    `);
    },
  );
});
