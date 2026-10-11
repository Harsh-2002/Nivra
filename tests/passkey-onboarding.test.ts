import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { authenticator } from "./fixtures/passkey";

test("passkey-first setup keeps cancelled and unverified accounts uncreated, preserves the single owner, and supports password, recovery and last-key protection", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "nivra-passkey-setup-"));
  process.env.NIVRA_DATA_DIR = directory;
  const nivra = await import("../src/app/api/v1/[...path]/route");
  const authRoutes = await import("../src/app/api/auth/[...all]/route");
  const { sqlite } = await import("../src/lib/server/db");
  const cookies = new Map<string, string>();
  const origin = "http://localhost:3000";
  const retain = (r: Response) => {
    for (const c of r.headers.getSetCookie()) {
      const [key, value] = c.split(";")[0].split(/=(.*)/);
      cookies.set(key, value);
    }
    return r;
  };
  async function call(route: string, body?: unknown, foreign = false) {
    const request = new Request(origin + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin: foreign ? "https://attacker.example" : origin,
        cookie: [...cookies].map(([k, v]) => k + "=" + v).join("; "),
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (route.startsWith("/api/auth/"))
      return retain(
        await (body === undefined ? authRoutes.GET : authRoutes.POST)(request),
      );
    return retain(
      await (body === undefined ? nivra.GET : nivra.POST)(request, {
        params: Promise.resolve({
          path: route.split("?")[0].replace("/api/v1/", "").split("/"),
        }),
      }),
    );
  }
  const begin = async () => {
    const r = await call("/api/v1/setup-passkey", {
      name: "Passkey Owner",
      username: "Owner+Passkey@example.com",
    });
    assert.equal(r.status, 200);
    return r.json() as Promise<{ context: string; recoveryCode: string }>;
  };
  const options = async (context: string) => {
    const r = await call(
      "/api/auth/passkey/generate-register-options?context=" + context,
    );
    assert.equal(r.status, 200);
    return r.json();
  };
  try {
    assert.deepEqual((await (await call("/api/v1/status")).json()).methods, {
      password: false,
      passkey: false,
    });
    assert.equal(
      (
        await call(
          "/api/v1/setup-passkey",
          { name: "Owner", username: "owner" },
          true,
        )
      ).status,
      403,
    );
    assert.equal(
      (await call("/api/auth/passkey/generate-register-options")).status,
      401,
    );
    const cancelled = await begin();
    await options(cancelled.context);
    assert.equal(
      (sqlite().prepare("SELECT count(*) n FROM user").get() as { n: number })
        .n,
      0,
    );
    assert.equal(
      (
        await call("/api/v1/setup-passkey/cancel", {
          context: cancelled.context,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        sqlite().prepare("SELECT count(*) n FROM owner_setup").get() as {
          n: number;
        }
      ).n,
      0,
    );
    const weak = await begin();
    const weakOptions = await options(weak.context);
    assert.equal(
      (
        await call("/api/auth/passkey/verify-registration", {
          response: authenticator().registration(weakOptions.challenge, false),
          createSession: true,
        })
      ).status,
      401,
    );
    assert.equal(
      (sqlite().prepare("SELECT count(*) n FROM user").get() as { n: number })
        .n,
      0,
    );
    await call("/api/v1/setup-passkey/cancel", { context: weak.context });
    const interrupted = await begin();
    const interruptedOptions = await options(interrupted.context);
    sqlite().exec(
      "CREATE TRIGGER fixture_passkey_insert_failure BEFORE INSERT ON passkey BEGIN SELECT RAISE(ABORT,'Fixture persistence failure'); END;",
    );
    assert.equal(
      (
        await call("/api/auth/passkey/verify-registration", {
          response: authenticator().registration(interruptedOptions.challenge),
          createSession: true,
        })
      ).status,
      500,
    );
    sqlite().exec("DROP TRIGGER fixture_passkey_insert_failure");
    await call("/api/v1/setup-passkey/cancel", {
      context: interrupted.context,
    });
    assert.equal(
      (sqlite().prepare("SELECT count(*) n FROM user").get() as { n: number })
        .n,
      0,
    );
    const intent = await begin();
    const competing = await begin();
    const registration = await options(intent.context);
    assert.equal(registration.user.name, "Owner+Passkey@example.com");
    assert.equal(registration.user.displayName, "Passkey Owner");
    const key = authenticator();
    const response = key.registration(registration.challenge);
    const created = await call("/api/auth/passkey/verify-registration", {
      response,
      createSession: true,
      name: "Primary passkey",
    });
    assert.equal(created.status, 200);
    const credential = await created.json();
    assert.ok(credential.id);
    const status = await (await call("/api/v1/status")).json();
    assert.equal(status.owner.name, "Passkey Owner");
    assert.equal(status.owner.username, "owner+passkey@example.com");
    assert.deepEqual(status.methods, { password: false, passkey: true });
    assert.equal(status.settings.hasPassword, false);
    assert.equal(status.settings.onboardingStep, "tags");
    assert.equal(
      (
        await call("/api/auth/passkey/verify-registration", {
          response,
          createSession: true,
        })
      ).status,
      400,
    );
    await call("/api/auth/sign-out", {});
    cookies.clear();
    assert.equal(
      (
        await call(
          "/api/auth/passkey/generate-register-options?context=" +
            competing.context,
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await call("/api/v1/setup", {
          name: "Second Owner",
          username: "second",
          password: "Fixture-password-only-123",
        })
      ).status,
      409,
    );
    const login = await (
      await call("/api/auth/passkey/generate-authenticate-options")
    ).json();
    assert.equal(login.userVerification, "required");
    assert.equal(
      (
        await call("/api/auth/passkey/verify-authentication", {
          response: key.authentication(login.challenge),
        })
      ).status,
      200,
    );
    assert.equal(
      (await call("/api/auth/passkey/delete-passkey", { id: credential.id }))
        .status,
      400,
    );
    assert.throws(
      () =>
        sqlite().prepare("DELETE FROM passkey WHERE id=?").run(credential.id),
      /last passkey/,
    );
    const rotated = await call("/api/v1/settings/recovery", {
      password: "",
    });
    assert.equal(rotated.status, 200);
    const recoveryCode = (await rotated.json()).recoveryCode;
    sqlite()
      .prepare("UPDATE session SET created_at=?")
      .run(Date.now() - 301000);
    assert.equal(
      (
        await call("/api/v1/account-password", {
          password: "Fixture-password-only-123",
        })
      ).status,
      403,
    );
    assert.equal(
      (await call("/api/v1/settings/recovery", { password: "" })).status,
      403,
    );
    await call("/api/auth/sign-out", {});
    cookies.clear();
    const loginAgain = await (
      await call("/api/auth/passkey/generate-authenticate-options")
    ).json();
    assert.equal(
      (
        await call("/api/auth/passkey/verify-authentication", {
          response: key.authentication(loginAgain.challenge),
        })
      ).status,
      200,
    );
    const added = await call("/api/v1/account-password", {
      password: "Fixture-password-only-123",
    });
    assert.equal(added.status, 200);
    assert.deepEqual((await (await call("/api/v1/status")).json()).methods, {
      password: true,
      passkey: true,
    });
    assert.equal(
      (
        await call("/api/v1/account-password", {
          password: "Fixture-password-only-123",
        })
      ).status,
      400,
    );
    assert.equal(
      (await call("/api/auth/passkey/delete-passkey", { id: credential.id }))
        .status,
      200,
    );
    assert.deepEqual((await (await call("/api/v1/status")).json()).methods, {
      password: true,
      passkey: false,
    });
    // Recovery of a passkey-only account must create a password account.
    sqlite()
      .prepare("DELETE FROM account WHERE provider_id='credential'")
      .run();
    await call("/api/auth/sign-out", {});
    cookies.clear();
    assert.equal(
      (
        await call("/api/v1/recover", {
          code: recoveryCode,
          password: "Fixture-recovered-password-123",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call("/api/v1/recover", {
          code: recoveryCode,
          password: "Fixture-recovered-password-123",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call("/api/auth/sign-in/username", {
          username: "owner+passkey@example.com",
          password: "Fixture-recovered-password-123",
        })
      ).status,
      200,
    );
    assert.equal(
      (sqlite().prepare("SELECT count(*) n FROM user").get() as { n: number })
        .n,
      1,
    );
    sqlite().prepare("UPDATE owner_setup SET expires_at=0").run();
    (await import("../src/lib/server/passkey-setup")).expirePasskeySetups();
    assert.equal(
      (sqlite().prepare("SELECT count(*) n FROM user").get() as { n: number })
        .n,
      1,
    );
    assert.equal(
      (
        sqlite().prepare("SELECT count(*) n FROM owner_setup").get() as {
          n: number;
        }
      ).n,
      0,
    );
  } finally {
    await (await import("../src/lib/server/jobs")).stopJobWorker();
    sqlite().close();
    await rm(directory, { recursive: true, force: true });
  }
});
