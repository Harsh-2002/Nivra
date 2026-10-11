import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const lockPath = path.join(root, "package-lock.json");
const sourceModules = path.join(root, "node_modules");
const vendorLicenseDirectory = path.join(root, "src/lib/server/ai/licenses");
const standalone = path.join(root, ".next/standalone");
const standaloneModules = path.join(standalone, "node_modules");
const outputPath = path.join(standalone, "THIRD_PARTY_NOTICES.txt");
const criticalPaths = [
  "node_modules/onnxruntime-node",
  "node_modules/onnxruntime-common",
  "node_modules/better-sqlite3",
  "node_modules/sharp",
  "node_modules/@napi-rs/canvas",
  "node_modules/next",
  "node_modules/@excalidraw/excalidraw",
  "node_modules/@fontsource-variable/geist",
  "node_modules/react",
  "node_modules/react-dom",
  "node_modules/better-auth",
  "node_modules/@blocknote/core",
  "node_modules/@blocknote/react",
  "node_modules/drizzle-orm",
  "node_modules/@huggingface/tokenizers",
];
const noticeName =
  /(?:licen[cs]e|copying|copyright|notice|patents|third[-_. ]?party)/i;
const licenseDirectory =
  /^(?:licen[cs]es?|notices?|third[-_. ]?party(?:[-_. ]?(?:licen[cs]es?|notices?))?)$/i;
const maxNoticeBytes = 4 * 1024 * 1024;
const pinnedTexts = [
  {
    packagePaths: [
      "node_modules/onnxruntime-node",
      "node_modules/onnxruntime-common",
    ],
    packageVersion: "1.30.0",
    fileName: "onnxruntime-v1.30.0-LICENSE.txt",
    upstreamUrl:
      "https://raw.githubusercontent.com/microsoft/onnxruntime/v1.30.0/LICENSE",
    sha256: "2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c",
    kind: "license",
  },
  {
    packagePaths: ["node_modules/onnxruntime-node"],
    packageVersion: "1.30.0",
    fileName: "onnxruntime-v1.30.0-ThirdPartyNotices.txt",
    upstreamUrl:
      "https://raw.githubusercontent.com/microsoft/onnxruntime/v1.30.0/ThirdPartyNotices.txt",
    sha256: "143764b952fdb1a7c69ce653bfba74a7744d6a8a573bfb73e235fba356c83de3",
    kind: "third-party notices",
  },
  {
    packagePaths: ["node_modules/drizzle-orm"],
    packageVersion: "0.45.3",
    fileName: "drizzle-orm-0.45.3-LICENSE.txt",
    upstreamUrl:
      "https://raw.githubusercontent.com/drizzle-team/drizzle-orm/0.45.3/LICENSE",
    sha256: "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
    kind: "license",
  },
  {
    packagePaths: ["node_modules/@excalidraw/excalidraw"],
    packageVersion: "0.18.1",
    fileName: "excalidraw-v0.18.1-LICENSE.txt",
    upstreamUrl:
      "https://raw.githubusercontent.com/excalidraw/excalidraw/v0.18.1/LICENSE",
    sha256: "1352d204fdb90d5e482c13139d848bc2c9300a9a7de358a0a558a23e72d0d8be",
    kind: "license",
  },
  {
    packagePaths: ["node_modules/better-sqlite3"],
    packageVersion: "13.0.3",
    fileName: "sqlite3mc-v2.4.0-LICENSE.txt",
    upstreamUrl:
      "https://raw.githubusercontent.com/utelle/SQLite3MultipleCiphers/v2.4.0/LICENSE",
    sha256: "39205ec18e0f25f56c62d3bda9768e7509b63a74ba58beb7442903dfc81c247a",
    kind: "license",
  },
];

const lock = JSON.parse(await readFile(lockPath, "utf8"));
if (lock.lockfileVersion < 3 || !lock.packages?.[""]?.dependencies)
  throw new Error(
    "A package-lock v3 with production dependencies is required.",
  );
await stat(standalone);
await stat(sourceModules);
await stat(standaloneModules);

function packagePathFor(parentPath, dependency, packages) {
  let parent = parentPath;
  const seen = new Set();
  for (;;) {
    const candidate = parent
      ? parent.endsWith("/node_modules")
        ? `${parent}/${dependency}`
        : `${parent}/node_modules/${dependency}`
      : `node_modules/${dependency}`;
    if (!seen.has(candidate) && packages[candidate]) return candidate;
    seen.add(candidate);
    if (!parent) return undefined;
    const next = path.posix.dirname(parent);
    parent = next === "." ? "" : next;
  }
}

function productionDependencyPaths() {
  const found = new Set();
  const queue = Object.keys(lock.packages[""].dependencies).map((name) => ({
    parentPath: "",
    name,
  }));
  while (queue.length) {
    const next = queue.pop();
    const packagePath = packagePathFor(
      next.parentPath,
      next.name,
      lock.packages,
    );
    if (!packagePath || found.has(packagePath)) continue;
    found.add(packagePath);
    const entry = lock.packages[packagePath];
    for (const name of Object.keys({
      ...entry.dependencies,
      ...entry.optionalDependencies,
    }))
      queue.push({ parentPath: packagePath, name });
  }
  return found;
}

async function readPackageMetadata(directory) {
  try {
    return JSON.parse(
      await readFile(path.join(directory, "package.json"), "utf8"),
    );
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function packageNotices(directory, packagePath, metadata) {
  const notices = [];
  const skipped = [];
  async function walk(current, depth = 0, inLicenseDirectory = false) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink() || entry.name === "node_modules") continue;
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        const licenseDir =
          inLicenseDirectory ||
          licenseDirectory.test(entry.name) ||
          /^(?:vendor|third[-_. ]?party|legal)$/i.test(entry.name);
        if (licenseDir || depth < 2)
          await walk(filePath, depth + 1, licenseDir);
        continue;
      }
      if (
        !entry.isFile() ||
        (!inLicenseDirectory && !noticeName.test(entry.name))
      )
        continue;
      const relativePath = path
        .relative(directory, filePath)
        .split(path.sep)
        .join("/");
      const size = (await stat(filePath)).size;
      if (size > maxNoticeBytes) {
        skipped.push({
          path: relativePath,
          reason: `larger than ${maxNoticeBytes} bytes`,
        });
        continue;
      }
      const bytes = await readFile(filePath);
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (text.includes("\0")) throw new Error("binary content");
        notices.push({
          path: relativePath,
          hash: createHash("sha256").update(bytes).digest("hex"),
          text,
          fullLicense: /(?:licen[cs]e|copying)/i.test(
            path.basename(relativePath),
          ),
        });
      } catch {
        skipped.push({ path: relativePath, reason: "not UTF-8 text" });
      }
    }
  }
  await walk(directory);
  if (packagePath === "node_modules/better-sqlite3") {
    const filePath = path.join(directory, "deps/sqlite3/sqlite3.c");
    const source = await readFile(filePath, "utf8").catch(() => "");
    const header = source.match(/^\/\*[\s\S]*?\*\//)?.[0];
    if (header && /copyright:/i.test(header) && /license:\s*MIT/i.test(header))
      notices.push({
        path: "deps/sqlite3/sqlite3.c#embedded-license-header",
        hash: createHash("sha256").update(header).digest("hex"),
        text: header,
        fullLicense: false,
      });
  }
  for (const pinned of pinnedTexts.filter((item) =>
    item.packagePaths.includes(packagePath),
  )) {
    const lockVersion = lock.packages[packagePath]?.version;
    if (
      metadata.version !== pinned.packageVersion ||
      lockVersion !== pinned.packageVersion
    )
      throw new Error(
        `Pinned license ${pinned.fileName} expects ${packagePath}@${pinned.packageVersion}, received installed=${metadata.version} lock=${lockVersion}.`,
      );
    if (packagePath === "node_modules/better-sqlite3") {
      const sqliteHeader = await readFile(
        path.join(directory, "deps/sqlite3/sqlite3.h"),
        "utf8",
      );
      if (
        !sqliteHeader.includes(
          '#define SQLITE3MC_VERSION_STRING     "SQLite3 Multiple Ciphers 2.4.0"',
        )
      )
        throw new Error(
          "Pinned SQLite3 Multiple Ciphers v2.4.0 license does not match the embedded source version.",
        );
    }
    const filePath = path.join(vendorLicenseDirectory, pinned.fileName);
    const bytes = await readFile(filePath);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== pinned.sha256)
      throw new Error(
        `Vendored upstream text hash mismatch for ${pinned.fileName}: expected ${pinned.sha256}, received ${hash}.`,
      );
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    notices.push({
      path: `src/lib/server/ai/licenses/${pinned.fileName}`,
      hash,
      text,
      fullLicense: pinned.kind === "license",
      upstreamUrl: pinned.upstreamUrl,
    });
  }
  return { notices, skipped };
}

const productionPaths = productionDependencyPaths();
const standalonePackages = new Map();
for (const packagePath of Object.keys(lock.packages).filter((item) =>
  item.startsWith("node_modules/"),
)) {
  const metadata = await readPackageMetadata(
    path.join(standaloneModules, packagePath.slice("node_modules/".length)),
  );
  if (metadata) standalonePackages.set(packagePath, metadata);
}
const packagePaths = new Set([
  ...productionPaths,
  ...standalonePackages.keys(),
]);
const packages = [];
const noticeGroups = new Map();

const orderedPaths = [...packagePaths].sort();
const packageResults = new Array(orderedPaths.length);
let nextIndex = 0;
async function scanPackageQueue() {
  for (;;) {
    const index = nextIndex++;
    if (index >= orderedPaths.length) return;
    const packagePath = orderedPaths[index];
    const sourcePath = path.join(
      sourceModules,
      packagePath.slice("node_modules/".length),
    );
    const runtimePath = path.join(
      standaloneModules,
      packagePath.slice("node_modules/".length),
    );
    const sourceMetadata = await readPackageMetadata(sourcePath);
    const runtimeMetadata = standalonePackages.get(packagePath);
    const metadata = sourceMetadata ?? runtimeMetadata;
    if (!metadata) continue;
    const hasSource = Boolean(sourceMetadata);
    const hasRuntime = Boolean(runtimeMetadata);
    const sourceRoot = hasSource ? sourcePath : runtimePath;
    const { notices, skipped } = await packageNotices(
      sourceRoot,
      packagePath,
      metadata,
    );
    packageResults[index] = {
      packagePath,
      name: metadata.name ?? packagePath.slice("node_modules/".length),
      version: metadata.version ?? "unknown",
      license: metadata.license ?? null,
      repository: metadata.repository ?? null,
      sourceInstalled: hasSource,
      runtimeTraced: hasRuntime,
      notices,
      skipped,
      fullLicenseHashes: [
        ...new Set(
          notices
            .filter((notice) => notice.fullLicense)
            .map((notice) => notice.hash),
        ),
      ].sort(),
    };
  }
}
await Promise.all(
  Array.from({ length: Math.min(16, orderedPaths.length) }, () =>
    scanPackageQueue(),
  ),
);

for (const result of packageResults.filter(Boolean)) {
  const groupHashes = [];
  for (const notice of result.notices) {
    let group = noticeGroups.get(notice.hash);
    if (!group) {
      group = { text: notice.text, sources: [] };
      noticeGroups.set(notice.hash, group);
    }
    const source = {
      name: result.name,
      version: result.version,
      packagePath: result.packagePath,
      filePath: notice.path.startsWith("src/")
        ? notice.path
        : `node_modules/${result.packagePath.slice("node_modules/".length)}/${notice.path}`,
      upstreamUrl: notice.upstreamUrl,
    };
    if (
      !group.sources.some(
        (item) =>
          item.packagePath === source.packagePath &&
          item.filePath === source.filePath,
      )
    )
      group.sources.push(source);
    groupHashes.push(notice.hash);
  }
  const record = Object.fromEntries(
    Object.entries(result).filter(([key]) => key !== "notices"),
  );
  record.noticeHashes = [...new Set(groupHashes)].sort();
  packages.push(record);
}

for (const criticalPath of criticalPaths) {
  const critical = packages.find((item) => item.packagePath === criticalPath);
  if (!critical)
    throw new Error(`Required runtime package is absent: ${criticalPath}.`);
  if (!critical.license)
    throw new Error(
      `Required runtime package has no declared license metadata: ${criticalPath}.`,
    );
}

const modelManifest = JSON.parse(
  await readFile(
    path.join(root, "src/lib/server/ai/model-manifest.json"),
    "utf8",
  ),
);
if (modelManifest.license !== "Apache-2.0" || !modelManifest.revision)
  throw new Error(
    "The pinned model manifest must declare its license and revision.",
  );

const fontRoot = path.join(root, "public/excalidraw/fonts");
const fontDirectories = await readdir(fontRoot, { withFileTypes: true });
const fontAssets = fontDirectories
  .filter((item) => item.isDirectory())
  .map((item) => item.name)
  .sort();
const verifiedFontLicenseDirectories = new Set();
const fontLicenseGaps = fontAssets.filter(
  (font) => !verifiedFontLicenseDirectories.has(font),
);

const lines = [
  "NIVRA THIRD-PARTY NOTICES",
  "",
  "Generated from the production dependency closure and packages traced into the Next.js standalone runtime.",
  "Package license fields below are metadata. A field is not a substitute for the upstream license text.",
  "Missing package-provided texts and unreadable notice files are listed explicitly; no text is inferred from SPDX metadata.",
  "Nivra's own license is distributed as /app/LICENSE. The pinned model pack is distributed with /app/models/arctic/LICENSE and NOTICE.",
  "Node.js retains its license at /usr/share/licenses/node/LICENSE. Debian package copyright notices are provided under /usr/share/doc.",
  "",
  "PACKAGE INVENTORY",
];

for (const item of packages) {
  lines.push(
    `- ${item.name}@${item.version}`,
    `  Installed path: ${item.packagePath}`,
    `  Declared license metadata: ${JSON.stringify(item.license ?? "not declared")}`,
    `  Source package available: ${item.sourceInstalled ? "yes" : "no; searched runtime package"}`,
    `  Runtime traced: ${item.runtimeTraced ? "yes" : "no (production dependency closure)"}`,
  );
  if (item.repository)
    lines.push(`  Repository metadata: ${JSON.stringify(item.repository)}`);
  if (item.packagePath === "node_modules/better-sqlite3")
    lines.push(
      "  Component note: the bundled SQLite3 Multiple Ciphers source has an MIT copyright/license header in deps/sqlite3/sqlite3.c; that header is reproduced below and is not presented as a separate full license text.",
    );
  if (item.fullLicenseHashes.length) {
    for (const hash of item.fullLicenseHashes)
      lines.push(`  Included full license text: sha256:${hash}`);
  }
  if (item.noticeHashes.length) {
    for (const hash of item.noticeHashes)
      lines.push(`  Included upstream text: sha256:${hash}`);
  } else if (item.skipped.length) {
    lines.push(
      "  UPSTREAM LICENSE/NOTICE TEXT NOT INCLUDED; candidate files were unreadable or exceeded the size limit.",
    );
  } else {
    lines.push(
      "  UPSTREAM LICENSE/NOTICE TEXT NOT FOUND in the installed package.",
    );
  }
  for (const skipped of item.skipped)
    lines.push(`  Notice omitted: ${skipped.path} (${skipped.reason}).`);
}

lines.push(
  "",
  "BUNDLED EXCALIDRAW FONT ASSETS",
  ...fontAssets.map(
    (font) =>
      `- public/excalidraw/fonts/${font}/: bundled font files found; no exact upstream font license text is available in the pinned Excalidraw package/repository inventory.`,
  ),
  "",
  "PINNED LOCAL MODEL",
  `- ${modelManifest.repository}@${modelManifest.revision}`,
  `  Declared license: ${modelManifest.license}`,
  "  The model build stage writes the Apache-2.0 text available from the tokenizer package and a NOTICE with repository and revision details under /app/models/arctic/.",
  "",
  "UPSTREAM LICENSE AND NOTICE TEXTS",
);

for (const [hash, group] of [...noticeGroups.entries()].sort(([a], [b]) =>
  a.localeCompare(b),
)) {
  lines.push(`--- sha256:${hash} ---`);
  for (const source of group.sources.sort((a, b) =>
    `${a.packagePath}/${a.filePath}`.localeCompare(
      `${b.packagePath}/${b.filePath}`,
    ),
  ))
    lines.push(`Source: ${source.name}@${source.version} (${source.filePath})`);
  for (const source of group.sources.filter((item) => item.upstreamUrl))
    lines.push(`Pinned upstream source: ${source.upstreamUrl}`);
  lines.push("", group.text.trimEnd(), "");
}

const output = `${lines.join("\n")}\n`;
for (const criticalPath of criticalPaths) {
  const packageName = packages.find(
    (item) => item.packagePath === criticalPath,
  )?.name;
  if (!output.includes(`Installed path: ${criticalPath}`) || !packageName)
    throw new Error(
      `Notice inventory verification failed for ${criticalPath}.`,
    );
}
await writeFile(outputPath, output);
const written = await readFile(outputPath, "utf8");
const missingTextPackages = packages.filter(
  (item) => item.noticeHashes.length === 0,
);
const criticalMissingFullText = packages.filter(
  (item) =>
    criticalPaths.includes(item.packagePath) &&
    item.fullLicenseHashes.length === 0,
);
const missingTextMarkerCount = [
  ...written.matchAll(/UPSTREAM LICENSE\/NOTICE TEXT NOT (?:FOUND|INCLUDED)/g),
].length;
if (
  missingTextMarkerCount !== missingTextPackages.length ||
  !written.includes(`${modelManifest.repository}@${modelManifest.revision}`) ||
  !written.includes("onnxruntime-node@") ||
  !written.includes("better-sqlite3-multiple-ciphers@") ||
  !written.includes("sqlite3.c#embedded-license-header") ||
  !written.includes("Ulrich Telle") ||
  pinnedTexts.some((item) => !written.includes(item.upstreamUrl)) ||
  pinnedTexts.some((item) => !written.includes(`sha256:${item.sha256}`))
)
  throw new Error(
    "Generated third-party notice inventory failed verification.",
  );

const blockers = [
  ...criticalMissingFullText.map(
    (item) =>
      `${item.name}@${item.version} (${item.packagePath}): no full license text`,
  ),
  ...fontLicenseGaps.map(
    (font) =>
      `Excalidraw bundled font directory public/excalidraw/fonts/${font}: no exact upstream font license text`,
  ),
];
if (blockers.length) {
  const report = [
    "",
    "IMPORTANT DISTRIBUTION BLOCKERS",
    `Critical package full-license gaps: ${criticalMissingFullText.length}`,
    `Bundled Excalidraw font license gaps: ${fontLicenseGaps.length}`,
    ...blockers.map((item) => `- ${item}`),
    "No SPDX metadata was used to fabricate a full notice.",
    "",
  ].join("\n");
  await writeFile(outputPath, `${written.trimEnd()}\n${report}`);
}

console.log(
  `Generated ${path.relative(root, outputPath)} for ${packages.length} packages; ${noticeGroups.size} distinct upstream text files included; ${missingTextPackages.length} packages have no readable package-provided upstream text; ${criticalMissingFullText.length} critical package license gaps; ${fontLicenseGaps.length} bundled font license gaps.`,
);
if (blockers.length) {
  console.error(`Distribution validation blocked: ${blockers.join("; ")}`);
  process.exitCode = 1;
}
