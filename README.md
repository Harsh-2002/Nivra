# Nivra

**Your thoughts, together.**

Nivra brings notes, journals, tasks, bookmarks and files into one quiet workspace. Plan with Calendar and Kanban, find things with full-text search, and connect your AI agents through MCP.

![Nivra Overview showing tasks, recent notes and saved links with demo content](docs/images/overview.webp)

- **Write and collect:** rich-text notes, drawings, attachments, bookmarks, tags, favourites and searchable artifacts with background OCR and thumbnails.
- **Plan:** daily journals, task dates, recurring tasks, Kanban boards, calendar events and push reminders.
- **Collect responses:** build and publish forms with text, choices, amounts and file uploads; review versioned responses, summaries and CSV/JSON exports.
- **Connect:** MCP at `/mcp`, with API keys or OAuth, read-only or read/write access, and exact counts alongside paginated tools.
- **Keep it yours:** one owner, passkey or password login, optional TOTP, encryption at rest and encrypted backups. Use the browser or install the PWA. Editing requires a connection.

<details>
<summary>See the Kanban board</summary>

![Nivra Kanban board showing To do, In progress and Done columns with demo content](docs/images/kanban.webp)

Screenshots use demo content.

</details>

## Get started with Docker

Requires Docker. Run the public image:

```sh
docker run -d --name nivra \
  --restart unless-stopped --init \
  -p 3000:3000 \
  -v nivra-data:/app/data \
  ghcr.io/harsh-2002/nivra:latest
```

Open **<http://localhost:3000>**, create your owner account and save the recovery code. No environment configuration is required for local use. The named volume persists your database, files and generated keys. The image supports Linux AMD64 and ARM64; Docker selects the matching architecture.

Prefer Compose? Download [compose.yaml](compose.yaml), then run `docker compose up -d`. It uses the same published image and persists data in a named volume.

For HTTPS behind a reverse proxy, add `-e NIVRA_PUBLIC_URL=https://notes.example.com` to `docker run`, or with Compose:

```sh
NIVRA_PUBLIC_URL=https://notes.example.com docker compose up -d
```

To use a different host port, change `-p` to `3001:3000` with Docker run, or use `NIVRA_PORT=3001` with Compose. Complete onboarding before exposing a fresh installation to other people: Nivra has one owner, and later signup is disabled. Save the recovery code. Passkeys and browser notifications require HTTPS or localhost; an email-shaped username does not enable email delivery.

Releases use calendar versions (`vYYYY.MM.DD`) and one active GitHub release. Docker uses only `latest`. With Compose, upgrade using `docker compose pull && docker compose up -d`; preserve the data volume and take a backup first. See [contribution guidance](CONTRIBUTING.md#releases) for release checks and source builds.

## Configuration

All three deployment settings are optional. Copy [.env.example](.env.example) to `.env` when needed.

| Variable                    | Default                          | Purpose                                       |
| --------------------------- | -------------------------------- | --------------------------------------------- |
| `NIVRA_PORT`                | `3000`                           | Host port published by Compose.               |
| `NIVRA_PUBLIC_URL`          | Address saved during setup       | Explicit public origin for a reverse proxy.   |
| `NIVRA_ENCRYPTION_KEY_FILE` | Generated key in the data volume | Mounted external key containing 32 raw bytes. |

Choose encryption during account setup; it defaults on and cannot change after initialization. **Settings → System** manages local/S3 storage, the upload limit (25 MiB by default), and backup scheduling/retention (daily, seven copies). S3 credentials are verified before activation and stored encrypted. Files and optional S3 backups share one connection and bucket, separated into `nivra/` and `nivra-backups/`. Changing storage transfers existing files in the background while preserving the source. Appearance is in the sidebar; account security, notifications and MCP have their own settings.

The container listens on `0.0.0.0:3000` and stores data at `/app/data`. To use a host directory, replace the named-volume entry in Compose with:

```yaml
volumes:
  - /srv/nivra:/app/data
```

The directory must be writable by container UID 1000. An external key file also needs a read-only container mount; set `NIVRA_ENCRYPTION_KEY_FILE` to its container path. Keep the exact existing volume or directory when upgrading. A reverse proxy must preserve the host; use HTTPS at the domain root, with WebSocket forwarding for development. Subpath hosting is unsupported.

## Development

Nivra is built with Next.js, TypeScript, shadcn/ui, Tailwind CSS, BlockNote, SQLite/FTS5, Drizzle and Better Auth.

Requires **Node.js 24** and npm. From a cloned checkout:

```sh
npm ci
npm run ai:assets # Optional for local AI development; Docker bundles the model
npm run dev
```

Open <http://localhost:3000>. Install FFmpeg on the host for video thumbnails; Docker includes it. For hot reload behind a domain, set `NIVRA_PUBLIC_URL` and forward WebSocket upgrades through the proxy.

```sh
npm run typecheck
npm run lint
npm run format:check
npm run verify:branding
npm run verify:api
npm test
npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance, API examples and development upgrade notes.

[Architecture and recovery](docs/architecture.md) · [MCP](docs/mcp.md) · [OpenAPI contract](docs/openapi.json) · [Testing](docs/testing.md)

MIT licensed. See [LICENSE](LICENSE) and [third-party notices](docs/third-party.md).
