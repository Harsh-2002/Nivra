import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
const root = path.resolve(
  ".next/standalone/node_modules/onnxruntime-node/bin/napi-v6",
);
for (const platform of await readdir(root)) {
  const platformPath = path.join(root, platform);
  if (!(await stat(platformPath)).isDirectory()) continue;
  if (platform !== process.platform) {
    await rm(platformPath, { recursive: true });
    continue;
  }
  for (const arch of await readdir(platformPath)) {
    const archPath = path.join(platformPath, arch);
    if (arch !== process.arch) {
      await rm(archPath, { recursive: true });
      continue;
    }
    for (const file of await readdir(archPath))
      if (/cuda|tensorrt/i.test(file)) await rm(path.join(archPath, file));
  }
}
