import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const requiredAiWorkerTracePaths = [
  "generated/ai-worker.cjs",
  "node_modules/drizzle-orm/better-sqlite3/index.cjs",
];

function assertRelativeTracePath(standaloneRoot, relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).includes("..")
  )
    throw new Error(
      `Invalid path in the AI worker dependency trace: ${relativePath}`,
    );

  const resolved = path.resolve(standaloneRoot, relativePath);
  if (
    resolved !== standaloneRoot &&
    !resolved.startsWith(`${standaloneRoot}${path.sep}`)
  )
    throw new Error(
      `AI worker trace path escapes the standalone root: ${relativePath}`,
    );
  return resolved;
}

export function verifyStandaloneArtifact({
  standaloneRoot,
  publicReaderRoot,
  aiWorkerTrace,
}) {
  const root = path.resolve(standaloneRoot);

  function inspect(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (
        (directory === root && entry.name === "data") ||
        /\.sqlite(?:-(?:wal|shm))?$/.test(entry.name) ||
        [
          "encryption.key",
          "encryption-mode.json",
          "installation.json",
          "installation.lock",
          "configuration-import.enc",
          "imported-encryption.key",
          "backup-state.enc",
          "backup.lock",
          "auth.secret",
          "nivra.sqlite",
          "nivra.sqlite-wal",
          "nivra.sqlite-shm",
        ].includes(entry.name)
      )
        throw new Error(
          "Private instance data was traced into the shipping artifact.",
        );
      if (entry.isDirectory()) inspect(file);
    }
  }

  inspect(root);
  for (const file of [
    "generated/publication-renderer.cjs",
    "generated/thumbnail-worker.cjs",
    "generated/agent-markdown-worker.mjs",
    "generated/ai-worker.cjs",
  ])
    if (!existsSync(path.join(root, file)))
      throw new Error(`${file} is missing from the shipping artifact.`);

  if (!existsSync(path.join(root, "node_modules/@napi-rs/canvas")))
    throw new Error(
      "PDF preview rendering is missing from the shipping artifact.",
    );

  for (const file of ["main.js", "reader.css", "geist-latin-wght-normal.woff2"])
    if (!existsSync(path.join(publicReaderRoot, file)))
      throw new Error("A prebuilt public reader asset is missing.");

  if (
    !Array.isArray(aiWorkerTrace) ||
    !aiWorkerTrace.every((file) => typeof file === "string")
  )
    throw new Error("The AI worker dependency trace must be a string array.");

  const trace = [...new Set(aiWorkerTrace)];
  for (const requiredPath of requiredAiWorkerTracePaths)
    if (!trace.includes(requiredPath))
      throw new Error(
        `The AI worker dependency trace is missing its required CommonJS dependency: ${requiredPath}.`,
      );

  const missingTraceFiles = trace.filter(
    (file) => !existsSync(assertRelativeTracePath(root, file)),
  );
  if (missingTraceFiles.length)
    throw new Error(
      `AI worker dependency files are missing from the shipping artifact (${missingTraceFiles.length}): ${missingTraceFiles.slice(0, 12).join(", ")}${missingTraceFiles.length > 12 ? ", …" : ""}.`,
    );

  const workerRequire = createRequire(
    path.join(root, "generated/ai-worker.cjs"),
  );
  let drizzleEntry;
  try {
    drizzleEntry = workerRequire.resolve("drizzle-orm/better-sqlite3");
  } catch {
    throw new Error(
      "The AI worker cannot resolve drizzle-orm/better-sqlite3 from the shipping artifact.",
    );
  }
  if (
    path.resolve(drizzleEntry) !==
    path.join(root, "node_modules/drizzle-orm/better-sqlite3/index.cjs")
  )
    throw new Error(
      `The AI worker's CommonJS Drizzle entry resolved unexpectedly: ${path.relative(root, drizzleEntry)}.`,
    );
}

function readAiWorkerTrace(projectRoot) {
  const tracePath = path.join(projectRoot, "generated/ai-worker-trace.json");
  let trace;
  try {
    trace = JSON.parse(readFileSync(tracePath, "utf8"));
  } catch (error) {
    throw new Error(
      `The AI worker dependency trace is missing or invalid: ${tracePath}.`,
      { cause: error },
    );
  }
  return trace;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const projectRoot = process.cwd();
  verifyStandaloneArtifact({
    standaloneRoot: path.join(projectRoot, ".next/standalone"),
    publicReaderRoot: path.join(projectRoot, "public/reader"),
    aiWorkerTrace: readAiWorkerTrace(projectRoot),
  });
  console.log("Shipping artifact excludes private instance data.");
}
