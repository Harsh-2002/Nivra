# Third-party notices

Nivra's own source is MIT licensed. Dependencies retain their original notices and licenses.

- Node.js: MIT, with bundled third-party notices. The Debian runtime retains the full license at `/usr/share/licenses/node/LICENSE`. Both architectures verify the license hash for the pinned Node release; update it when changing the base image.

- BlockNote core, React, shadcn, code-block, and diagram-block and server-util packages: MPL-2.0. No XL packages are used. Modifications to covered upstream source remain subject to its license; Nivra's custom blocks are maintained separately.
- Excalidraw: MIT. Its bundled fonts retain their upstream font licenses. Generated assets are copied from the installed package rather than fetched from a CDN.
- Shiki core, JavaScript engine, precompiled languages and themes, Mermaid, and DOMPurify: MIT. The published reader reuses pinned versions already present in the editor dependency tree.
- Geist: SIL Open Font License 1.1, distributed through `@fontsource-variable/geist`.
- Tesseract.js and its WebAssembly core: Apache-2.0. Bundled English language data from `@tesseract.js-data/eng`: MIT. unpdf: MIT. OCR and PDF extraction run locally with pinned packages and retain their upstream notices.
- Sharp: Apache-2.0. OCR uses it for EXIF orientation and complete quarter-turn images before recognition; packaged native binaries retain their own third-party notices. This explicitly pins the image library already present through Next.js.
- shadcn/ui, Next.js, React, Drizzle, Better Auth, and Lucide retain their package licenses. The lockfile records the complete dependency set.
- parse5: MIT. Bookmark metadata uses its inert HTML parser, pinned from the existing dependency tree.

See the LICENSE files in installed packages and upstream distributions for full terms. Review dependency advisories when updating; do not use `npm audit fix --force` to silently downgrade the editor or framework.

- `@napi-rs/canvas`: MIT. Local PDF thumbnail rendering uses its packaged native Canvas implementation; retain upstream notices. FFmpeg is provided by the runtime distribution for video thumbnails; its license depends on that distribution’s build and bundled codecs.

- Official Model Context Protocol TypeScript server/client SDKs and `jose`: MIT. Better Auth MCP, client-metadata and API-key plugins retain Better Auth’s package licenses. `y-prosemirror` is MIT licensed and supplies the headless Markdown parser’s ProseMirror peer integration.

- `@dnd-kit/react` and `@dnd-kit/dom`: MIT. Task boards use their pointer and keyboard drag controls; the pinned packages retain their upstream notices.

- Snowflake Arctic Embed XS q8 weights and tokenizer configuration: Apache-2.0, pinned to revision `d8c86521100d3556476a063fc2342036d45c106f`. The Docker model pack includes LICENSE, NOTICE and checksums. ONNX Runtime Node: MIT, CPU binaries only. `@huggingface/tokenizers`: Apache-2.0. Models load locally; no inference-time downloads or external inference services.
