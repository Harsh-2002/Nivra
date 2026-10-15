import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  retiredReleases,
  validateReleaseTag,
  verifyPlatforms,
  verifyRelease,
} from "./release-policy.mjs";

const repository = process.env.GITHUB_REPOSITORY;
const version = validateReleaseTag(process.env.RELEASE_TAG ?? "");
if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository))
  throw new Error("A GitHub repository is required.");
const image = `ghcr.io/${repository.toLowerCase()}`;
const gh = (...args) =>
  execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const api = (path) => JSON.parse(gh("api", path));
const releases = () =>
  JSON.parse(
    gh(
      "api",
      "--paginate",
      "--slurp",
      `repos/${repository}/releases?per_page=100`,
    ),
  ).flat();

function gate() {
  const sha = api(`repos/${repository}/commits/${version}`).sha;
  const mainSha = api(`repos/${repository}/commits/main`).sha;
  const runs = api(
    `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&branch=main&per_page=1`,
  ).workflow_runs;
  const existing = releases().find((release) => release.tag_name === version);
  const run = verifyRelease({
    sha,
    mainSha,
    runs,
    releasedSha: existing?.target_commitish,
  });
  return { sha, run };
}

if (process.argv[2] === "gate") {
  const { sha } = gate();
  if (!process.env.GITHUB_OUTPUT)
    throw new Error("GitHub output file is required.");
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `sha=${sha}\nversion=${version}\nimage=${image}\n`,
  );
  console.log(`CI passed on ${sha}; ready to release ${version}.`);
} else if (process.argv[2] === "publish") {
  const { sha, run } = gate();
  if (sha !== process.env.RELEASE_SHA)
    throw new Error("Release source changed after verification.");
  const digest = process.env.RELEASE_DIGEST;
  if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? ""))
    throw new Error("A valid image digest is required.");
  const scope = `${repository.toLowerCase()}:pull`;
  const tokenResponse = await fetch(
    `https://ghcr.io/token?service=ghcr.io&scope=repository:${scope}`,
    { signal: AbortSignal.timeout(30000) },
  );
  if (!tokenResponse.ok)
    throw new Error(
      "GHCR image is not public. Change package visibility to Public, then retry this job.",
    );
  const { token } = await tokenResponse.json();
  const response = await fetch(
    `https://ghcr.io/v2/${repository.toLowerCase()}/manifests/latest`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept:
          "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json",
      },
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!response.ok)
    throw new Error(
      "Anonymous image download failed. The GHCR package must be Public before release publication.",
    );
  if (response.headers.get("docker-content-digest") !== digest)
    throw new Error("The latest image digest does not match this release.");
  verifyPlatforms(await response.json());
  const { buildPackage } = await import("./package-extension.mjs");
  const extension = buildPackage({ tag: version });
  const directory = mkdtempSync(join(tmpdir(), "nivra-release-"));
  try {
    const archive = join(directory, extension.name);
    writeFileSync(archive, extension.bytes);
    const notes = join(directory, "notes.md");
    writeFileSync(
      notes,
      `## Get started\n\n\`\`\`sh\ndocker run -d --name nivra \\\n  --restart unless-stopped --init \\\n  -p 3000:3000 \\\n  -v nivra-data:/data \\\n  ${image}:latest\n\`\`\`\n\nOpen http://localhost:3000 to complete setup. Keep the data volume when upgrading.\n\nLinux AMD64 and ARM64 are included; Docker selects the architecture automatically.\n\nCommit: ${sha}\n\nImage: \`${image}@${digest}\`\n\nVerified [CI run](${run.html_url}) and container onboarding, authorization and persistence on both architectures.\n\n## Browser extension\n\nDownload \`${extension.name}\`, unzip it, and load the folder from \`chrome://extensions\` with Developer mode on. SHA-256: \`${extension.sha256}\`\n`,
    );
    const existing = releases().find((release) => release.tag_name === version);
    if (!existing)
      gh(
        "release",
        "create",
        version,
        "--repo",
        repository,
        "--verify-tag",
        "--target",
        sha,
        "--draft",
        "--title",
        `Nivra ${version}`,
        "--notes-file",
        notes,
      );
    else
      gh(
        "release",
        "edit",
        version,
        "--repo",
        repository,
        "--notes-file",
        notes,
      );
    gh(
      "release",
      "upload",
      version,
      archive,
      "--repo",
      repository,
      "--clobber",
    );
    gh(
      "release",
      "edit",
      version,
      "--repo",
      repository,
      "--draft=false",
      "--prerelease=false",
      "--latest",
    );
    const current = api(`repos/${repository}/releases/latest`);
    if (current.tag_name !== version)
      throw new Error(
        "GitHub latest release did not advance; previous releases are retained.",
      );
    for (const old of retiredReleases(releases(), current)) {
      gh(
        "release",
        "delete",
        old.tag_name,
        "--repo",
        repository,
        "--cleanup-tag",
        "--yes",
      );
      console.log(`Retired ${old.tag_name}.`);
    }
    if (releases().filter((release) => !release.draft).length !== 1)
      throw new Error("Expected exactly one published release.");
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `Published [${version}](${current.html_url}) with public \`${image}:latest\` for AMD64 and ARM64.\n`,
      );
    console.log(`Published ${version}; one active release remains.`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
} else throw new Error("Use gate or publish.");
