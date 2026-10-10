import assert from "node:assert/strict";
import { test } from "node:test";
import {
  releaseVersion,
  retiredReleases,
  validateReleaseTag,
  verifyPlatforms,
  verifyRelease,
} from "../scripts/release-policy.mjs";

test("releases use UTC calendar dates and only successful CI on the exact main commit", () => {
  assert.equal(
    releaseVersion(new Date("2026-10-09T23:30:00-02:00")),
    "v2026.10.10",
  );
  assert.equal(validateReleaseTag("v2028.02.29"), "v2028.02.29");
  for (const tag of [
    "latest",
    "v1.0.0",
    "v2026.2.10",
    "v2026.02.29",
    "v2026.13.01",
    "v2026.10.10;echo bad",
  ])
    assert.throws(() => validateReleaseTag(tag));
  const sha = "a".repeat(40);
  const run = {
    head_sha: sha,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
  };
  const valid = { sha, mainSha: sha, runs: [run] };
  assert.equal(verifyRelease(valid), run);
  for (const changes of [
    { head_sha: "b".repeat(40) },
    { head_branch: "web" },
    { event: "pull_request" },
    { status: "in_progress" },
    { conclusion: "failure" },
    { conclusion: "cancelled" },
  ]) {
    assert.throws(() =>
      verifyRelease({ ...valid, runs: [{ ...run, ...changes }] }),
    );
  }
  assert.throws(() => verifyRelease({ ...valid, runs: [] }));
  assert.throws(() => verifyRelease({ ...valid, mainSha: "b".repeat(40) }));
  assert.throws(() => verifyRelease({ ...valid, releasedSha: "b".repeat(40) }));
  assert.equal(verifyRelease({ ...valid, releasedSha: sha }), run);
});

test("single active release retirement cannot delete the replacement or run before publication", () => {
  const previous = { id: 1, draft: false, prerelease: false };
  const current = { id: 2, draft: false, prerelease: false };
  const draft = { id: 3, draft: true, prerelease: false };
  assert.deepEqual(retiredReleases([previous, current, draft], current), [
    previous,
  ]);
  assert.throws(() => retiredReleases([previous], current));
  assert.throws(() => retiredReleases([previous, draft], draft));
  assert.throws(() =>
    retiredReleases([previous, { ...current, prerelease: true }], {
      ...current,
      prerelease: true,
    }),
  );
});

test("release manifests require both architectures and accept provenance descriptors", () => {
  const manifests = ["amd64", "arm64"].map((architecture) => ({
    platform: { os: "linux", architecture },
  }));
  verifyPlatforms({ manifests });
  verifyPlatforms({
    manifests: [
      ...manifests,
      { platform: { os: "unknown", architecture: "unknown" } },
    ],
  });
  assert.throws(() => verifyPlatforms({ manifests: [manifests[0]] }));
  assert.throws(() =>
    verifyPlatforms({ manifests: [manifests[0], manifests[0]] }),
  );
  assert.throws(() =>
    verifyPlatforms({
      manifests: [
        ...manifests,
        { platform: { os: "windows", architecture: "amd64" } },
      ],
    }),
  );
});
