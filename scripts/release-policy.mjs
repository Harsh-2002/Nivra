export function releaseVersion(date = new Date()) {
  return `v${date.toISOString().slice(0, 10).replaceAll("-", ".")}`;
}

export function validateReleaseTag(tag) {
  if (!/^v\d{4}\.\d{2}\.\d{2}$/.test(tag))
    throw new Error("Release tags must use vYYYY.MM.DD.");
  const date = new Date(`${tag.slice(1).replaceAll(".", "-")}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || releaseVersion(date) !== tag)
    throw new Error("Release tag must contain a valid calendar date.");
  return tag;
}

/** @param {{sha: string, mainSha: string, runs: Array<{head_sha: string, head_branch: string, event: string, status: string, conclusion: string}>, releasedSha?: string}} input */
export function verifyRelease({ sha, mainSha, runs, releasedSha }) {
  if (!/^[a-f0-9]{40}$/.test(sha) || sha !== mainSha)
    throw new Error("Release must use the current main commit.");
  const run = runs[0];
  if (
    !run ||
    run.head_sha !== sha ||
    run.head_branch !== "main" ||
    run.event !== "push" ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  ) {
    throw new Error("CI must pass on this exact main commit before releasing.");
  }
  if (releasedSha && releasedSha !== sha)
    throw new Error(
      "Today's date is already assigned to another commit. Release on a new UTC date.",
    );
  return run;
}

export function retiredReleases(releases, current) {
  if (
    current.draft ||
    current.prerelease ||
    !releases.some((release) => release.id === current.id && !release.draft)
  ) {
    throw new Error(
      "The replacement release must be published before retirement.",
    );
  }
  return releases.filter(
    (release) => release.id !== current.id && !release.draft,
  );
}

export function verifyPlatforms(manifest) {
  const platforms = manifest.manifests
    .filter((entry) => entry.platform?.os !== "unknown")
    .map((entry) => `${entry.platform?.os}/${entry.platform?.architecture}`)
    .sort();
  if (platforms.join(",") !== "linux/amd64,linux/arm64")
    throw new Error(
      "The image must include exactly AMD64 and ARM64 Linux platforms.",
    );
}
