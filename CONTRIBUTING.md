# Contributing

Read [AGENTS.md](AGENTS.md), [product scope](PRODUCT.md), and [design guidance](DESIGN.md). During initial development, the owner may push verified changes directly to `main`. External contributors should open a pull request describing the problem, resulting behavior, and relevant validation.

Use Node.js 24 and `npm ci`. Run `npm run ai:assets` once to prepare the pinned model pack before the full local test suite; inference itself never downloads assets. Run the checks in the [testing guide](docs/testing.md). Check desktop and mobile when changing the interface, and Docker persistence when changing storage or packaging. Tests create disposable data outside the repository; never point them at a real installation.

Keep code comments minimal and concise. Preserve the monochrome interface and single-owner model. Do not commit private notes, credentials, generated secrets, recovery codes, or data directories. Put detailed documentation in `docs/`; keep the README focused on getting started.

## Releases

CI verifies every `main` push and pull request. After CI passes on the current `main` commit, push an annotated UTC date tag to trigger [.github/workflows/release.yml](.github/workflows/release.yml):

```sh
git tag -a "v$(date -u +%Y.%m.%d)" -m "Nivra release"
git push origin "v$(date -u +%Y.%m.%d)"
```

The release action requires that exact commit's successful main CI run, builds on native AMD64/ARM64 runners, verifies encrypted and plaintext container onboarding and persistence, and publishes `ghcr.io/harsh-2002/nivra:latest`. The GitHub release includes the commit and immutable image digest. Only `latest` is tagged in the registry. There is one published GitHub release: the previous release and its tag are retired only after the replacement is public and verified. A failed build or verification retains the previous release. Published date tags are immutable; release a different commit on a new UTC date. Use **Actions → Release → Run workflow** with the same tag to retry a failed release; there is no CI bypass.

GitHub initially creates GHCR packages as private. On the first publication, the maintainer must change the package's visibility to **Public** in its GitHub package settings. The release action checks anonymous access before publishing the GitHub release; retry its failed publication job after changing visibility. No registry login is required for users.

To verify a source build locally, use disposable container data:

```sh
docker build -t nivra:test .
node scripts/smoke-container.mjs nivra:test
```

The smoke check uses temporary named volumes and random loopback ports, recreates the container and removes only its test resources. It does not use the live installation.

## Development upgrades

Database migrations run automatically at startup; ordinary updates do not require a manual migration command. Preserve the existing data volume and encryption key, create and verify a backup in **Settings → System**, update the checkout and rebuild. Never delete the data volume to resolve startup issues.

Only older development installations configured through retired storage/backup environment variables need the one-time configuration import: stop Nivra, run `npx tsx scripts/migrate-configuration.ts` with the original data location and key, then restart and verify the imported settings before removing retired variables. This is not part of new installation setup or routine updates. See [recovery procedures](docs/architecture.md#backup-and-recovery-commands).

## HTTP API

The versioned content API is at `/api/v1`; readiness is at `/health`. The [OpenAPI contract](docs/openapi.json) is maintained in this repository and is not served by the instance. Browser sessions and bearer API keys use the same content services as MCP. Create a Read or Read & write key in **Settings → MCP**; OAuth stays at `/mcp`.

```sh
curl -H 'Authorization: Bearer YOUR_API_KEY' 'http://localhost:3000/api/v1/notes?limit=20'
curl -H 'Authorization: Bearer YOUR_API_KEY' 'http://localhost:3000/api/v1/counts'
curl -H 'Authorization: Bearer YOUR_API_KEY' 'http://localhost:3000/api/v1/search?q=meeting&limit=20'
curl -X POST -H 'Authorization: Bearer YOUR_API_KEY' -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: create-note-001' -d '{"title":"Meeting"}' 'http://localhost:3000/api/v1/notes'
```

Lists return `items` and `next`; pass the cursor as `after` with the same filters. Changes to items with revisions require the current `revision`. Content deletion moves items to Trash; restoring or permanently deleting requires the owner session. File and publication responses include canonical URLs. Queued processing returns `jobs` with IDs, status and lookup URLs. The web app listens to `/api/v1/completions` for session-authenticated SSE invalidations, then reloads affected content. JSON creation retries can use `Idempotency-Key`; multipart uploads and bundle transfers do not support that header. The retired `/api/nivra` routes have no aliases.
