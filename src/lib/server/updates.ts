import { z } from "zod";
import { fetchPublic } from "./link-metadata";
import { HttpError, throttle } from "./http";
import { buildInfo, repository } from "./version";

const latestRelease = z.object({
  tag_name: z.string().regex(/^v\d{4}\.\d{2}\.\d{2}$/),
  published_at: z.iso.datetime(),
  html_url: z.url(),
});
export type UpdateCheck = {
  state: "current" | "available" | "unknown";
  checkedAt: number;
  current: string | null;
  latest: { version: string; publishedAt: string; url: string };
};
let last: { at: number; latest: UpdateCheck["latest"] } | null = null;

// Runs only when the owner asks: the server contacts GitHub, so nothing is sent in the background.
export async function checkForUpdates(
  fetcher: typeof fetchPublic = fetchPublic,
): Promise<UpdateCheck> {
  if (!last || Date.now() - last.at > 600_000) {
    throttle("update-check", 6);
    try {
      const page = await fetcher(
        `https://api.github.com/repos/${repository}/releases/latest`,
        256 * 1024,
        AbortSignal.timeout(8000),
        0,
        "application/vnd.github+json",
      );
      const release = latestRelease.parse(
        JSON.parse(Buffer.from(page.bytes).toString("utf8")),
      );
      const url = new URL(release.html_url);
      if (
        url.origin !== "https://github.com" ||
        !url.pathname.startsWith(`/${repository}/releases/`)
      )
        throw new Error("Unexpected release address.");
      last = {
        at: Date.now(),
        latest: {
          version: release.tag_name,
          publishedAt: release.published_at,
          url: url.href,
        },
      };
    } catch {
      throw new HttpError(
        502,
        "Nivra could not read the latest release from GitHub. Check this server's internet access and try again.",
      );
    }
  }
  const current = buildInfo().version;
  const { latest } = last;
  return {
    state: !current
      ? "unknown"
      : latest.version > current
        ? "available"
        : "current",
    checkedAt: last.at,
    current,
    latest,
  };
}
export const forgetLatestRelease = () => {
  last = null;
};
