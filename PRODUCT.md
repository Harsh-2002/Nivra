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

A default Overview with a live local date/time, open tasks, recent notes and bookmarks, quick creation and inline task completion; rich-text notes, drawings, templates and attachments; daily, weekly and monthly Journal entries with period review; bookmarks with link previews and read/unread state; tasks with planned and due dates, time blocks, checklists and recurrence; Quick and PWA/browser capture; Kanban, calendar events and push reminders; tags, favorites, indexed and typo-tolerant search, checkpoints, stable internal links and backlinks; a shared Trash; Markdown import/export and lossless Nivra bundles. One owner with username/password and recovery code. Default-on server-side encryption at rest for SQLite, stored attachments and published-file copies, with a persisted onboarding opt-out before a new installation's database initialization. Authentication secrets and full-instance backups remain encrypted in either mode; an automatically generated key supports simple self-hosting, with external key configuration for separated backups. Online editing in v1, batch Markdown/file/folder import, revocable public read-only snapshots, and local/S3-compatible file storage configured through onboarding and System settings. Automatic encrypted full-instance backups to local or shared S3 storage, retention, manual backup/verification, and server CLI recovery into an empty local directory. Offline editing, collaboration, and shared workspaces are deferred.

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

The PWA share target, browser bookmarklet and Capture review page are implemented; a browser extension remains proposed. Bookmarks and tasks are separate sections backed by SQLite and included in lossless bundles and encrypted instance backups. Offline editing and collaboration remain deferred.

## Writing and journals

Notes and Journal remain separate workspaces. Note and journal templates can be created, edited, previewed and applied from their relevant sections. A template can be saved from an existing note, including its attachments. Applying a template creates a new item with copied attachment bindings; `{{date}}`, `{{time}}` and `{{title}}` are substituted at creation. Linked tasks become unchecked checklist snapshots in a template so a reusable routine does not inherit completion state. The owner can start blank at any time. An optional journal template may be the default, while choosing Blank bypasses it.

Journal periods are daily, weekly or monthly, with at most one entry per owner and normalized period. The review pane lists entries and factual task/event activity for the selected period, and On This Day lists earlier daily entries with the same month/day. Trashed entries are omitted; leap-day matches remain February 29. The activity and writing panes switch on mobile, while the review stays beside the editor on desktop. Review content is factual and does not generate a summary.

Regular notes can turn a checklist item or an exact selected text block into a linked task. The note displays the task’s current title and completion state and can complete it or open its details. Unlinking keeps a checklist snapshot; it does not delete the task. Linked task references do not apply to Journal entries.

## Task planning

Tasks can have an optional planned date, due date and timezone-aware time block with duration. Custom recurrence supports daily, weekly, monthly and yearly intervals, weekly day selection, an end date and a scheduled-date or completion anchor; the simpler existing daily, weekly and monthly rules remain supported. Completing a recurring task creates its next occurrence. A task can also hold up to 100 ordered checklist steps, each with revision-checked editing, completion and reordering. Steps participate in task search. Planning changes the existing task and Calendar view; it does not create a duplicate event.

## Bookmarks

Bookmarks open the original website in a new tab. Link previews, collections, tags, favorites and read/unread state help organize saved links. Preview refresh preserves the bookmark when metadata is unavailable. Nivra does not capture or render bookmarked articles.

## Capture

Quick creates notes, tasks and links from the workspace. The dedicated Capture page also accepts links, selected passages and shared text from the installed PWA share menu or a browser bookmarklet. Incoming content is reviewed and can be edited before the owner explicitly saves it. A shared passage saved with a link becomes a note associated with the bookmark; a repeated bookmark URL reuses the existing item rather than making a duplicate. The capture page requires the owner session and does not publish shared content.

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

Smart tagging and search are opt-in and disabled by default. One bundled Arctic XS q8 text model runs offline in a persistent server child, with a 512 MiB worker RSS target. Existing-tag matching uses names, optional matching words and owner-confirmed examples. Each item shows at most one suggestion and can receive none. Review suggestions is the default; Automatic tagging requires a separate owner choice. Semantic similarity alone does not authorize label-only automatic assignment.

Meaning-based search is an explicit option alongside unchanged keyword search. Protected hybrid retrieval returns related canonical items, including private form responses and supported attachment/OCR text, within existing permissions. It returns keyword results when inference, capacity, memory or query deadlines prevent complete semantic retrieval. Coverage remains visible; no older content is silently excluded. Private derived state stays inside SQLite's configured encryption boundary, outside publications, ordinary exports and content DTOs.

Visual image tagging and visual embeddings remain deferred. Images retain existing OCR, filenames, metadata and manual tags. Release requires integrated regression, privacy, native container and resource checks plus human review of representative owner vocabularies.

The adaptive-tagging branch prioritizes existing tags. Recurring unmatched topics can produce bounded, extracted new-tag ideas from at least three distinct items; no generative model creates names. Review mode requires owner approval to create a tag. Automatic mode may create a reusable tag within stricter evidence and daily limits. New tags join the existing vocabulary. Unapproved automatic assignments never become learning examples. Owner corrections suppress replacement guesses on unchanged content; edits invalidate stale unapproved assignments while preserving manual and approved tags. This branch remains subject to integration and owner-vocabulary quality validation before deployment.
