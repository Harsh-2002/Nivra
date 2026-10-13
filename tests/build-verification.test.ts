import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import {
  verifyBookmarkReaderArtifact,
  verifyStandaloneArtifact,
} from "../scripts/verify-build.mjs";

const aiWorkerTrace = [
  "generated/ai-worker.cjs",
  "node_modules/drizzle-orm/package.json",
  "node_modules/drizzle-orm/better-sqlite3/index.cjs",
  "node_modules/drizzle-orm/better-sqlite3/driver.cjs",
  "node_modules/drizzle-orm/better-sqlite3/session.cjs",
];

async function createArtifact({ omitted = [] }: { omitted?: string[] } = {}) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "nivra-build-verification-"),
  );
  const standaloneRoot = path.join(directory, "standalone");
  const publicReaderRoot = path.join(directory, "public/reader");
  const files = [
    "generated/publication-renderer.cjs",
    "generated/thumbnail-worker.cjs",
    "generated/agent-markdown-worker.mjs",
    "generated/ai-worker.cjs",
    "node_modules/drizzle-orm/package.json",
    "node_modules/drizzle-orm/better-sqlite3/index.cjs",
    "node_modules/drizzle-orm/better-sqlite3/driver.cjs",
    "node_modules/drizzle-orm/better-sqlite3/session.cjs",
  ];
  for (const file of files) {
    if (omitted.includes(file)) continue;
    const filePath = path.join(standaloneRoot, file);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      file.endsWith("package.json")
        ? JSON.stringify({
            name: "drizzle-orm",
            exports: {
              "./better-sqlite3": {
                require: "./better-sqlite3/index.cjs",
                default: "./better-sqlite3/index.js",
              },
            },
          })
        : file.endsWith("ai-worker.cjs")
          ? 'require("drizzle-orm/better-sqlite3");\n'
          : "module.exports = {};\n",
    );
  }
  const esmEntry = path.join(
    standaloneRoot,
    "node_modules/drizzle-orm/better-sqlite3/index.js",
  );
  await mkdir(path.dirname(esmEntry), { recursive: true });
  await writeFile(esmEntry, "export {};\n");
  await mkdir(path.join(standaloneRoot, "node_modules/@napi-rs/canvas"), {
    recursive: true,
  });
  await mkdir(publicReaderRoot, { recursive: true });
  for (const file of ["main.js", "reader.css", "geist-latin-wght-normal.woff2"])
    await writeFile(path.join(publicReaderRoot, file), "fixture");

  return { directory, standaloneRoot, publicReaderRoot };
}

async function withArtifact(
  callback: (artifact: Awaited<ReturnType<typeof createArtifact>>) => void,
) {
  const artifact = await createArtifact();
  try {
    callback(artifact);
  } finally {
    await rm(artifact.directory, { recursive: true, force: true });
  }
}

test("build verification resolves the AI worker's CommonJS Drizzle entry and traced closure", async () => {
  await withArtifact(({ standaloneRoot, publicReaderRoot }) => {
    assert.doesNotThrow(() =>
      verifyStandaloneArtifact({
        standaloneRoot,
        publicReaderRoot,
        aiWorkerTrace,
      }),
    );
  });
});

test("build verification rejects a missing traced child-worker dependency", async () => {
  const artifact = await createArtifact({
    omitted: ["node_modules/drizzle-orm/better-sqlite3/session.cjs"],
  });
  try {
    assert.throws(
      () =>
        verifyStandaloneArtifact({
          standaloneRoot: artifact.standaloneRoot,
          publicReaderRoot: artifact.publicReaderRoot,
          aiWorkerTrace,
        }),
      /AI worker dependency files are missing from the shipping artifact.*session\.cjs/,
    );
  } finally {
    await rm(artifact.directory, { recursive: true, force: true });
  }
});

test("build verification requires the CommonJS entry in the generated worker trace", async () => {
  const artifact = await createArtifact();
  try {
    assert.throws(
      () =>
        verifyStandaloneArtifact({
          standaloneRoot: artifact.standaloneRoot,
          publicReaderRoot: artifact.publicReaderRoot,
          aiWorkerTrace: aiWorkerTrace.filter(
            (file) =>
              file !== "node_modules/drizzle-orm/better-sqlite3/index.cjs",
          ),
        }),
      /trace is missing its required CommonJS dependency.*better-sqlite3\/index\.cjs/,
    );
  } finally {
    await rm(artifact.directory, { recursive: true, force: true });
  }
});

test("build verification continues to reject private instance data", async () => {
  const artifact = await createArtifact();
  try {
    await mkdir(path.join(artifact.standaloneRoot, "data"), {
      recursive: true,
    });
    assert.throws(
      () =>
        verifyStandaloneArtifact({
          standaloneRoot: artifact.standaloneRoot,
          publicReaderRoot: artifact.publicReaderRoot,
          aiWorkerTrace,
        }),
      /Private instance data/,
    );
  } finally {
    await rm(artifact.directory, { recursive: true, force: true });
  }
});

test("bookmark reader packaging rejects missing and escaping dependency traces", async () => {
  const artifact = await createArtifact();
  try {
    const worker = path.join(
      artifact.standaloneRoot,
      "generated/bookmark-reader-worker.mjs",
    );
    await writeFile(worker, "export {};\n");
    assert.doesNotThrow(() =>
      verifyBookmarkReaderArtifact(artifact.standaloneRoot, []),
    );
    assert.throws(
      () =>
        verifyBookmarkReaderArtifact(artifact.standaloneRoot, [
          "../outside.js",
        ]),
      /Invalid path/,
    );
    assert.throws(
      () =>
        verifyBookmarkReaderArtifact(artifact.standaloneRoot, [
          "node_modules/jsdom/lib/api.js",
        ]),
      /Bookmark reader dependency missing/,
    );
    assert.throws(
      () => verifyBookmarkReaderArtifact(artifact.standaloneRoot, [null]),
      /string array/,
    );
  } finally {
    await rm(artifact.directory, { recursive: true, force: true });
  }
});
