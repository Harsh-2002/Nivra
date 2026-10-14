import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

async function patch(file, before, after) {
  const source = await readFile(file, "utf8");
  if (source.includes(after)) return;
  if (source.split(before).length !== 2)
    throw new Error(`Review the CSP compatibility patch for ${file}.`);
  await writeFile(file, source.replace(before, after));
}
for (const [name, version] of [
  ["mermaid", "11.17.2"],
  ["d3-selection", "3.0.0"],
  ["prosemirror-model", "1.25.12"],
  ["@blocknote/react", "0.55.0"],
  ["@radix-ui/react-select", "2.3.7"],
]) {
  const pkg = JSON.parse(
    await readFile(`node_modules/${name}/package.json`, "utf8"),
  );
  if (pkg.version !== version)
    throw new Error(`Review CSP compatibility before upgrading ${name}.`);
}
await patch(
  "node_modules/mermaid/dist/mermaid.core.mjs",
  'const style1 = document.createElement("style");',
  'const style1 = document.createElement("style");\n  style1.nonce = globalThis.__nivraCspNonce || document.querySelector(\'meta[name="nivra-nonce"]\')?.content || "";',
);
await patch(
  "node_modules/d3-selection/src/selection/attr.js",
  "this.setAttribute(name, value);",
  'if (name === "style") this.style.cssText = value;\n    else this.setAttribute(name, value);',
);
await patch(
  "node_modules/d3-selection/src/selection/attr.js",
  "else this.setAttribute(name, v);",
  'else if (name === "style") this.style.cssText = v;\n    else this.setAttribute(name, v);',
);
const directory = "node_modules/mermaid/dist/chunks/mermaid.core";
await patch(
  path.join(directory, "chunk-4HAMMTFA.mjs"),
  'child.setAttribute("style", style);',
  "child.style.cssText = style;",
);
await patch(
  path.join(directory, "swimlanes-42K2YHIH.mjs"),
  'pathEl.setAttribute("style", cleaned);',
  "pathEl.style.cssText = cleaned;",
);

await patch(
  "node_modules/prosemirror-model/dist/index.js",
  "dom.setAttribute(name, attrs[name]);",
  'if (name === "style") dom.style.cssText = attrs[name]; else dom.setAttribute(name, attrs[name]);',
);

await patch(
  "node_modules/@blocknote/react/dist/confirmDiscardUnsavedComment-BLTco3jJ.js",
  "]), !b || !n) return !1;",
  ']), !b || !n || C === "close") return !1;',
);

for (const [file, prefix] of [
  ["index.mjs", ""],
  ["index.js", "import_react_visually_hidden."],
]) {
  await patch(
    `node_modules/@radix-ui/react-select/dist/${file}`,
    `style: { ...${prefix}VISUALLY_HIDDEN_STYLES, ...props.style },`,
    'className: [props.className, "nivra-select-bubble"].filter(Boolean).join(" "),\n        style: props.style,',
  );
  await patch(
    `node_modules/@radix-ui/react-select/dist/${file}`,
    'style: { pointerEvents: "none" },',
    'className: "nivra-select-value",',
  );
}
