import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export const repository = "Harsh-2002/Nivra";
export type BuildInfo = {
  version: string | null;
  commit: string | null;
  modified: boolean;
};
const releaseTag = /^v\d{4}\.\d{2}\.\d{2}$/;
const commitHash = /^[a-f0-9]{40}$/;
const git = (...args: string[]) => {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
};
let sourceRead: {
  at: number;
  commit: string | null;
  modified: boolean;
} | null = null;
// Images carry their release in the environment; a source checkout is read from git, which also follows a dev server's hot reloads.
export function buildInfo(): BuildInfo {
  const version = releaseTag.test(process.env.NIVRA_VERSION ?? "")
    ? (process.env.NIVRA_VERSION as string)
    : null;
  if (commitHash.test(process.env.NIVRA_COMMIT ?? ""))
    return {
      version,
      commit: process.env.NIVRA_COMMIT as string,
      modified: false,
    };
  if (!existsSync(".git")) return { version, commit: null, modified: false };
  if (!sourceRead || Date.now() - sourceRead.at > 5000) {
    const head = git("rev-parse", "HEAD");
    sourceRead = {
      at: Date.now(),
      commit: commitHash.test(head) ? head : null,
      modified: !!git("status", "--porcelain", "--untracked-files=no"),
    };
  }
  return {
    version,
    commit: sourceRead.commit,
    modified: sourceRead.modified,
  };
}
export function buildLabel(info = buildInfo()) {
  const commit = info.commit ? info.commit.slice(0, 7) : null;
  const detail = [
    commit && `commit ${commit}`,
    info.modified && "uncommitted changes",
  ].filter(Boolean);
  return `${info.version ?? "development"}${detail.length ? ` (${detail.join(", ")})` : ""}`;
}
