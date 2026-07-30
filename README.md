# web2gem account pool

[中文](README.zh.md)

A single-machine Docker gateway for Gemini Web with persistent multi-account pooling. It exposes OpenAI-compatible and Google Gemini-compatible APIs, stores account state in local SQLite, and includes an admin console.

## Deployment model

- One host, one application container.
- One local SQLite database at `/data/web2gem.sqlite`.
- One named Compose volume, `web2gem-data`, for persistence.
- Multiple Gemini accounts managed from `/admin`.
- Standard Node.js HTTP and `fetch`; no external database service is required.

## Quick start

Requirements: Docker Desktop or Docker Engine with Compose.

```powershell
Copy-Item .env.docker.example .env
```

On Linux or macOS:

```bash
cp .env.docker.example .env
```

Edit `.env` and set a strong `ADMIN_KEY`. Set `API_KEYS` as well if API clients must authenticate. Then build and start:

```bash
docker compose up -d --build
```

Verify the service:

```bash
curl http://127.0.0.1:52389/
```

Open `http://127.0.0.1:52389/admin`, enter `ADMIN_KEY`, and import the Gemini accounts you own. Account cookies and keys are secrets; never commit `.env` or exported account data.

Useful commands:

```bash
docker compose ps
docker compose logs -f web2gem
docker compose restart web2gem
docker compose down
```

`docker compose down` keeps the named data volume. Do not run `docker compose down -v` unless you intentionally want to delete the account database.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `52389` | Host and container HTTP port. |
| `WEB2GEM_IMAGE` | `web2gem-account-pool:local` | Local image name used by Compose. |
| `SQLITE_PATH` | `/data/web2gem.sqlite` | SQLite file inside the persistent volume. |
| `SQLITE_BUSY_TIMEOUT_MS` | `5000` | SQLite lock wait timeout. |
| `ADMIN_KEY` | empty | Required to use account-management endpoints and `/admin`. Use one strong value. |
| `API_KEYS` | empty | Optional comma-separated client API keys. Empty disables client authentication. |
| `DEFAULT_MODEL` | `gemini-3.5-flash` | Default model when a request omits one. |
| `GEMINI_BL` | empty | Optional upstream build label override. |
| `GEMINI_ORIGIN` | empty | Optional compatible upstream forwarding origin. |
| `RETRY_ATTEMPTS` | built-in | General retry count override. |
| `GEMINI_ACCOUNT_MAX_ATTEMPTS` | built-in | Maximum distinct account attempts per request. |
| `GEMINI_ACCOUNT_REFRESH_INTERVAL_SEC` | built-in | Managed-cookie refresh interval. |
| `GEMINI_ACCOUNT_CAPABILITY_TTL_SEC` | built-in | Account capability cache lifetime. |
| `GEMINI_ACCOUNT_CAPABILITY_MODE` | built-in | Capability discovery mode. |
| `RETRY_DELAY_SEC` | built-in | Delay between retries. |
| `REQUEST_TIMEOUT_SEC` | built-in | Upstream request timeout. |
| `REQUEST_BODY_MAX_BYTES` | `67108864` | Maximum incoming request body size. |
| `LOG_REQUESTS` | built-in | Enable request logging. |
| `CURRENT_INPUT_FILE_ENABLED` | built-in | Enable the current-input file path. |
| `CURRENT_INPUT_FILE_MIN_BYTES` | built-in | Minimum size for that file path. |
| `GENERIC_FILE_UPLOAD_MAX_BYTES` | built-in | Generic upload size limit. |

The complete template is [`.env.docker.example`](.env.docker.example). Compose passes every supported runtime variable explicitly.

## API surface

If `API_KEYS` is set, send `Authorization: Bearer <key>`.

OpenAI-compatible chat:

```bash
curl http://127.0.0.1:52389/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.5-flash","messages":[{"role":"user","content":"Hello"}]}'
```

Available routes include:

- `GET /` — health check.
- `GET /v1/models` — OpenAI-compatible models.
- `POST /v1/chat/completions` — OpenAI-compatible chat completions.
- `GET /v1beta/models` and `GET /v1/models/{model}` — Google-compatible model discovery.
- `POST /v1beta/models/{model}:generateContent` — Google-compatible generation.
- `GET /admin` — account management UI.
- `/admin/accounts` and `/admin/model-routing` — authenticated admin APIs.

An empty account pool can still answer health and public discovery requests, but account-required generation returns `503 no_available_gemini_account` until an account is imported.

## Persistence, backup, and updates

The server creates the SQLite file, enables foreign keys and WAL mode, and applies `migrations/0001_gemini_accounts.sql` idempotently before listening.

To inspect the volume:

```bash
docker volume inspect web2gem_web2gem-data
```

For a consistent backup, stop the application briefly and copy the volume contents using your normal Docker-volume backup method:

```bash
docker compose stop web2gem
# back up the web2gem-data volume
docker compose start web2gem
```

Update the checkout and rebuild without deleting the volume:

```bash
git pull
docker compose up -d --build
```

## Troubleshooting

- Container exits before listening: run `docker compose logs web2gem` and verify `/data` is writable.
- Admin page rejects access: make sure `ADMIN_KEY` is non-empty and use the same value in the UI.
- Client receives `401`: use one of the comma-separated values in `API_KEYS`, or leave `API_KEYS` empty for private local use.
- Generation returns `no_available_gemini_account`: import at least one usable account at `/admin` and inspect its health state.
- Gemini returns empty output: confirm `GEMINI_BL` is current; configure a compatible `GEMINI_ORIGIN` only when you intentionally use a forwarding endpoint.
- Port conflict: change `PORT` in `.env`, then recreate with `docker compose up -d`.

## Development and quality checks

Node.js 22+ and pnpm are required for development outside Docker.

```bash
pnpm install --frozen-lockfile
pnpm check:static
pnpm typecheck
pnpm typecheck:tests
pnpm check:arch
pnpm unit
pnpm coverage:ci
pnpm smoke
pnpm check:bench
pnpm check:size
pnpm docker:smoke
```

Coverage CI writes `lcov` and `JSON summary` artifacts. The production bundle is `dist/app.js`, and the Docker entry point is `server/docker-server.mjs`.

## License

See [LICENSE](LICENSE).
