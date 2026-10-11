# Testing and verification

Use Node.js 24 and install dependencies with `npm ci`. Run:

```sh
npm run typecheck
npm run lint
npm run format:check
npm run verify:branding
npm run verify:api
npm test
npm run build
```

The automated suite uses disposable data and covers authentication, single-owner setup, recovery, passkeys, TOTP, persistence, search, pagination, revisions, files, encryption, backups, Calendar, Kanban, MCP and access restrictions. CI also builds Docker and runs `scripts/smoke-container.mjs` to check health, encrypted/plaintext onboarding, authorization, the single-owner invariant and persistence after container recreation. Release builds run that same check on native AMD64 and ARM64 containers before promoting the image. `release-policy.test.ts` rejects missing/failed CI, wrong commits, invalid date tags, incomplete architecture manifests and premature retirement of the active release. See [release policy](../CONTRIBUTING.md#releases). A passing suite is not proof of every physical browser/device behavior or an exhaustive security audit.

## Browser checks

Keep Playwright credentials and screenshots outside Git. Browser regression harnesses live in `scripts/browser-*.mjs`; inspect their required arguments before running them. Check desktop and narrow mobile, light/dark mode, focus and touch targets, overflow, loading/error states, unsaved edits and refresh/deep links. Test passkeys, push delivery with the app closed, and keyboard positioning on physical devices when those paths change.

`browser-accessibility.mjs` audits all workspace sections, Search/Settings, representative dialogs/selectors, authentication and public pages on a disposable server at port 3015. It requires `NIVRA_BROWSER_SESSION` for a saved synthetic owner session and uses axe-core for WCAG A/AA rules, alongside overflow, labels, input sizing and touch-target measurements. `NIVRA_AUDIT_ENGINE` selects Chromium, Firefox or WebKit; `NIVRA_AUDIT_WIDTHS` and `NIVRA_AUDIT_THEMES` select the viewport/theme matrix; `NIVRA_AUDIT_HEIGHT` checks short windows; `NIVRA_AUDIT_TOUCH=1` covers larger touch screens, and `NIVRA_AUDIT_SECTIONS` limits a height-specific run. `NIVRA_AUDIT_MODE=verify` fails on confirmed automated accessibility/layout findings; `layout` checks section overflow, calendar-year control overlap and the year grid’s target-size rule. `browser-accessibility-interactions.mjs` verifies keyboard navigation, focus restoration, mobile touch targets, calendar grid navigation, reduced-motion use and stable Settings height. `browser-accessibility-onboarding.mjs` requires an empty disposable server on port 3016 and checks guided onboarding before creating its synthetic owner. Keep synthetic fixture manifests and reports in the ignored review directory. The form-owner harness also exercises keyboard, mouse and native Chromium touch reordering. Review axe's incomplete results manually; automated checks do not certify screen-reader or physical-device behavior.

`browser-focus-stability.mjs` uses disposable port 3015, `NIVRA_BROWSER_SESSION` and `NIVRA_AUDIT_FIXTURES` from the accessibility harness. It verifies creation focus, repeated/composition Enter, pending and failed saves, Quick multiline submission, live board SSE, card/input identity during delayed refreshes across sections, and retained search selection. `NIVRA_AUDIT_ENGINE` and `NIVRA_AUDIT_WIDTHS` select browsers and widths; both themes are checked. `NIVRA_AUDIT_MODE=quick` limits a confirmation run to creation focus and Quick note/task/link submission. Its synthetic owner and port guards prevent use on a live installation.

`browser-tag-actions.mjs` uses the same disposable port and synthetic session. A fresh disposable instance creates its own test account and saves the session with restricted permissions. It checks sidebar tag creation/editing, cancellation and confirmed deletion, focus handoff from mobile navigation, selected-tag URL cleanup and preservation of tagged tasks. `NIVRA_AUDIT_ENGINE` and `NIVRA_AUDIT_WIDTHS` select browsers and viewports; both themes are checked. CI runs Chromium, Firefox and WebKit against the production build at phone, tablet and desktop widths.

## Performance checks

Use isolated, disposable data for benchmarks. `scripts/benchmark-library.ts`, `benchmark-boards.ts`, `benchmark-media.ts` and `benchmark-encryption.ts` provide synthetic workloads; read their argument and directory guards first. `scripts/monitor-scale.mjs` samples an explicitly supplied service cgroup. Record dataset composition, encryption mode, runtime mode, concurrent workloads and whether timings measure SQL or HTTP. Separate cold and warm results, idle CPU, service memory and worker/browser memory. SSE connection duration is not page latency. WAL permits concurrent readers with one writer, not multiple simultaneous writers.

`scripts/benchmark-queries.ts` creates an encrypted synthetic library covering notes, journals, tasks, bookmarks, artifacts, events, Forms, responses, tags, Favorites and Trash. Run `npx tsx scripts/benchmark-queries.ts /absolute/new-private-directory 100000` (1,000–300,000 content records); it rejects an existing output directory, removes its generated database/key after completion, and leaves a private JSON report. This measures synchronous service calls, SQL plans/call counts, first/warm timings, CPU time, database size and peak process RSS; it does not measure browser or network latency. Calendar runs deliberately invalidate the range cache. Compare identical dataset, storage and resource limits, and include cold typo/missing searches and broad/deep pages. `query-optimization.test.ts` verifies upgrade preservation, literal-search equivalence, broad search ordering, batched contexts and correctness after `ANALYZE`; `fuzzy-index.test.ts` compares typo candidates with exhaustive results.

`scripts/scale-fixtures.ts` can seed or extend an explicitly authorized installation. It requires `NIVRA_SCALE_ALLOW=dev-instance-fixtures`, an absolute private output directory and one owner; inspect its command and count options before use. Never run it against a real installation without authorization. This guard is for test tooling, not a supported application setting. Keep fixture manifests, account sessions, keys, raw measurements and audit reports private. Dated execution reports are not maintained as product documentation.

## S3 integration

Nivra uses S3-compatible object storage for files and optional backups; SQLite remains local. See [storage configuration](../README.md#configuration). Verify changes using a disposable MinIO/RustFS-compatible service, private bucket and isolated Nivra data:

1. Upload and fetch a file through authenticated routes; compare the original bytes and reject anonymous private access.
2. Check public snapshots use their copied attachments while the originals remain private.
3. Verify encrypted object envelopes and file/backup prefix separation.
4. Create and verify a full backup, then restore it into a new empty directory using the original key.
5. Recreate the test storage service with its original volume and confirm files and backups remain readable.

Dispose only of the test resources. Never restore over a running installation or substitute an existing storage service for a disposable test target.

Forms checks cover timezone-aware deadlines, daylight-saving day boundaries, expired submissions/uploads, derived Calendar entries and daily aggregates, public device themes, strict schemas, immutable versions, isolated anonymous submission/upload routes, safe retries, signature/quota/expiry handling, keyset paging while review/Trash changes, exact decimal aggregates, complete exports, private downloads, scope restrictions, tags/Favorites/search/Trash and encrypted backup restoration. `browser-forms.mjs` uses disposable port 3015 for public validation/uploads/retry behavior across Chromium, Firefox and WebKit, desktop/mobile and light/dark themes. `browser-form-owner.mjs` uses that server's saved synthetic owner session to exercise drag/keyboard/menu reordering, the closing-date picker, builder, preview, publication, summaries/review, deep links, Favorites, revision conflicts, two-tab SSE and completion refreshes during search changes. `browser-form-components.mjs` edits all 19 builder types and verifies settings, 44px controls, label gaps, saved data and reload persistence at phone, tablet and desktop widths in both themes. The owner/public matrices include small-phone and landscape viewports. All three scripts require disposable port 3015; owner/component checks use `NIVRA_BROWSER_SESSION` pointing to the saved synthetic session. Keep optional review captures and cookie files outside Git. Browser automation does not certify physical-device keyboard or assistive-technology behavior.
