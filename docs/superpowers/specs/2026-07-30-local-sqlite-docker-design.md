# Local SQLite Docker Storage Design

## Goal

Make the `gemini-account-pool` edition fully self-hostable on one machine in one Docker container, with multiple Gemini accounts persisted locally and no Cloudflare dependency.

The normal deployment flow remains:

```powershell
Copy-Item .env.docker.example .env
docker compose up -d --build
```

Recreating or updating the container must preserve account-pool data in a Docker volume.

## Scope

This design covers the Docker runtime only. It adds a local SQLite storage driver while retaining the existing Cloudflare D1 HTTP driver as an explicitly selected compatibility option. The Cloudflare Workers deployment and its native `GEMINI_DB` binding remain unchanged.

The deployment target is a single host running a single web2gem container. Multi-container replicas sharing one SQLite file are outside scope.

## Selected Approach

Use Node's built-in SQLite support in the Docker runtime and adapt it to the existing `D1DatabaseLike` contract.

This is preferred over PostgreSQL because the requested topology does not need a second service or distributed concurrency. It is preferred over running Miniflare as a D1 emulator because direct SQLite has fewer runtime layers and a clearer production persistence model.

## Runtime Architecture

The container contains four relevant layers:

1. The existing HTTP server and Worker bundle.
2. The existing Gemini account-pool services and D1-shaped storage contract.
3. A new local SQLite adapter implementing `prepare`, `bind`, `first`, `all`, `run`, and `batch`.
4. A SQLite database at `/data/web2gem.sqlite`, backed by a named Docker volume.

The application continues to receive the storage object through `env.GEMINI_DB`, so account selection, cooldowns, refresh locks, capability discovery, routing priorities, and the admin API do not require separate storage implementations.

## Configuration

Docker uses these settings by default:

```dotenv
STORAGE_DRIVER=sqlite
SQLITE_PATH=/data/web2gem.sqlite
```

`STORAGE_DRIVER` accepts:

- `sqlite`: open the local database, initialize its schema, and inject the SQLite adapter as `GEMINI_DB`.
- `d1-http`: retain the previous Docker behavior and require `D1_ACCOUNT_ID`, `D1_DATABASE_ID`, and `D1_API_TOKEN`.

Unknown storage-driver values are fatal configuration errors. In `sqlite` mode, D1 HTTP variables are not required and are not read. In `d1-http` mode, partial D1 HTTP configuration remains a fatal startup error.

`.env.docker.example` documents SQLite as the default. `compose.yaml` passes the storage variables, mounts a named volume at `/data`, and provides a health check. The Docker image includes the migration SQL needed for local initialization.

## Startup and Shutdown

In SQLite mode, startup performs these steps before listening on the HTTP port:

1. Validate and resolve `SQLITE_PATH`.
2. Create its parent directory when necessary.
3. Open the database without replacing an existing file.
4. Enable foreign keys, WAL journal mode, and a busy timeout.
5. Execute the current idempotent account-pool migration.
6. Inject the adapter as `GEMINI_DB`.
7. Validate the existing runtime configuration and start the HTTP server.

If opening the database or applying the migration fails, startup exits non-zero. It does not fall back to anonymous-only operation and does not delete, rename, or recreate the database.

On `SIGTERM` or `SIGINT`, the runtime stops accepting HTTP connections, waits for the server to close, then closes the SQLite connection. Repeated shutdown signals must not run cleanup twice.

## SQLite Adapter Contract

Prepared statements are immutable from the caller's perspective: `bind()` returns a statement object carrying the bound values. The adapter normalizes SQLite rows and metadata into the existing D1-shaped result:

```text
{ results, success, meta }
```

`first(columnName)` returns the first row, the named column value, or `null`. `all()` returns all rows. `run()` returns success and change metadata without exposing SQL values.

`batch()` accepts only statements created by the same adapter. It executes them in one transaction and returns results in input order. Any statement failure rolls back the complete batch. An empty batch returns an empty array.

The adapter records change counts in the metadata fields already accepted by the account store. Errors may identify the operation class but must not include bound values, cookies, API keys, admin keys, or D1 tokens.

## Data Durability and Concurrency

SQLite runs with:

- foreign keys enabled;
- WAL journal mode;
- a bounded busy timeout;
- transactional batches.

These settings support concurrent requests inside one Node process while keeping writes serialized safely. The named Docker volume stores the database and its SQLite companion files, so container replacement does not remove account data.

The project does not claim support for multiple containers writing to the same SQLite volume. Scaling beyond one container requires a separate design using a network database.

## Error Handling

- An invalid or unwritable database path is a fatal startup error.
- A corrupt database is reported and preserved for recovery; the runtime never silently creates a replacement at the same path.
- Migration failure is fatal and preserves the database.
- Lock contention waits up to the configured busy timeout, then returns a sanitized storage error through the existing request error boundary.
- Batch failures roll back the transaction.
- Logs never include SQL bind values or stored Gemini credentials.
- Health checks fail until storage initialization and HTTP startup complete.

## Docker Deployment

`compose.yaml` builds the checked-out fork locally by default for this self-hosted edition, uses `restart: unless-stopped`, maps the configured port, and mounts a named volume such as `web2gem-data` at `/data`.

The effective user workflow is:

```powershell
Copy-Item .env.docker.example .env
# Set ADMIN_KEY and, for shared API access, API_KEYS.
docker compose up -d --build
```

No Cloudflare account, D1 database, or Cloudflare API token is required in SQLite mode.

## Testing

Unit tests cover:

- storage-driver configuration and invalid combinations;
- `prepare`, immutable `bind`, `first`, `all`, and `run` behavior;
- result and change-metadata normalization;
- batch ordering, ownership validation, atomic commit, and rollback;
- schema initialization on a new database;
- idempotent initialization on an existing database;
- startup failures for invalid paths and migration errors;
- sanitized errors that do not expose bound secrets;
- graceful shutdown closing the database once.

Integration verification covers:

- production bundle construction;
- Docker image construction;
- container health and the root route;
- authenticated and unauthenticated API behavior;
- admin account import into SQLite;
- container removal and recreation with the same volume;
- persistence of the imported account after recreation;
- complete account-pool operation with all `D1_*` variables absent.

Existing static checks and unit tests must continue to pass. Cloudflare D1 HTTP adapter tests remain in place to protect the optional compatibility mode.

## Documentation Changes

The English and Chinese READMEs describe SQLite as the default Docker storage and present Cloudflare D1 HTTP storage only as an optional compatibility mode. `.env.docker.example` explains `STORAGE_DRIVER` and `SQLITE_PATH`. Docker commands continue to use the repository's Compose definition.

## Acceptance Criteria

The design is complete when all of the following are true:

1. A user with Docker but no Cloudflare account can build and start the service from the documented commands.
2. `/admin` can import and manage multiple accounts.
3. Account-backed generation paths can read the local account pool.
4. Recreating the container while preserving the named volume retains the accounts.
5. No `D1_*` value is required in SQLite mode.
6. The Cloudflare Worker deployment and explicitly selected Docker D1 HTTP mode remain functional.
7. Automated tests validate adapter semantics, initialization, rollback, persistence, and secret-safe errors.
