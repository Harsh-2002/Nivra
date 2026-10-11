import { createHash, randomBytes, randomUUID } from "node:crypto";
import { APIError } from "better-auth/api";
import { sqlite } from "./db";
import { setupInput } from "./validation";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
type Intent = {
  token_hash: string;
  user_id: string;
  name: string;
  username: string;
  recovery_hash: string;
  theme: string;
  expires_at: number;
};
export function discardPasskeySetup(context: string) {
  const d = sqlite();
  d.transaction(() => {
    const row = d
      .prepare("SELECT * FROM owner_setup WHERE token_hash=?")
      .get(hash(context)) as Intent | undefined;
    if (!row) return;
    if (
      !d.prepare("SELECT 1 FROM passkey WHERE user_id=?").get(row.user_id) &&
      !d.prepare("SELECT 1 FROM account WHERE user_id=?").get(row.user_id) &&
      !d.prepare("SELECT 1 FROM session WHERE user_id=?").get(row.user_id)
    ) {
      const removed = d
        .prepare("DELETE FROM user WHERE id=?")
        .run(row.user_id).changes;
      if (removed)
        d.prepare("UPDATE instance SET recovery_hash=NULL WHERE id=1").run();
    }
    d.prepare("DELETE FROM owner_setup WHERE token_hash=?").run(row.token_hash);
  }).immediate();
}
export function expirePasskeySetups() {
  const d = sqlite();
  d.transaction(() => {
    const rows = d
      .prepare("SELECT * FROM owner_setup WHERE expires_at<=?")
      .all(Date.now()) as Intent[];
    for (const row of rows) {
      if (
        !d.prepare("SELECT 1 FROM passkey WHERE user_id=?").get(row.user_id) &&
        !d.prepare("SELECT 1 FROM account WHERE user_id=?").get(row.user_id) &&
        !d.prepare("SELECT 1 FROM session WHERE user_id=?").get(row.user_id)
      ) {
        if (d.prepare("DELETE FROM user WHERE id=?").run(row.user_id).changes)
          d.prepare("UPDATE instance SET recovery_hash=NULL WHERE id=1").run();
      }
      d.prepare("DELETE FROM owner_setup WHERE token_hash=?").run(
        row.token_hash,
      );
    }
  }).immediate();
}
export function beginPasskeySetup(value: unknown) {
  expirePasskeySetups();
  const input = setupInput.omit({ password: true }).parse(value);
  const context = randomBytes(32).toString("base64url");
  const recoveryCode = randomBytes(24)
    .toString("hex")
    .match(/.{1,8}/g)!
    .join("-");
  sqlite()
    .transaction(() => {
      if (sqlite().prepare("SELECT 1 FROM user").get())
        throw new APIError("CONFLICT", {
          message: "Nivra is already set up. Sign in instead.",
        });
      if (
        (
          sqlite().prepare("SELECT count(*) n FROM owner_setup").get() as {
            n: number;
          }
        ).n >= 20
      )
        throw new APIError("TOO_MANY_REQUESTS", {
          message: "Wait a few minutes before trying setup again.",
        });
      sqlite()
        .prepare("INSERT INTO owner_setup VALUES(?,?,?,?,?,?,?)")
        .run(
          hash(context),
          randomUUID(),
          input.name,
          input.username,
          hash(recoveryCode.replaceAll("-", "")),
          input.theme,
          Date.now() + 300000,
        );
    })
    .immediate();
  return { context, recoveryCode };
}
export function passkeySetupIntent(context: string | null | undefined) {
  if (typeof context !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(context))
    throw new APIError("UNAUTHORIZED", {
      message: "Start account setup before creating a passkey.",
    });
  const row = sqlite()
    .prepare("SELECT * FROM owner_setup WHERE token_hash=? AND expires_at>?")
    .get(hash(context), Date.now()) as Intent | undefined;
  if (!row)
    throw new APIError("UNAUTHORIZED", {
      message: "Setup expired. Start again.",
    });
  return row;
}
export function createPasskeyOwner(
  context: string | null | undefined,
  userId: string,
) {
  sqlite()
    .transaction(() => {
      const row = passkeySetupIntent(context);
      if (
        row.user_id !== userId ||
        sqlite().prepare("SELECT 1 FROM user").get()
      )
        throw new APIError("CONFLICT", {
          message: "Nivra is already set up. Sign in instead.",
        });
      const now = Date.now();
      sqlite()
        .prepare(
          "INSERT INTO user(id,name,email,username,display_username,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          row.user_id,
          row.name,
          `${row.user_id}@nivra.invalid`,
          row.username.toLowerCase(),
          row.username,
          now,
          now,
        );
      sqlite()
        .prepare(
          "UPDATE instance SET recovery_hash=?,theme=?,onboarding_step='tags' WHERE id=1",
        )
        .run(row.recovery_hash, row.theme);
    })
    .immediate();
}
export function loginMethods(owner?: string) {
  return {
    password: !!(
      owner &&
      sqlite()
        .prepare(
          "SELECT 1 FROM account WHERE user_id=? AND provider_id='credential' AND password IS NOT NULL",
        )
        .get(owner)
    ),
    passkey: !!(
      owner &&
      sqlite().prepare("SELECT 1 FROM passkey WHERE user_id=?").get(owner)
    ),
  };
}
