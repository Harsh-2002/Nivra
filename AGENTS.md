# Nivra repository guidance

These instructions apply throughout this repository. Read any more specific `AGENTS.md` or `AGENTS.override.md` before changing files in its directory. Current user instructions take precedence over repository defaults.

## Orientation and sources of truth

Nivra is a single-owner, self-hosted notes, tasks, and bookmarks web app. Its stack is Next.js App Router, TypeScript, shadcn/ui, Tailwind CSS v4, BlockNote, SQLite, Drizzle, Better Auth, and Excalidraw.

- `package.json` and `package-lock.json`: executable commands and dependency versions.
- `src/app/`: routes, metadata, and application styles.
- `src/components/`: onboarding, workspace, editor, tasks, bookmarks, drawings, and settings; `ui/` contains shadcn components.
- `src/lib/server/`: authentication, schema, persistence, storage, and validation.
- `migrations/`: ordered SQL migrations, including FTS5 and the single-owner invariant.
- `tests/`: automated behavior and persistence checks.

### Documentation index

| Document                                             | Purpose and authority                                                                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| [README.md](README.md)                               | User quick start, Docker commands, supported environment variables, configuration and development setup.                             |
| [AGENTS.md](AGENTS.md)                               | Repository instructions for agents, verification requirements and this documentation index.                                          |
| [CONTRIBUTING.md](CONTRIBUTING.md)                   | Contributor workflow, calendar release policy, source builds, development upgrade exceptions, HTTP API examples and required checks. |
| [PRODUCT.md](PRODUCT.md)                             | Confirmed product scope, requirements and deferred features; verify implementation in code and tests.                                |
| [DESIGN.md](DESIGN.md)                               | Interface principles, tokens and responsive behavior.                                                                                |
| [docs/architecture.md](docs/architecture.md)         | Implementation architecture, persistence, security, storage, Forms/public uploads, recovery and shared services.                     |
| [docs/openapi.json](docs/openapi.json)               | Generated HTTP API contract from the shared operation registry and Zod schemas; never edit manually or serve publicly.               |
| [docs/mcp.md](docs/mcp.md)                           | MCP authentication, permissions, content/Form tools, file transfers and supported client integration.                                |
| [docs/testing.md](docs/testing.md)                   | Automated, browser, performance and storage verification procedures and limitations.                                                 |
| [docs/third-party.md](docs/third-party.md)           | Third-party licensing and bundled asset notices.                                                                                     |
| [tests/fixtures/README.md](tests/fixtures/README.md) | Synthetic fixture provenance, supported media coverage and shipping exclusions.                                                      |
| [LICENSE](LICENSE)                                   | License for Nivra's own source.                                                                                                      |

Keep this index current whenever documentation is added, moved, removed or changes purpose. Update the existing authoritative document rather than adding overlapping guides. Private, ignored `HANDOFF.md` is local continuation context, not published product documentation or proof of verification.

Inspect the relevant implementation and `git status --short` before making changes. Treat code and executed checks as evidence of current behavior; product plans are not proof that a feature works.

## Development commands

Use npm and Node.js 24. Keep `package-lock.json` committed.

```sh
npm ci
npm run dev
npm run typecheck
npm run lint
npm run format:check
npm run verify:branding
npm run verify:api
npm test
npm run build
```

`npm run dev` uses port 3000, or the next free port. To choose a port, use `npm run dev -- --port 3001`. Persistent development data defaults to `data/`; tests must use a separate temporary directory.

Docker delivery pulls the public AMD64/ARM64 image `ghcr.io/harsh-2002/nivra:latest`; use `docker compose up -d`, or the Docker run command in the README. Source builds and container verification are in CONTRIBUTING.md. Inspect configuration with `docker compose config`; check readiness with `/health`. Never remove an existing data volume to resolve a startup issue.

Release date tags use `vYYYY.MM.DD`. `.github/workflows/release.yml` requires successful CI on the exact current main commit and verifies native containers before promoting `latest`. Maintain one published release; retire its predecessor and tag only after the replacement is public. Do not bypass CI, overwrite a published date tag, publish extra image tags, or use a PR/fork as privileged release source. Pin GitHub Actions to the commit of their latest upstream release and keep version comments current.

## Engineering rules

- Keep changes scoped to the request. Preserve user edits and unrelated working-tree changes; do not reset, clean, or overwrite them.
- Use TypeScript with explicit boundaries and runtime validation for untrusted input. Keep server modules out of browser bundles.
- SQLite is the only supported database. Use the Drizzle schema for ordinary model access and parameterized SQL for FTS5 and SQLite-specific operations.
- Add an ordered migration for schema changes. Never rewrite a migration that has shipped; verify upgrade behavior on existing data.
- BlockNote JSON is canonical. Markdown export is intentionally lossy; Nivra bundles must preserve document and attachment data.
- Keep revision checks and unsaved edits intact. Never silently resolve a conflict by overwriting the server document.
- Owner creation must remain atomic and single-use. Public signup stays disabled. Authorize every private API and file request on the server.
- Onboarding, appearance, account security, and import/export belong in the UI. Upload limits, storage and backups belong in onboarding and Settings → System; secrets are generated and persisted by the server.
- Encryption at rest defaults on. A new installation can disable encryption during onboarding before database initialization; persist that choice and reject later mode changes. Keep the encryption-enabled SQLite driver, authenticated file encryption, object binding, and resumable legacy migration intact for encrypted installations. Never fall back to plaintext after an encryption or key failure. Authentication secrets and recovery backups remain encrypted in either mode. Keep keys out of Git, logs, and chat; use the configured secret manager for externally managed keys. Verify wrong-key, tamper, recovery, and migration behavior.
- Fetch bookmark metadata only from public HTTP(S) destinations. Pin validated DNS addresses, revalidate redirects and preview assets, enforce deadlines and response limits, and serve cached previews through authenticated storage using the installation's persisted encryption mode. Never proxy arbitrary private-network URLs.
- Full-instance backups must include all referenced local/S3 files and account/publication state. Commit manifests last, verify recovery before publishing an empty destination, and never overwrite a running installation or place a master key in remote backup objects.
- Keep uploads outside public assets behind the storage adapter. Enforce upload limits, generated storage keys, and safe serving of active file formats.
- Use shadcn/ui or Nivra’s styled components for visible controls, including editor selectors and confirmations. Do not use native select menus, browser alerts, prompts, or confirm dialogs. Native file pickers remain the system integration behind styled upload buttons. Apply Impeccable to UI changes and verify consistent desktop/mobile behavior.
- Keep dropdown actions and selector options on one line. Size menus to their labels within viewport bounds; preserve separate title/description layouts for rich search results. Fields use one visible focus border; do not stack an outer outline and focus ring.
- Typography changes must verify the actual editor H1–H6 hierarchy, nested content, prose, lists, and source blocks at desktop/mobile sizes and 100%/90% browser zoom. Do not infer heading sizes from the note title or prose alone.
- Keep the interface monochrome and responsive; user-selected tag and artifact colors are content metadata. Reuse existing shadcn controls, with labeled actions, visible focus, accessible dialogs, and explicit loading/error states.
- Bundle app fonts and drawing assets locally. PWA caching must exclude authenticated pages, notes, attachments, and API responses.
- Add dependencies only when necessary for the authorized work. Pin direct versions, update the lockfile, and review compatibility and relevant advisories.
- Keep comments rare: concise single lines that explain a non-obvious reason. Do not narrate the code or add large comment blocks.
- Offline editing/sync, collaboration, shared workspaces, and executable artifacts are deferred. Do not present them as implemented.

## Current documentation lookup

Use Context7 for library, framework, SDK, API, CLI, and cloud-service details, including setup, configuration, migration, and library-specific debugging. Do not use it for business logic, ordinary refactoring, or general programming concepts.

1. Resolve the official library name: `npx ctx7@latest library "Library name" "specific documentation question"`.
2. Choose a relevant, reputable result, preferring exact matches and version-specific IDs when available.
3. Fetch one concept at a time: `npx ctx7@latest docs /org/project "specific documentation question"`.

Resolve before fetching unless the user supplied a valid `/org/project` ID. Use at most three commands per question. Never include credentials or private data in queries. Use the permitted network-enabled execution context; do not repeatedly retry DNS failures in a restricted sandbox. On quota failure, report it and suggest `npx ctx7@latest login` or `CONTEXT7_API_KEY`; do not silently substitute remembered API details.

## Verification and review

Run checks appropriate to the change. Application delivery requires type checking, lint, meaningful tests, and a production build. Documentation-only changes require checking paths, commands, and consistency rather than rerunning unrelated application tests.

- Authentication: check onboarding races, blocked signup, login, recovery, optional TOTP enrollment/challenge, one-use backup codes, and session invalidation.
- Persistence/editor: check saves, delayed requests, conflicting revisions, reloads, and preservation of artifacts.
- Files/import/export: check authorization, limits, traversal, malformed archives, and restoration with attachments.
- UI: inspect desktop and mobile in the browser, including dark mode, keyboard focus, touch controls, and overflow. Use the browser MCP when available. See docs/testing.md for the disposable accessibility scan and keyboard/touch harnesses.
- Docker/storage: check startup, health, container recreation, migrations, persistent volume permissions, and backup/restore. Use disposable test data.

Review the diff before committing. Flag data loss, missing authorization, extra-owner creation, private-content caching, and lossy bundle restoration as defects. Do not weaken checks to obtain a passing result. Report failed or unavailable checks accurately.

## Documentation and completion

Keep the README short and put detailed references in `docs/`. Update the affected documentation when behavior, configuration, or commands change. Distinguish verified features from deferred work. Do not copy secrets, recovery codes, private notes, test credentials, data directories, or generated screenshots into Git or logs.

During initial development, commit and push verified changes directly to `main`; the owner has authorized this workflow and pull requests are optional. Preserve unrelated changes and check the remote before pushing. Revisit this workflow when the owner requests release or review gates. Create, publish, or merge only within the scope authorized in the conversation; this file grants no additional external-action permission.

Report the resulting behavior, relevant validation, and any remaining limitations. Link the changed files or pull request. Do not claim deployment, publication, or passing tests without evidence.

Reference: [Official AGENTS.md guidance](https://learn.chatgpt.com/docs/agent-configuration/agents-md).
