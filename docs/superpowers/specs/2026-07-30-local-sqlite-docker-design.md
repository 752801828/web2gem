# Docker-Only SQLite Account Pool Design

## Goal

Convert the `gemini-account-pool` fork into a Docker-only, single-host service with local SQLite persistence and no Cloudflare code, service, account, token, deployment path, or build dependency.

The supported deployment flow is:

```powershell
Copy-Item .env.docker.example .env
docker compose up -d --build
```

The service must manage multiple Gemini accounts and retain them when its container is replaced.

## Scope

The target is one machine running one web2gem container. The container owns one SQLite connection and stores its database in a named Docker volume. Multiple containers sharing a database are outside scope.

Cloudflare compatibility is intentionally removed rather than retained behind a flag. This includes Workers deployment, Wrangler, D1 HTTP storage, Cloudflare runtime types, `cloudflare:sockets`, Deploy Button content, and upstream synchronization that would restore those surfaces.

## Selected Architecture

The production process has four layers:

1. A Node HTTP adapter that converts incoming Node requests to standard Fetch API `Request` objects and streams standard `Response` objects back to clients.
2. A bundled Node application artifact at `dist/app.js` containing the existing routing, authentication, admin UI, account-pool, and Gemini client logic.
3. A SQLite adapter implementing the application's generic SQL storage contract.
4. `/data/web2gem.sqlite`, persisted by the named `web2gem-data` Docker volume.

The application continues using standard `Request`, `Response`, `Headers`, streams, and `fetch`, all provided by Node 26. It does not use a Worker handler type or any Cloudflare module.

## Runtime Types and Naming

Generated `WorkerBindings` and global Cloudflare types are replaced by repository-owned types:

- `AppEnv` describes supported configuration values and the SQL account database.
- `ApplicationExecutionContext` exposes only the `waitUntil` behavior used by background account maintenance.
- `SqlDatabaseLike`, `SqlPreparedStatementLike`, and `SqlResult` replace D1-named storage types.

Account-store files and public diagnostics use SQL or SQLite terminology. No runtime type depends on `@cloudflare/workers-types`.

## Storage

Docker always uses SQLite. There is no `STORAGE_DRIVER` switch and no `D1_*` configuration.

The supported storage settings are:

```dotenv
SQLITE_PATH=/data/web2gem.sqlite
SQLITE_BUSY_TIMEOUT_MS=5000
```

At startup the server:

1. validates and resolves `SQLITE_PATH`;
2. creates its parent directory when needed;
3. opens the existing database or creates a new file without replacing data;
4. enables foreign keys, WAL mode, and the configured busy timeout;
5. applies the idempotent account-pool schema;
6. injects the SQL adapter into `AppEnv`;
7. validates runtime configuration and starts listening.

Opening or migrating the database is fail-closed. A corrupt or incompatible database is preserved and the process exits non-zero.

## SQL Adapter Contract

The adapter provides immutable prepared bindings and these asynchronous application-facing methods:

- `prepare(sql)`;
- `bind(...values)`;
- `first(columnName?)`;
- `all()`;
- `run()`;
- `batch(statements)`.

It normalizes Node SQLite results to `{ results, success, meta }`. Mutation metadata includes compatible change counts. `RETURNING` rows remain available to account import logic.

`batch()` accepts statements from the same database only, executes them in input order inside one transaction, and rolls back the complete batch on any failure. Error messages identify the operation class but never contain SQL bind values, cookies, API keys, or admin keys.

## Network Transport

Gemini upstream traffic always uses Node's standard `fetch`. The `cloudflare:sockets` dynamic import, raw socket selection, socket configuration, and socket-only benchmarks/tests are removed.

Removing the socket path does not change the current Docker behavior because Docker already configured it off. Retry, timeout, streaming, upload, and response parsing behavior continue through the standard HTTP transport.

## Build and Package Changes

The build emits `dist/app.js` for Node 26 instead of `dist/worker.js` for a Worker runtime. The Docker image contains:

- `dist/app.js`;
- the Node HTTP server adapter;
- the SQLite adapter;
- the account-pool migration.

The following Cloudflare-specific surfaces are removed:

- `wrangler.jsonc`;
- `worker-configuration.d.ts`;
- `.dev.vars.example` and the Worker-only secret template;
- Wrangler deploy, D1 migration, and Worker-type scripts;
- `wrangler` and `@cloudflare/workers-types` dependencies;
- D1 HTTP server adapter and configuration;
- Cloudflare Deploy Button documentation and assets;
- Cloudflare socket transport selection;
- the upstream sync workflow that would overwrite the Docker-only fork.

The generic GitHub quality workflow remains but is updated to test the Docker-only project without origin-specific Cloudflare gates.

## Docker Deployment

`compose.yaml`:

- builds the checked-out source locally;
- uses `restart: unless-stopped`;
- maps `${PORT:-52389}` on the host and container;
- mounts `web2gem-data` at `/data`;
- passes SQLite and application variables from `.env`;
- reports healthy only after the root health route responds successfully.

`.env.docker.example` contains no Cloudflare or D1 settings. Users set a strong `ADMIN_KEY` and optionally set `API_KEYS` for shared API access.

## Shutdown and Durability

On `SIGTERM` or `SIGINT`, the process stops accepting requests, closes the HTTP server, and closes SQLite once. WAL companion files remain in the same Docker volume.

Container replacement does not delete the named volume. Removing the volume is an explicit destructive operation and is not part of normal update instructions.

## Error Handling

- Invalid or unwritable SQLite paths are fatal startup errors.
- Migration failures are fatal and preserve the database.
- Corrupt databases are never silently replaced.
- Lock contention waits for the configured timeout, then returns a sanitized storage error.
- Transaction failures roll back all batch statements.
- Runtime logs never include stored Gemini credentials or SQL parameters.
- The health check fails until storage initialization and HTTP startup complete.

## Documentation

The English and Chinese READMEs describe only Docker deployment, local SQLite persistence, account import, API authentication, update commands, backups, and troubleshooting. They contain no Worker, Wrangler, D1, Deploy Button, or Cloudflare setup instructions.

Internal project-structure and development sections describe the Node application artifact and Docker test workflow.

## Testing

Unit tests cover:

- SQLite path and timeout validation;
- `prepare`, immutable `bind`, `first`, `all`, `run`, and `RETURNING` behavior;
- result and mutation metadata normalization;
- batch ordering, ownership validation, commit, and rollback;
- initial and repeated schema application;
- secret-safe failures;
- runtime configuration using repository-owned types;
- graceful shutdown closing storage once;
- standard-fetch-only Gemini transport behavior.

Integration verification covers:

- static checks and the complete unit suite;
- Node application bundling;
- Docker image construction;
- Compose health;
- authenticated and unauthenticated API behavior;
- admin import of multiple accounts;
- container replacement using the same volume;
- account persistence after replacement;
- absence of Cloudflare/D1 configuration and runtime dependencies.

## Acceptance Criteria

1. A user with Docker and no Cloudflare account can build and start the documented service.
2. The repository contains no Cloudflare deployment configuration, D1 HTTP adapter, Cloudflare runtime dependency, or Cloudflare documentation.
3. `/admin` imports and manages multiple accounts using SQLite.
4. Account-backed API paths use the local account pool.
5. Recreating the container with the same named volume retains accounts.
6. Startup and query failures are fail-closed and secret-safe.
7. The complete test suite, Node build, Docker build, health check, API checks, and persistence regression pass.
