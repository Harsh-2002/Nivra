import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";

const sha = "4ce815f1c19dfc77355b0cf62fc3490576def9b2";
const clear = () => {
  delete process.env.NIVRA_VERSION;
  delete process.env.NIVRA_COMMIT;
};

test("an image reports the release and commit it was built from", async () => {
  const { buildInfo, buildLabel } = await import("../src/lib/server/version");
  process.env.NIVRA_VERSION = "v2026.10.16";
  process.env.NIVRA_COMMIT = sha;
  assert.deepEqual(buildInfo(), {
    version: "v2026.10.16",
    commit: sha,
    modified: false,
  });
  assert.equal(buildLabel(), "v2026.10.16 (commit 4ce815f)");
  clear();
});

test("malformed or empty build values are ignored rather than shown", async () => {
  const { buildInfo, buildLabel } = await import("../src/lib/server/version");
  const empty = mkdtempSync(path.join(tmpdir(), "nivra-version-"));
  const before = process.cwd();
  process.chdir(empty);
  try {
    for (const [version, commit] of [
      ["", ""],
      ["latest", "main"],
      ["v2026.10.16; rm -rf", `${sha}0`],
    ]) {
      process.env.NIVRA_VERSION = version;
      process.env.NIVRA_COMMIT = commit;
      assert.deepEqual(buildInfo(), {
        version: null,
        commit: null,
        modified: false,
      });
      assert.equal(buildLabel(), "development");
    }
  } finally {
    clear();
    process.chdir(before);
    rmSync(empty, { recursive: true, force: true });
  }
});

test("a source checkout reads its commit from git and notices local changes", async (t) => {
  const { buildInfo, buildLabel } = await import("../src/lib/server/version");
  const repo = mkdtempSync(path.join(tmpdir(), "nivra-version-git-"));
  const before = process.cwd();
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString().trim();
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  writeFileSync(path.join(repo, "file.txt"), "one");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  const head = git("rev-parse", "HEAD");
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  process.chdir(repo);
  t.after(() => {
    mock.timers.reset();
    process.chdir(before);
    rmSync(repo, { recursive: true, force: true });
  });
  assert.deepEqual(buildInfo(), {
    version: null,
    commit: head,
    modified: false,
  });
  assert.equal(buildLabel(), `development (commit ${head.slice(0, 7)})`);
  writeFileSync(path.join(repo, "file.txt"), "two");
  assert.equal(
    buildInfo().modified,
    false,
    "reads are reused for a few seconds",
  );
  mock.timers.tick(6000);
  assert.equal(buildInfo().modified, true);
  assert.equal(
    buildLabel(),
    `development (commit ${head.slice(0, 7)}, uncommitted changes)`,
  );
});
