# Nivra

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Next.js, TypeScript, shadcn/ui, Tailwind CSS v4, BlockNote, SQLite, Drizzle, FTS5, Better Auth, Excalidraw, Docker Compose.

## Users

One owner per self-hosted installation, saving personal notes, tasks, and bookmarks on desktop, tablet, and mobile.

## Product Purpose

A quiet place to write, organize with tags, and preserve notes with rich text, Markdown portability, code, diagrams, drawings, and files.

## Operating Context

Docker starts the app. First-run onboarding, account creation, appearance, and preferences happen in the UI. Local persistent storage is the default. Mobile clients use an installable PWA with a theme-matched launch screen.

## Capabilities and Constraints

A default Overview with a live local date/time, open tasks, recent notes and bookmarks, quick creation and inline task completion; flat notes, dedicated bookmarks with URL metadata cards, cached thumbnails/icons, collections, favorites, indexed and typo-tolerant search, editing, deletion and preview retry; dedicated tasks with creation/editing/completion/reopening/search, optional dates and daily/weekly/monthly recurrence, quick capture of notes/tasks/links without changing sections, unified search across notes/tasks/bookmarks/artifacts with matching-passage highlights and relevant-block navigation, note checkpoints and restoration, stable internal links and backlinks, optional task/bookmark note associations, daily Journal notes that start blank, separate from Notes, tags, favorites, a shared Trash for deleted notes, journal entries, tasks, bookmarks and artifacts with restoration and confirmed permanent deletion, search, rich editing with per-note Standard/Wide width modes, Mermaid, Excalidraw, images, attachments, Markdown import/export, lossless Nivra bundles. One owner with username/password and recovery code. Default-on server-side encryption at rest for SQLite, stored attachments and published-file copies, with a persisted onboarding opt-out before a new installation's database initialization. Authentication secrets and full-instance backups remain encrypted in either mode; an automatically generated key supports simple self-hosting, with external key configuration for separated backups. Online notes in v1, batch Markdown/file/folder import, revocable public read-only snapshots that preserve their published revision and are served in a minimal reader, and local/S3-compatible file storage configured through onboarding and System settings. Automatic encrypted full-instance backups to local or shared S3 storage, retention, manual backup/verification, and server CLI recovery into an empty local directory. Offline editing, collaboration, and shared workspaces are deferred.

## Brand Commitments

Nivra: “Your thoughts, together.” A private, self-hosted workspace with search. Minimal black-and-white interface with neutral gray, light/dark/system themes, restrained typography and borders. Syntax and user drawings can contain color.

## Product Principles

- Writing comes first.
- Data belongs to the owner and stays portable.
- Setup and everyday configuration happen in the UI.
- Responsive behavior follows the task, not just viewport size.

## Accessibility & Inclusion

Keyboard-operable controls, visible focus, readable contrast, reduced-motion support, and touch-sized mobile actions.

## Artifacts

A private shelf for pasted text, screenshots, documents and media. Upload, paste or drop without mandatory folders or tags. Uploaded files use durable background jobs for local English OCR and bounded document extraction. Bookmark previews also load in the background; completion updates refresh the workspace through an authenticated SSE stream. Originals, thumbnails and extracted text use the installation's persisted encryption mode locally or in configured compatible storage. Unsupported formats remain downloadable and searchable by name; media is not transcribed.

Tags organize notes, journal entries, tasks, bookmarks and artifacts together. Selecting a tag shows a searchable, paginated collection of all tagged item types without creation actions. Tags survive Trash and restoration; permanently deleting an item removes its tag relationships. Recurring tasks carry their tags into the next occurrence. Note bundles also preserve task and bookmark tags, and full-instance backups include all tag relationships.

Favorites is a browsing-only card collection of starred notes, journal entries and bookmarks. Creating notes and journal entries belongs in their sections or Quick, rather than Favorites or tag collections.

## Next iteration

Browser-extension capture remains proposed. Bookmarks and tasks are separate implemented sections, backed by SQLite and included in lossless bundles and encrypted instance backups. Offline editing and collaboration remain deferred.

Passkeys are an optional login method alongside passwords and account recovery. They require PIN or biometric verification, support discoverable FIDO2 hardware and password-manager credentials, and have account settings for enrollment, rename and removal. Verified passkeys satisfy login when TOTP is enabled; password login still requires TOTP. Account recovery preserves registered passkeys, while revoking sessions and clearing TOTP.

The owner’s name and login identifier are fixed after onboarding. Login identifiers accept a username or email address without requiring email delivery. Appearance is available in the sidebar; Settings contains Account and Import & export. Artifact cards use background-generated private thumbnails or file-type icons, while extracted content remains in search and the detailed viewer.

First-run setup offers password or verified passkey authentication after choosing the fixed account identity. Password setup supports optional TOTP enrollment. The owner can add the other login method later; recovery remains available for either choice. Show passkey sign-in only when a passkey is registered. Prevent removal of the final usable login method.

After account, recovery and system configuration, onboarding offers optional tag creation followed by device-specific app installation guidance. Starter tag recommendations follow selected interests; only explicitly chosen tags are created, and custom names and matching words remain editable. Saved progress and tags survive reloads. Existing installations are marked complete rather than forced into setup again. Installation uses the browser prompt when available, with Android and iPhone/iPad instructions otherwise; it does not promise offline editing or automatic installation.

Calendar integrates planned and due task dates, daily journals, standalone events and schedules linked to saved content. Month, Week, Day and Year views retain date and view in the URL. Timed events use persistent IANA timezones; all-day dates remain stable. Recurrence supports editing one occurrence, following occurrences or the series. Reminders are listed in Calendar, with optional per-device Web Push over HTTPS. External calendar sync and drag-to-reschedule are deferred.

Device notifications are managed in Settings → Account, with an optional setup offer after first sign-in. Calendar keeps task and event scheduling controls without a notification bell or device settings panel.

## Task boards

Tasks supports optional named boards with To do, In progress and Done stages. Cards are existing tasks: dates, recurrence, tags, reminders and linked notes remain shared with List, Calendar and Overview. List stays newest-first; boards save manual positions and place new cards first. Archiving a board preserves its tasks and reminders. Boards and task membership are included in lossless bundles and full-instance backups. MCP exposes board listing, creation, updates and revision-checked task moves using the existing read/write permissions.

## Forms

Build multiple minimal forms in a dedicated Forms section. Edit questions inline in the builder, preview without collecting data, then publish a single-page public link at `/form/{token}`. Supported questions include text, email, phone, URL, numbers, exact decimal amounts with currency, rating, choices, dates/times, media files and unchecked consent, with heading/description/section blocks. After submission, each published version shows its plain-text confirmation message, defaulting to “Thank you. Your response has been submitted.” The 2,000-character message can insert answers from eligible non-file questions; choices render their labels, amounts include currency, booleans read Yes/No, and unanswered references render blank. An entirely blank result uses the default, and rendered output is capped at 20,000 characters. References substitute values without evaluating expressions. Password fields, payments, branching and multi-page wizards are outside this scope.

Publishing creates an immutable version. Draft edits stay private until Publish changes. An optional timezone-aware closing date accepts submissions through that day. Calendar shows closing dates in planning and daily submission counts in activity; opening a count shows that day’s submissions. Closing stops submissions; unpublishing revokes the link and republishing creates a new one. Submitted answers always retain their original question definitions. Owner views provide version-specific summaries, paged/searchable submissions, review state, private files and complete filtered CSV/JSON exports. Forms participate in tags, Favorites, indexed search, exact counts, Trash, full-instance recovery and SSE. Agents use the same services and read/write permissions and cannot restore or permanently delete forms/submissions.

Public uploads are form/version/question/session bound and reserve budget before reading bodies. Defaults are 3 files per question, 10 MB per file, 25 MB per submission and a configurable 250 MB per-form budget, including temporary and retained files. Temporary uploads expire after 24 hours. Supported media thumbnails are durable background work; files remain private to the owner and are not copied into Artifacts. Trash retains the form's results/files and revokes its public link; restoring a form makes it an unpublished draft.

## Local AI

Local AI is opt-in and disabled by default. One bundled Arctic XS q8 text model runs offline in a persistent server child, with a 512 MiB worker RSS target. English existing-tag suggestions require literal matching evidence and explicit owner approval; each item shows at most one suggestion. Optional tag matching words improve vocabulary matching. Suggestions can abstain, preserve manual assignments and dismissals, and never create tag names.

Meaning-based search is an explicit option alongside unchanged keyword search. Protected hybrid retrieval returns related canonical items, including private form responses and supported attachment/OCR text, within existing permissions. It returns keyword results when inference, capacity, memory or query deadlines prevent complete semantic retrieval. Coverage remains visible; no older content is silently excluded. Private derived state stays inside SQLite's configured encryption boundary, outside publications, ordinary exports and content DTOs.

Visual image tagging, visual embeddings and AI-generated new tags remain deferred. Images retain existing OCR, filenames, metadata and manual tags. Release requires integrated regression, privacy, native container and resource checks plus human review of representative owner vocabularies.

Requested follow-up, pending pipeline design and validation: use manual tag assignments and explicit suggestion decisions as owner-specific matching examples. Prioritize existing tags; propose a reusable new tag only for a recurring unmatched topic, with owner approval. Item-specific tags are a last resort rather than the default. Unapproved predictions must not become learning examples. This adaptive matching and new-tag proposal flow is not implemented in the current release scope.
