import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";

test("completion streams ignore closed sources and hidden-session probes", async () => {
  const code = transformSync(
    await readFile("src/lib/completion-client.ts", "utf8"),
    { loader: "ts", format: "cjs" },
  ).code;
  const effects: Array<() => void | (() => void)> = [];
  const timers: Array<() => void> = [];
  const listeners = new Map<string, () => void>();
  const events: unknown[] = [];
  const sources: Source[] = [];
  let probes = 0;
  let owner: object | null = {};
  let revoked = 0;
  class Source {
    handlers = new Map<string, Array<(event?: unknown) => void>>();
    constructor() {
      sources.push(this);
    }
    addEventListener(name: string, handler: (event?: unknown) => void) {
      this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
    }
    emit(name: string, event?: unknown) {
      for (const handler of this.handlers.get(name) ?? []) handler(event);
    }
    close() {
      this.emit("error");
    }
  }
  const document = {
    visibilityState: "visible",
    addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
    removeEventListener: (name: string) => listeners.delete(name),
  };
  const exports: Record<string, unknown> = {};
  const compiledModule = { exports };
  runInNewContext(code, {
    exports,
    module: compiledModule,
    require: (name: string) => {
      if (name === "react")
        return {
          useRef: (current: unknown) => ({ current }),
          useEffect: (effect: () => void | (() => void)) =>
            effects.push(effect),
        };
      if (name === "./client")
        return {
          api: async () => {
            probes++;
            return { owner };
          },
        };
      if (name === "./section-cache") return { sectionCache: { clear() {} } };
      throw new Error(`Unexpected dependency: ${name}`);
    },
    EventSource: Source,
    document,
    window: {
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: (event: unknown) => events.push(event),
    },
    CustomEvent: class {
      constructor(
        public type: string,
        public options: unknown,
      ) {}
    },
    setTimeout: (fn: () => void) => timers.push(fn),
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
  });
  (compiledModule.exports.useCompletionStream as (fn: () => void) => void)(
    () => revoked++,
  );
  const cleanups = effects.map((effect) => effect());
  timers.shift()!();
  const first = sources[0];
  document.visibilityState = "hidden";
  listeners.get("visibilitychange")!();
  first.emit("error");
  assert.equal(probes, 0, "closing/hidden sources must not probe a session");
  document.visibilityState = "visible";
  listeners.get("visibilitychange")!();
  const second = sources[1];
  first.emit("completion", { data: JSON.stringify({ kind: "content" }) });
  first.emit("revoked");
  assert.equal(events.length, 0);
  assert.equal(revoked, 0, "an obsolete source must not revoke the session");
  second.emit("completion", { data: JSON.stringify({ kind: "content" }) });
  assert.equal(events.length, 1, "active completion events still reach the UI");
  owner = null;
  second.emit("error");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probes, 1);
  assert.equal(
    revoked,
    1,
    "the active source still detects session revocation",
  );
  for (const cleanup of cleanups) cleanup?.();
  second.emit("error");
  assert.equal(probes, 1, "unmounted streams must not start another probe");
});
