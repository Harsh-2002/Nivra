import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const lockPath = path.join(root, "package-lock.json");
const sourceModules = path.join(root, "node_modules");
const vendorLicenseDirectory = path.join(root, "src/lib/server/ai/licenses");
const fontLicenseDirectory = path.join(vendorLicenseDirectory, "fonts");
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
if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))
  throw new Error(
    `The runtime notice collector requires Linux x64 or arm64, received ${process.platform}/${process.arch}.`,
  );
const nativeRuntimePaths =
  process.arch === "x64"
    ? [
        "node_modules/@img/sharp-libvips-linux-x64",
        "node_modules/@napi-rs/canvas-linux-x64-gnu",
      ]
    : [
        "node_modules/@img/sharp-libvips-linux-arm64",
        "node_modules/@napi-rs/canvas-linux-arm64-gnu",
      ];
const criticalRuntimePaths = [...criticalPaths, ...nativeRuntimePaths];
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
  {
    packagePaths: [
      "node_modules/@img/sharp-libvips-linux-x64",
      "node_modules/@img/sharp-libvips-linux-arm64",
    ],
    packageVersion: "1.3.4",
    fileName: "native/sharp-libvips-v1.3.4-THIRD-PARTY-NOTICES.md",
    upstreamUrl:
      "https://raw.githubusercontent.com/lovell/sharp-libvips/ebb95f8add54eee8bed840e3fb587e4cbec857d7/THIRD-PARTY-NOTICES.md",
    sha256: "6f0d5086e3bcbee12bcdacf5878b31d1104002aeecaeb241d3fff466108082fe",
    kind: "third-party notices",
  },
  {
    packagePaths: [
      "node_modules/@img/sharp-libvips-linux-x64",
      "node_modules/@img/sharp-libvips-linux-arm64",
    ],
    packageVersion: "1.3.4",
    fileName: "native/LGPL-3.0.txt",
    upstreamUrl: "https://www.gnu.org/licenses/lgpl-3.0.txt",
    sha256: "e3a994d82e644b03a792a930f574002658412f62407f5fee083f2555c5f23118",
    kind: "license",
  },
  {
    packagePaths: [
      "node_modules/@img/sharp-libvips-linux-x64",
      "node_modules/@img/sharp-libvips-linux-arm64",
    ],
    packageVersion: "1.3.4",
    fileName: "native/GPL-3.0-only.txt",
    upstreamUrl:
      "https://raw.githubusercontent.com/spdx/license-list-data/v3.27.0/text/GPL-3.0-only.txt",
    sha256: "fb981668c18a279e285fc4d83fba1e836cc84dd4daa73c9697d3cfd2d8aca6e0",
    kind: "license",
  },
  {
    packagePaths: [
      "node_modules/@img/sharp-libvips-linux-x64",
      "node_modules/@img/sharp-libvips-linux-arm64",
    ],
    packageVersion: "1.3.4",
    fileName: "native/LGPL-2.1.txt",
    upstreamUrl: "https://www.gnu.org/licenses/old-licenses/lgpl-2.1.txt",
    sha256: "20e50fe7aae3e56378ebf0417d9de904f55a0e61e4df315333e632a4d3555d95",
    kind: "license",
  },
];
const pinnedFontTexts = [
  {
    directory: "Assistant",
    family: "Assistant",
    license: "SIL Open Font License 1.1",
    assetSource:
      "https://github.com/excalidraw/excalidraw/tree/v0.18.1/packages/excalidraw/fonts/Assistant",
    provenance:
      "Assistant upstream family source at TypeNetwork/Assistant commit 2b5ffdccb0216ccbdbdc8a623f3b935fc5b5e04a",
    files: [
      {
        fileName: "assistant-OFL.txt",
        sha256:
          "7eaf6282cfab122b99ffd62a122fc27b6c3c8f2c65b56ff9b3a25badbc64887d",
        sourceUrl:
          "https://raw.githubusercontent.com/TypeNetwork/Assistant/2b5ffdccb0216ccbdbdc8a623f3b935fc5b5e04a/OFL.txt",
        sourceSha256:
          "7eaf6282cfab122b99ffd62a122fc27b6c3c8f2c65b56ff9b3a25badbc64887d",
        fullLicense: true,
      },
    ],
  },
  {
    directory: "Cascadia",
    family: "Cascadia Code",
    license: "SIL Open Font License 1.1",
    assetSource:
      "https://github.com/excalidraw/excalidraw/tree/v0.18.1/packages/excalidraw/fonts/Cascadia",
    provenance:
      "Microsoft Cascadia Code source at commit 56bcca3f2c1e4cb19458954f0e2bb4635960df91",
    files: [
      {
        fileName: "cascadia-code-LICENSE.txt",
        sha256:
          "51882cd3cdba4e16f220f44ddb08a635c38c44ea6e0975db2574f4be6f958238",
        sourceUrl:
          "https://raw.githubusercontent.com/microsoft/cascadia-code/56bcca3f2c1e4cb19458954f0e2bb4635960df91/LICENSE",
        sourceSha256:
          "51882cd3cdba4e16f220f44ddb08a635c38c44ea6e0975db2574f4be6f958238",
        fullLicense: true,
      },
    ],
  },
  {
    directory: "ComicShanns",
    family: "Comic Shanns",
    license: "MIT",
    assetSource:
      "https://github.com/excalidraw/excalidraw/tree/v0.18.1/packages/excalidraw/fonts/ComicShanns",
    provenance:
      "Copyright and full MIT text reproduced from the generated font metadata in the pinned Excalidraw v0.18.1 font index",
    files: [
      {
        fileName: "comicshanns-MIT.txt",
        sha256:
          "7eb22fea12d8576dd582fff222e962d9bb4da2ce2adb536490fe72b1d5feeeca",
        sourceUrl:
          "https://raw.githubusercontent.com/excalidraw/excalidraw/v0.18.1/packages/excalidraw/fonts/ComicShanns/index.ts",
        sourceSha256:
          "43742ce64655de872db8eeaaab9c12a665fb0b333114ae59283714848b988bec",
        fullLicense: true,
      },
    ],
  },
  {
    directory: "Excalifont",
    family: "Excalifont",
    license: "SIL Open Font License 1.1",
    assetSource:
      "https://github.com/excalidraw/excalidraw/tree/v0.18.1/packages/excalidraw/fonts/Excalifont",
    provenance:
      "Copyright, designer, trademark, and full OFL text reproduced from the bundled font metadata in the pinned Excalidraw v0.18.1 font index",
    files: [
      {
        fileName: "excalifont-OFL.txt",
        sha256:
          "4624d56694f3a02be2b6302965ebd1fc4b412879a286270e31b7f6f76730480a",
        sourceUrl:
          "https://raw.githubusercontent.com/excalidraw/excalidraw/v0.18.1/packages/excalidraw/fonts/Excalifont/index.ts",
        sourceSha256:
          "db994e57791014204ba89e7ff902f2409b46ace3cd53907c3b4ac0e88d8e18c9",
        fullLicense: true,
      },
    ],
  },
  {
    directory: "Liberation",
    family: "Liberation Sans (pre-2.00 family license)",
    license: "GPL-2.0 with the Liberation font exceptions",
    assetSource:
      "https://github.com/excalidraw/excalidraw/tree/v0.18.1/packages/excalidraw/fonts/Liberation",
    provenance:
      "The bundled font reports OpenType font version 1.x; the official Liberation 1.07.5 source carries this GPLv2-plus-exceptions license, and the project documents that the OFL transition starts at v2.00.",
    provenanceSources: [
      {
        url: "https://raw.githubusercontent.com/liberationfonts/liberation-sans-narrow/5462920fee502b688604472e65af49af951bdd56/README.rst",
        sha256:
          "b66ecbdb5623f839ed40954fd032366b5b1f4f742338265238ca1c45b70ab95d",
      },
    ],
    files: [
      {
        fileName: "liberation-font-1.x-License.txt",
        sha256:
          "c40dd6adebad817defd68c7edad151d9c13d2ac3b4e1790ce2b727b024438b6d",
        sourceUrl:
          "https://raw.githubusercontent.com/liberationfonts/liberation-1.7-fonts/1.07.5/License.txt",
        sourceSha256:
          "c40dd6adebad817defd68c7edad151d9c13d2ac3b4e1790ce2b727b024438b6d",
        fullLicense: false,
      },
      {
        fileName: "GPL-2.0.txt",
        sha256:
          "edaef632cbb643e4e7a221717a6c441a4c1a7c918e6e4d56debc3d8739b233f6",
        sourceUrl: "https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt",
        sourceSha256:
          "edaef632cbb643e4e7a221717a6c441a4c1a7c918e6e4d56debc3d8739b233f6",
        fullLicense: true,
      },
    ],
  },
  {
    directory: "Lilita",
    family: "Lilita One",
    license: "SIL Open Font License 1.1",
    assetSource:
      "https://github.com/excalidraw/excalidraw/tree/v0.18.1/packages/excalidraw/fonts/Lilita",
    provenance:
      "Official Google Fonts Lilita One license at initial source commit 90abd17b4f97671435798b6147b698aa9087612f",
    files: [
      {
        fileName: "lilita-one-OFL.txt",
        sha256:
          "255d5debbb80eb2ea762644311f266a279e8778f00156655a516e2b7781a63e1",
        sourceUrl:
          "https://raw.githubusercontent.com/google/fonts/90abd17b4f97671435798b6147b698aa9087612f/ofl/lilitaone/OFL.txt",
        sourceSha256:
          "255d5debbb80eb2ea762644311f266a279e8778f00156655a516e2b7781a63e1",
        fullLicense: true,
      },
    ],
  },
  {
    directory: "Nunito",
    family: "Nunito",
    license: "SIL Open Font License 1.1",
    assetSource:
      "https://github.com/excalidraw/excalidraw/tree/v0.18.1/packages/excalidraw/fonts/Nunito",
    provenance:
      "Official Nunito project source at commit 8c6a9bb9732545b9ed53f29ec5e1ab0ff53c4e6f",
    files: [
      {
        fileName: "nunito-OFL.txt",
        sha256:
          "580df76c95a1ec5ab878ceb25bb3d85c6a076804e9c970c8c6972aea775fdf65",
        sourceUrl:
          "https://raw.githubusercontent.com/googlefonts/nunito/8c6a9bb9732545b9ed53f29ec5e1ab0ff53c4e6f/OFL.txt",
        sourceSha256:
          "580df76c95a1ec5ab878ceb25bb3d85c6a076804e9c970c8c6972aea775fdf65",
        fullLicense: true,
      },
    ],
  },
  {
    directory: "Virgil",
    family: "Virgil",
    license: "SIL Open Font License 1.1",
    assetSource:
      "https://github.com/excalidraw/excalidraw/tree/v0.18.1/packages/excalidraw/fonts/Virgil",
    provenance:
      "Official Excalidraw Virgil project license from its first font source commit e97fb25f0e63e88a80280caef8b1d8edf0627cb0",
    files: [
      {
        fileName: "virgil-OFL.txt",
        sha256:
          "a3ac9cdc65ef304ffb095d8cc877ee93bf1bffa88269693cd42ddf001650ffd0",
        sourceUrl:
          "https://raw.githubusercontent.com/excalidraw/virgil/e97fb25f0e63e88a80280caef8b1d8edf0627cb0/LICENSE.md",
        sourceSha256:
          "a3ac9cdc65ef304ffb095d8cc877ee93bf1bffa88269693cd42ddf001650ffd0",
        fullLicense: true,
      },
    ],
  },
  {
    directory: "Xiaolai",
    family: "Xiaolai SC",
    license: "SIL Open Font License 1.1",
    assetSource:
      "https://github.com/excalidraw/excalidraw/tree/v0.18.1/packages/excalidraw/fonts/Xiaolai",
    provenance:
      "Copyright, original font version 3.11, designer, and OFL declaration reproduced from the bundled font metadata in the pinned Excalidraw v0.18.1 font index; the full standard OFL is included.",
    files: [
      {
        fileName: "xiaolai-OFL.txt",
        sha256:
          "f1a75d06387f26d41490f550f6bd35ad44f08fa43ecf2455ce05fc30c1ddc3eb",
        sourceUrl:
          "https://raw.githubusercontent.com/excalidraw/excalidraw/v0.18.1/packages/excalidraw/fonts/Xiaolai/index.ts",
        sourceSha256:
          "c2cbbbfa669404795527e06cf596ab4b1b851f9bb993c608c8ab9c3c2aabe9d3",
        fullLicense: true,
      },
    ],
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

async function fontAssetFiles(directory) {
  const files = [];
  async function walk(current, relative = "") {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const filePath = path.join(current, entry.name);
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink())
        throw new Error(`Font asset is a symbolic link: ${filePath}.`);
      if (entry.isDirectory()) {
        await walk(filePath, relativePath);
        continue;
      }
      if (!entry.isFile())
        throw new Error(`Unsupported font asset entry: ${filePath}.`);
      const bytes = await readFile(filePath);
      files.push({
        path: relativePath,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
  await walk(directory);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function packageNotices(
  directory,
  packagePath,
  metadata,
  runtimeDirectory,
) {
  const notices = [];
  const skipped = [];
  let nativeComponents;
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
      const sharpLibvipsReadme =
        /^node_modules\/@img\/sharp-libvips-linux-(?:x64|arm64)$/.test(
          packagePath,
        ) && entry.name === "README.md";
      if (
        !entry.isFile() ||
        (!inLicenseDirectory &&
          !noticeName.test(entry.name) &&
          !sharpLibvipsReadme)
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
  if (
    /^node_modules\/@napi-rs\/canvas-linux-(?:x64|arm64)-gnu$/.test(packagePath)
  ) {
    const parentPath = "node_modules/@napi-rs/canvas";
    const parentDirectory = path.join(sourceModules, "@napi-rs/canvas");
    const parentMetadata = await readPackageMetadata(parentDirectory);
    const parentLicense = await readFile(path.join(parentDirectory, "LICENSE"));
    const parentHash = createHash("sha256").update(parentLicense).digest("hex");
    if (
      metadata.version !== "1.0.2" ||
      lock.packages[packagePath]?.version !== "1.0.2" ||
      parentMetadata?.version !== "1.0.2" ||
      lock.packages[parentPath]?.version !== "1.0.2" ||
      parentHash !==
        "8802fecf9da4367bc23bcf20b21cc143785fc6c92b152f3fa7fbe6ce08d344d6"
    )
      throw new Error(
        `Pinned @napi-rs/canvas v1.0.2 MIT notice does not match ${packagePath} and its parent package.`,
      );
    notices.push({
      path: "LICENSE",
      sourcePath: `${parentPath}/LICENSE`,
      hash: parentHash,
      text: new TextDecoder("utf-8", { fatal: true }).decode(parentLicense),
      fullLicense: true,
      upstreamUrl:
        "https://raw.githubusercontent.com/Brooooooklyn/canvas/v1.0.2/LICENSE",
    });
  }
  if (
    /^node_modules\/@img\/sharp-libvips-linux-(?:x64|arm64)$/.test(packagePath)
  ) {
    if (!runtimeDirectory)
      throw new Error(
        `The selected sharp-libvips package is not traced into the runtime: ${packagePath}.`,
      );
    const runtimePackageDirectory = runtimeDirectory;
    const versionBytes = await readFile(
      path.join(runtimePackageDirectory, "versions.json"),
    );
    const versions = JSON.parse(versionBytes.toString("utf8"));
    if (metadata.version !== "1.3.4" || versions.vips !== "8.18.7")
      throw new Error(
        `Pinned sharp-libvips expects package 1.3.4 and libvips 8.18.7, received package=${metadata.version} libvips=${versions.vips ?? "missing"}.`,
      );
    const sharedLibraryPath = `lib/libvips-cpp.so.${versions.vips}`;
    const sharedLibraryBytes = await readFile(
      path.join(runtimePackageDirectory, sharedLibraryPath),
    );
    nativeComponents = {
      versions,
      versionsFileSha256: createHash("sha256")
        .update(versionBytes)
        .digest("hex"),
      sharedLibraryPath,
      sharedLibraryBytes: sharedLibraryBytes.byteLength,
      sharedLibrarySha256: createHash("sha256")
        .update(sharedLibraryBytes)
        .digest("hex"),
    };
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
  return { notices, skipped, nativeComponents };
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
    const { notices, skipped, nativeComponents } = await packageNotices(
      sourceRoot,
      packagePath,
      metadata,
      hasRuntime ? runtimePath : undefined,
    );
    packageResults[index] = {
      packagePath,
      name: metadata.name ?? packagePath.slice("node_modules/".length),
      version: metadata.version ?? "unknown",
      license: metadata.license ?? null,
      repository: metadata.repository ?? null,
      sourceInstalled: hasSource,
      runtimeTraced: hasRuntime,
      nativeComponents,
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
      filePath:
        notice.sourcePath ??
        (notice.path.startsWith("src/")
          ? notice.path
          : `node_modules/${result.packagePath.slice("node_modules/".length)}/${notice.path}`),
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

for (const criticalPath of criticalRuntimePaths) {
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

const tesseractPackagePath = "node_modules/@tesseract.js-data/eng";
const tesseractPackage = await readPackageMetadata(
  path.join(sourceModules, "@tesseract.js-data/eng"),
);
const tesseractLockEntry = lock.packages[tesseractPackagePath];
const rootPackage = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
const tesseractSourceReadmeUrl =
  "https://raw.githubusercontent.com/naptha/tessdata/806cd9adc8c6e8abc11c782db1818c990576bebc/README.md";
const tesseractSourceReadmeHash =
  "7e83e5899fd3883f10cc44c5b1b57550910b13ee759ed9a8ac57831e960cd7dd";
const tesseractUpstreamAssetUrl =
  "https://raw.githubusercontent.com/naptha/tessdata/806cd9adc8c6e8abc11c782db1818c990576bebc/4.0.0_best_int/eng.traineddata.gz";
const tesseractUpstreamAssetGitBlobSha1 =
  "730a6a59010b9440e38dd85f9fe6b6bf0637e6eb";
const tesseractPublishedAssetUrl =
  "https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz";
const tesseractProvenancePath = "native/tessdata-package-provenance.txt";
const tesseractProvenanceBytes = await readFile(
  path.join(vendorLicenseDirectory, tesseractProvenancePath),
);
const tesseractProvenanceHash = createHash("sha256")
  .update(tesseractProvenanceBytes)
  .digest("hex");
const tesseractProvenanceText = new TextDecoder("utf-8", {
  fatal: true,
}).decode(tesseractProvenanceBytes);
const tesseractAssetPath = "4.0.0_best_int/eng.traineddata.gz";
const tesseractSourceAsset = await readFile(
  path.join(sourceModules, "@tesseract.js-data/eng", tesseractAssetPath),
);
const tesseractRuntimeAssetPath =
  "generated/ocr/4.0.0_best_int/eng.traineddata.gz";
const tesseractRuntimeAsset = await readFile(
  path.join(standalone, tesseractRuntimeAssetPath),
);
let tesseractRuntimePackagePresent = false;
try {
  await stat(path.join(standaloneModules, "@tesseract.js-data", "eng"));
  tesseractRuntimePackagePresent = true;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const tesseractAssetHash = createHash("sha256")
  .update(tesseractSourceAsset)
  .digest("hex");
const tesseractApacheLicensePath =
  "native/tessdata-best-Apache-2.0-LICENSE.txt";
const tesseractApacheLicense = await readFile(
  path.join(vendorLicenseDirectory, tesseractApacheLicensePath),
);
const tesseractApacheHash = createHash("sha256")
  .update(tesseractApacheLicense)
  .digest("hex");
const tesseractChecks = {
  packageIsBuildOnly:
    rootPackage.dependencies?.["@tesseract.js-data/eng"] === undefined &&
    rootPackage.devDependencies?.["@tesseract.js-data/eng"] === "1.0.0" &&
    tesseractLockEntry.dev === true,
  packageMetadataIsPinned:
    tesseractPackage?.version === "1.0.0" &&
    tesseractLockEntry?.version === "1.0.0" &&
    tesseractLockEntry.license === "MIT" &&
    tesseractPackage.license === "MIT" &&
    tesseractLockEntry.integrity ===
      "sha512-mbTumm6KQPUHyzTPQaF3ObXYnx0SqqfV2nabqFVQBwD6Kl7PhGSLSzOlfFTWy0P3BjghaSKA2W9GB19Jk+ZcTg==" &&
    tesseractPackage.repository?.url ===
      "https://github.com/naptha/tessdata.git",
  provenanceIsPinned:
    tesseractProvenanceHash ===
      "0c599eb893da158e473368d479541f274362645c731d49b3e640f479b892909e" &&
    tesseractProvenanceText.includes(tesseractSourceReadmeUrl) &&
    tesseractProvenanceText.includes(tesseractSourceReadmeHash) &&
    tesseractProvenanceText.includes(
      '`4.0.0_best_int` - Integerized Version of "Tessdata Best"',
    ) &&
    tesseractProvenanceText.includes(
      "https://github.com/tesseract-ocr/tessdata_best",
    ) &&
    tesseractProvenanceText.includes(tesseractPublishedAssetUrl) &&
    tesseractProvenanceText.includes(tesseractUpstreamAssetUrl) &&
    tesseractProvenanceText.includes(tesseractUpstreamAssetGitBlobSha1) &&
    tesseractProvenanceText.includes(
      "45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91",
    ),
  sourceAssetHashIsPinned:
    tesseractAssetHash ===
    "45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91",
  runtimeAssetMatchesSource: tesseractRuntimeAsset.equals(tesseractSourceAsset),
  buildOnlyPackageExcluded: !tesseractRuntimePackagePresent,
  licenseTextIsPinned:
    tesseractApacheHash ===
    "a6cba85bc92e0cff7a450b1d873c0eaa2e9fc96bf472df0247a26bec77bf3ff9",
};
const failedTesseractChecks = Object.entries(tesseractChecks)
  .filter(([, passed]) => !passed)
  .map(([name]) => name);
if (failedTesseractChecks.length)
  throw new Error(
    `Pinned Tesseract packaging checks failed: ${failedTesseractChecks.join(", ")}.`,
  );
const tesseractData = {
  packageVersion: tesseractPackage.version,
  packageIntegrity: tesseractLockEntry.integrity,
  packageRepository: tesseractPackage.repository.url,
  provenancePath: tesseractProvenancePath,
  provenanceSha256: tesseractProvenanceHash,
  provenanceText: tesseractProvenanceText,
  sourceReadmeUrl: tesseractSourceReadmeUrl,
  sourceReadmeSha256: tesseractSourceReadmeHash,
  assetPath: tesseractRuntimeAssetPath,
  assetBytes: tesseractSourceAsset.byteLength,
  assetSha256: tesseractAssetHash,
  licensePath: tesseractApacheLicensePath,
  licenseSha256: tesseractApacheHash,
  licenseSource:
    "https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/e12c65a915945e4c28e237a9b52bc4a8f39a0cec/LICENSE",
  licenseText: new TextDecoder("utf-8", { fatal: true }).decode(
    tesseractApacheLicense,
  ),
};

const fontRoot = path.join(root, "public/excalidraw/fonts");
const fontDirectories = await readdir(fontRoot, { withFileTypes: true });
const fontAssets = fontDirectories
  .filter((item) => item.isDirectory())
  .map((item) => item.name)
  .sort();
const fontLicenseGaps = [];
const fontAssetResults = [];
const fontLicenseResults = [];
const excalidrawPackagePath = "node_modules/@excalidraw/excalidraw";
const excalidrawMetadata = await readPackageMetadata(
  path.join(sourceModules, "@excalidraw/excalidraw"),
);
if (
  excalidrawMetadata?.version !== "0.18.1" ||
  lock.packages[excalidrawPackagePath]?.version !== "0.18.1"
)
  throw new Error(
    `Font source pin expects @excalidraw/excalidraw@0.18.1, received installed=${excalidrawMetadata?.version ?? "missing"} lock=${lock.packages[excalidrawPackagePath]?.version ?? "missing"}.`,
  );

const fontLicenseByDirectory = new Map(
  pinnedFontTexts.map((font) => [font.directory, font]),
);
for (const entry of fontDirectories.filter((item) => !item.isDirectory()))
  fontLicenseGaps.push(
    `public/excalidraw/fonts/${entry.name}: unexpected non-directory font entry`,
  );
for (const font of fontAssets.filter(
  (item) => !fontLicenseByDirectory.has(item),
))
  fontLicenseGaps.push(
    `public/excalidraw/fonts/${font}: no pinned upstream license record`,
  );
for (const font of pinnedFontTexts.filter(
  (item) => !fontAssets.includes(item.directory),
))
  fontLicenseGaps.push(
    `public/excalidraw/fonts/${font.directory}: pinned font directory is absent`,
  );

for (const font of pinnedFontTexts) {
  if (!fontAssets.includes(font.directory)) continue;
  const sourceDirectory = path.join(
    sourceModules,
    "@excalidraw/excalidraw/dist/prod/fonts",
    font.directory,
  );
  const publicDirectory = path.join(fontRoot, font.directory);
  let sourceFiles;
  let publicFiles;
  try {
    [sourceFiles, publicFiles] = await Promise.all([
      fontAssetFiles(sourceDirectory),
      fontAssetFiles(publicDirectory),
    ]);
  } catch (error) {
    fontLicenseGaps.push(
      `public/excalidraw/fonts/${font.directory}: ${error.message}`,
    );
    continue;
  }
  const sourceManifest = sourceFiles
    .map((item) => `${item.path}\0${item.sha256}\n`)
    .join("");
  const assetSha256 = createHash("sha256").update(sourceManifest).digest("hex");
  if (sourceFiles.length === 0)
    fontLicenseGaps.push(
      `public/excalidraw/fonts/${font.directory}: no font files were found`,
    );
  if (JSON.stringify(sourceFiles) !== JSON.stringify(publicFiles))
    fontLicenseGaps.push(
      `public/excalidraw/fonts/${font.directory}: bundled assets differ from @excalidraw/excalidraw@0.18.1`,
    );
  fontAssetResults.push({
    ...font,
    files: sourceFiles,
    assetSha256,
  });

  const licenseFiles = [];
  for (const license of font.files) {
    const filePath = path.join(fontLicenseDirectory, license.fileName);
    let bytes;
    try {
      bytes = await readFile(filePath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      fontLicenseGaps.push(
        `public/excalidraw/fonts/${font.directory}: missing ${license.fileName}`,
      );
      continue;
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== license.sha256)
      fontLicenseGaps.push(
        `public/excalidraw/fonts/${font.directory}: ${license.fileName} hash mismatch (expected ${license.sha256}, received ${sha256})`,
      );
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (
      license.fullLicense &&
      !text.includes("Permission") &&
      !text.includes("PERMISSION") &&
      !text.includes("copyright")
    )
      fontLicenseGaps.push(
        `public/excalidraw/fonts/${font.directory}: ${license.fileName} does not contain a recognizable full license body`,
      );
    licenseFiles.push({ ...license, text, sha256 });
  }
  if (licenseFiles.length === font.files.length)
    fontLicenseResults.push({ ...font, licenseFiles });
}

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
  if (item.nativeComponents) {
    lines.push(
      `  Bundled component versions (${item.nativeComponents.versionsFileSha256}): ${JSON.stringify(item.nativeComponents.versions)}`,
      `  Runtime library: ${item.nativeComponents.sharedLibraryPath} (${item.nativeComponents.sharedLibraryBytes} bytes, sha256:${item.nativeComponents.sharedLibrarySha256})`,
    );
  }
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
  ...fontAssetResults.map(
    (font) =>
      `- ${font.family}: ${font.files.length} asset files from @excalidraw/excalidraw@0.18.1, source ${font.assetSource}; sorted path/NUL/file-SHA-256 manifest sha256:${font.assetSha256}.`,
  ),
  "",
  "PINNED LOCAL MODEL",
  `- ${modelManifest.repository}@${modelManifest.revision}`,
  `  Declared license: ${modelManifest.license}`,
  "  The model build stage writes the Apache-2.0 text available from the tokenizer package and a NOTICE with repository and revision details under /app/models/arctic/.",
  "",
  "BUNDLED OFFLINE OCR DATASET",
  `- Runtime file: ${tesseractData.assetPath} (${tesseractData.assetBytes} bytes, sha256:${tesseractData.assetSha256})`,
  `  Build-only source package: @tesseract.js-data/eng@${tesseractData.packageVersion} (${tesseractData.packageIntegrity}); repository ${tesseractData.packageRepository}`,
  "  The npm wrapper, package metadata and unbundled language files are excluded from the runtime image.",
  `  Upstream model provenance README: ${tesseractData.sourceReadmeUrl} sha256:${tesseractData.sourceReadmeSha256}`,
  `  Pinned provenance excerpt: src/lib/server/ai/licenses/${tesseractData.provenancePath} sha256:${tesseractData.provenanceSha256}`,
  tesseractData.provenanceText.trimEnd(),
  `  Upstream dataset license source: ${tesseractData.licenseSource} sha256:${tesseractData.licenseSha256}`,
  "  The asset is distributed under the full upstream Apache-2.0 data license included below.",
  "",
  `--- Tessdata Best model-data Apache-2.0 sha256:${tesseractData.licenseSha256} ---`,
  `Source: ${tesseractData.licenseSource}`,
  "",
  tesseractData.licenseText.trimEnd(),
  "",
  "PINNED FONT LICENSE TEXTS AND PROVENANCE",
);

for (const font of fontLicenseResults) {
  lines.push(
    `- ${font.family} (${font.license})`,
    `  Excalidraw asset source: ${font.assetSource}`,
    `  License provenance: ${font.provenance}`,
  );
  for (const source of font.provenanceSources ?? [])
    lines.push(
      `  License transition/source evidence: ${source.url}`,
      `  Evidence SHA-256: ${source.sha256}`,
    );
  for (const license of font.licenseFiles) {
    lines.push(
      `  Included text: src/lib/server/ai/licenses/fonts/${license.fileName} sha256:${license.sha256}`,
      `  Pinned source: ${license.sourceUrl}`,
      `  Upstream source SHA-256: ${license.sourceSha256}`,
      `  Full license text: ${license.fullLicense ? "yes" : "additional family-specific terms; see accompanying full license"}`,
    );
  }
  lines.push("");
}

for (const font of fontLicenseResults) {
  for (const license of font.licenseFiles) {
    lines.push(
      `--- ${font.family} ${font.license} sha256:${license.sha256} ---`,
      `Source: ${license.sourceUrl}`,
      `Source SHA-256: ${license.sourceSha256}`,
      "",
      license.text.trimEnd(),
      "",
    );
  }
}

lines.push("UPSTREAM PACKAGE LICENSE AND NOTICE TEXTS");

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
for (const criticalPath of criticalRuntimePaths) {
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
    criticalRuntimePaths.includes(item.packagePath) &&
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
  !written.includes(tesseractData.licenseSource) ||
  !written.includes(`sha256:${tesseractData.licenseSha256}`) ||
  !written.includes(tesseractData.sourceReadmeUrl) ||
  !written.includes(tesseractUpstreamAssetUrl) ||
  !written.includes(tesseractUpstreamAssetGitBlobSha1) ||
  !written.includes(`sha256:${tesseractData.sourceReadmeSha256}`) ||
  !written.includes(`sha256:${tesseractData.provenanceSha256}`) ||
  !written.includes(`sha256:${tesseractData.assetSha256}`) ||
  written.includes("Installed path: node_modules/@tesseract.js-data/eng") ||
  pinnedTexts.some((item) => !written.includes(item.upstreamUrl)) ||
  pinnedTexts.some((item) => !written.includes(`sha256:${item.sha256}`)) ||
  fontLicenseResults.length !== pinnedFontTexts.length ||
  fontAssetResults.length !== pinnedFontTexts.length ||
  pinnedFontTexts.some(
    (item) =>
      !written.includes(item.assetSource) ||
      item.files.some(
        (file) =>
          !written.includes(file.sourceUrl) ||
          !written.includes(`sha256:${file.sha256}`) ||
          !written.includes(`Source SHA-256: ${file.sourceSha256}`),
      ),
  )
)
  throw new Error(
    "Generated third-party notice inventory failed verification.",
  );

const blockers = [
  ...criticalMissingFullText.map(
    (item) =>
      `${item.name}@${item.version} (${item.packagePath}): no full license text`,
  ),
  ...fontLicenseGaps.map((gap) => `Excalidraw font packaging: ${gap}`),
];
if (blockers.length) {
  const report = [
    "",
    "IMPORTANT DISTRIBUTION BLOCKERS",
    `Critical package full-license gaps: ${criticalMissingFullText.length}`,
    `Bundled Excalidraw font license and provenance gaps: ${fontLicenseGaps.length}`,
    ...blockers.map((item) => `- ${item}`),
    "No SPDX metadata was used to fabricate a full notice.",
    "",
  ].join("\n");
  await writeFile(outputPath, `${written.trimEnd()}\n${report}`);
}

console.log(
  `Generated ${path.relative(root, outputPath)} for ${packages.length} packages; ${noticeGroups.size} distinct upstream package text files; ${missingTextPackages.length} packages without readable package-provided upstream text; ${criticalMissingFullText.length} critical package license gaps; ${fontAssetResults.length} bundled font asset manifests; ${fontLicenseResults.length} bundled font licenses; ${fontLicenseGaps.length} bundled font gaps.`,
);
if (blockers.length) {
  console.error(`Distribution validation blocked: ${blockers.join("; ")}`);
  process.exitCode = 1;
}
