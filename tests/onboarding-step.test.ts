import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { test } from "node:test";
import { randomUUID } from "node:crypto";

test("onboarding step migrates safely and remains owner-session state", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "nivra-onboarding-step-"),
  );
  process.env.NIVRA_DATA_DIR = directory;
  const routes = await import("../src/app/api/v1/[...path]/route");
  const authRoutes = await import("../src/app/api/auth/[...all]/route");
  const { sqlite } = await import("../src/lib/server/db");
  const origin = "http://localhost:3000";
  const cookies = new Map<string, string>();
  const save = (response: Response) => {
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";", 1)[0];
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (value) cookies.set(name, value);
      else cookies.delete(name);
    }
    return response;
  };
  const cookieHeader = () =>
    [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  const api = async (
    route: string,
    method = "GET",
    body?: unknown,
    options: { authenticated?: boolean; authorization?: string } = {},
  ) => {
    const headers = new Headers({ host: "localhost:3000", origin });
    if (options.authenticated !== false && cookies.size)
      headers.set("cookie", cookieHeader());
    if (options.authorization)
      headers.set("authorization", options.authorization);
    if (body !== undefined) headers.set("content-type", "application/json");
    const request = new Request(`${origin}/api/v1/${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const handler =
      method === "POST"
        ? routes.POST
        : method === "PATCH"
          ? routes.PATCH
          : routes.GET;
    return save(
      await handler(request, {
        params: Promise.resolve({ path: route.split("/") }),
      }),
    );
  };
  const auth = async (route: string, body: unknown) =>
    save(
      await authRoutes.POST(
        new Request(`${origin}/api/auth/${route}`, {
          method: "POST",
          headers: {
            host: "localhost:3000",
            origin,
            "content-type": "application/json",
            ...(cookies.size ? { cookie: cookieHeader() } : {}),
          },
          body: JSON.stringify(body),
        }),
      ),
    );

  try {
    await (async () => {
      const legacy = new Database(path.join(directory, "legacy.sqlite"));
      try {
        legacy.exec(
          "CREATE TABLE instance(id INTEGER PRIMARY KEY,recovery_hash TEXT,theme TEXT NOT NULL,upload_limit INTEGER NOT NULL); INSERT INTO instance VALUES(1,'saved-hash','dark',17)",
        );
        legacy.exec(
          await readFile(
            path.resolve("migrations/0045_onboarding_step.sql"),
            "utf8",
          ),
        );
        assert.deepEqual(
          legacy
            .prepare(
              "SELECT recovery_hash AS recoveryHash,theme,upload_limit AS uploadLimit,onboarding_step AS onboardingStep FROM instance WHERE id=1",
            )
            .get(),
          {
            recoveryHash: "saved-hash",
            theme: "dark",
            uploadLimit: 17,
            onboardingStep: "complete",
          },
        );
      } finally {
        legacy.close();
      }
    })();

    const anonymousStatus = await (
      await api("status", "GET", undefined, {
        authenticated: false,
      })
    ).json();
    assert.equal(anonymousStatus.settings, null);

    const password = `Fixture-${randomUUID()}`;
    const setup = await api(
      "setup",
      "POST",
      {
        name: "Onboarding Owner",
        username: "onboardingowner",
        password,
        theme: "dark",
      },
      { authenticated: false },
    );
    assert.equal(setup.status, 200, await setup.clone().text());
    assert.ok((await setup.json()).recoveryCode);

    const status = await (await api("status")).json();
    assert.equal(status.settings.onboardingStep, "tags");
    assert.equal(status.settings.theme, "dark");
    assert.equal((await (await api("settings")).json()).onboardingStep, "tags");
    assert.equal(
      (await api("settings", "PATCH", {})).status,
      400,
      "an empty PATCH must be rejected",
    );
    assert.equal(
      (await api("settings", "PATCH", { onboardingStep: "unknown" })).status,
      400,
      "steps outside the published enum must be rejected",
    );
    assert.equal(
      (await api("settings", "PATCH", { theme: "light", extra: true })).status,
      400,
      "settings updates remain strict",
    );
    assert.equal(
      (await api("settings", "PATCH", { onboardingStep: "install" })).status,
      200,
    );
    const themeOnly = await api("settings", "PATCH", { theme: "system" });
    assert.equal(themeOnly.status, 200);
    const updatedSettings = (await themeOnly.json()) as {
      theme: string;
      onboardingStep: string;
    };
    assert.equal(updatedSettings.theme, "system");
    assert.equal(
      updatedSettings.onboardingStep,
      "install",
      "an ordinary theme update preserves setup progress",
    );

    assert.equal(
      (await api("settings", "GET", undefined, { authenticated: false }))
        .status,
      401,
    );
    const keyResponse = await api("ai-connections", "POST", {
      action: "create-key",
      name: "Onboarding read key",
      access: "read",
    });
    assert.equal(keyResponse.status, 201, await keyResponse.clone().text());
    const key = (await keyResponse.json()).key as string;
    for (const method of ["GET", "PATCH"]) {
      assert.equal(
        (
          await api(
            "settings",
            method,
            method === "PATCH" ? { onboardingStep: "complete" } : undefined,
            { authenticated: false, authorization: `Bearer ${key}` },
          )
        ).status,
        403,
        `API-key ${method} access must not expose or change onboarding state`,
      );
    }

    await auth("sign-out", {});
    assert.equal(cookies.size, 0);
    assert.equal(
      (
        await (
          await api("status", "GET", undefined, {
            authenticated: false,
          })
        ).json()
      ).settings,
      null,
    );
    assert.equal(
      (
        await auth("sign-in/username", {
          username: "onboardingowner",
          password,
        })
      ).status,
      200,
    );
    assert.equal(
      (await (await api("settings")).json()).onboardingStep,
      "install",
      "logging in to an existing account does not reset its setup step",
    );

    sqlite().close();
    delete (globalThis as unknown as { nivraSqlite?: unknown }).nivraSqlite;
    assert.equal(
      (
        sqlite()
          .prepare(
            "SELECT onboarding_step AS onboardingStep FROM instance WHERE id=1",
          )
          .get() as { onboardingStep: string }
      ).onboardingStep,
      "install",
      "setup progress survives reopening the persisted database",
    );
  } finally {
    await (await import("../src/lib/server/jobs")).stopJobWorker();
    try {
      sqlite().close();
    } catch {
      // The persistence assertion may already have closed the connection.
    }
    delete (globalThis as unknown as { nivraSqlite?: unknown }).nivraSqlite;
    delete process.env.NIVRA_DATA_DIR;
    await rm(directory, { recursive: true, force: true });
  }
});
