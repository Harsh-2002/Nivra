import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync } from "fflate";
import { validateReleaseTag } from "./release-policy.mjs";

const permissions = ["activeTab", "contextMenus", "identity", "storage"];
const optionalHosts = ["http://*/*", "https://*/*"];
const forbidden = [
  "host_permissions",
  "content_scripts",
  "web_accessible_resources",
  "externally_connectable",
  "declarative_net_request",
  "chrome_url_overrides",
  "devtools_page",
  "side_panel",
  "update_url",
];
const contentSecurityPolicy =
  "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; connect-src https: http:; img-src 'self' data:; style-src 'self'";
const same = (a, b) =>
  a.length === b.length &&
  [...a].sort().every((v, i) => v === [...b].sort()[i]);

/** Chrome rejects zero-padded parts, so 2026.10.05 becomes 2026.10.5. */
export function manifestVersion(tag) {
  validateReleaseTag(tag);
  return tag.slice(1).split(".").map(Number).join(".");
}
/** Fails when the manifest widens the extension's trust boundary. */
export function auditManifest(manifest) {
  const problems = [];
  if (manifest.manifest_version !== 3) problems.push("manifest_version");
  if (!same(manifest.permissions ?? [], permissions))
    problems.push(`permissions must be ${permissions.join(", ")}`);
  if (!same(manifest.optional_host_permissions ?? [], optionalHosts))
    problems.push("optional_host_permissions");
  for (const key of forbidden)
    if (key in manifest) problems.push(`${key} is not allowed`);
  if (
    manifest.content_security_policy?.extension_pages !== contentSecurityPolicy
  )
    problems.push("content_security_policy.extension_pages");
  if (!manifest.key) problems.push("key (pins the extension ID)");
  if (manifest.background?.service_worker !== "dist/background.js")
    problems.push("background.service_worker");
  if (problems.length)
    throw new Error(`Extension manifest: ${problems.join("; ")}`);
}
function auditSources(files) {
  const problems = [];
  const text = (name) => new TextDecoder().decode(files[name]);
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(text("popup.html")))
    problems.push("popup.html contains an inline script");
  for (const name of ["popup.html", "popup.css"])
    if (/(?:src|href)\s*=\s*["']https?:|url\(\s*["']?https?:/i.test(text(name)))
      problems.push(`${name} loads a remote resource`);
  for (const name of Object.keys(files).filter((n) => n.endsWith(".js")))
    if (
      /\beval\s*\(|new Function\s*\(|\.innerHTML\s*=|document\.write\s*\(/.test(
        text(name),
      )
    )
      problems.push(`${name} uses dynamic code or HTML injection`);
  if (problems.length)
    throw new Error(`Extension sources: ${problems.join("; ")}`);
}
/** @param {{root?: string, tag: string}} input */
export function buildPackage({ root = "extension", tag }) {
  const manifest = JSON.parse(
    readFileSync(join(root, "manifest.json"), "utf8"),
  );
  auditManifest(manifest);
  const files = {};
  const read = (name) => {
    files[name] = new Uint8Array(readFileSync(join(root, name)));
  };
  for (const name of ["popup.html", "popup.css"]) read(name);
  for (const directory of ["dist", "fonts", "icons"]) {
    const entries = readdirSync(join(root, directory)).sort();
    if (!entries.length) throw new Error(`${directory} is empty; build first.`);
    for (const entry of entries) read(`${directory}/${entry}`);
  }
  for (const required of ["dist/background.js", "dist/popup.js"])
    if (!files[required])
      throw new Error(`${required} is missing; build first.`);
  auditSources(files);
  const stamped = {
    ...manifest,
    version: manifestVersion(tag),
    version_name: tag.slice(1),
  };
  files["manifest.json"] = new TextEncoder().encode(
    `${JSON.stringify(stamped, null, 2)}\n`,
  );
  const mtime = new Date("2020-01-01T00:00:00Z");
  const entries = Object.fromEntries(
    Object.keys(files)
      .sort()
      .map((name) => [name, [files[name], { mtime, level: 9 }]]),
  );
  const bytes = zipSync(entries);
  return {
    name: `nivra-extension-${tag}.zip`,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    files: Object.keys(entries),
    version: stamped.version,
  };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const tag = process.env.RELEASE_TAG ?? "v2026.01.01";
  const out = process.argv[2];
  const result = buildPackage({ tag });
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, result.name), result.bytes);
  }
  console.log(
    `${result.name} ${result.bytes.length} bytes sha256 ${result.sha256} version ${result.version}`,
  );
}
