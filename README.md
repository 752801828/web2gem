# web2gem account pool

[中文](README.zh.md)

A single-machine Docker gateway for Gemini Web with persistent multi-account pooling. It stores account state in local SQLite and uses a separate browser-helper container to maintain Chromium profiles and submit verified cookie updates.

## Deployment model

- One host and two containers: `web2gem` and `browser-helper`.
- One local SQLite database at `/data/web2gem.sqlite`.
- `web2gem-data` persists SQLite; `browser-profiles` persists Chromium profiles.
- Only `web2gem` writes SQLite; the helper submits state and candidate cookies through an authenticated private API.
- Multiple Gemini accounts managed from `/admin`.
- No Cloudflare D1 or other external database service is required.

## Quick start

Requirements: Docker Desktop or Docker Engine with Compose. The following Windows CMD commands create secrets without printing their generated values:

```cmd
cd /d D:\web2gem-original
copy /Y .env.docker.example .env
powershell -NoProfile -Command "$r=[Security.Cryptography.RandomNumberGenerator]::Create();$b=New-Object byte[] 32;$r.GetBytes($b);New-Item -ItemType Directory -Force 'secrets'|Out-Null;[IO.File]::WriteAllText('secrets\web2gem_master_key',[Convert]::ToBase64String($b),[Text.UTF8Encoding]::new($false))"
powershell -NoProfile -Command "$p='.env';$s=[IO.File]::ReadAllText($p);$r=[Security.Cryptography.RandomNumberGenerator]::Create();function secret([int]$n){$b=New-Object byte[] $n;$r.GetBytes($b);-join($b|ForEach-Object{$_.ToString('x2')})};$s=[regex]::Replace($s,'(?m)^ADMIN_KEY=.*$','ADMIN_KEY='+(secret 32));$s=[regex]::Replace($s,'(?m)^BROWSER_HELPER_INTERNAL_TOKEN=.*$','BROWSER_HELPER_INTERNAL_TOKEN='+(secret 32));$s=[regex]::Replace($s,'(?m)^NOVNC_PASSWORD=.*$','NOVNC_PASSWORD='+(secret 16));[IO.File]::WriteAllText($p,$s,[Text.UTF8Encoding]::new($false))"
notepad .env
```

Enter only **rotated** values for `FEISHU_WEBHOOK_URL` and `FEISHU_SIGNING_SECRET`. Never reuse values exposed in chat, logs, or old configuration. Leave both empty to disable Feishu. Configure `API_KEYS` and the proxy if needed; never reuse the admin key as the helper token or VNC password.

Start and inspect both services:

```cmd
cd /d D:\web2gem-original
docker compose up -d --build
docker compose ps
```

Open `http://127.0.0.1:52389/admin`, enter `ADMIN_KEY`, and import Gemini accounts you own. Account cookies, login credentials, and keys are secrets; never commit `.env`, `secrets`, or account exports.

PowerShell can copy the template with:

```powershell
Copy-Item .env.docker.example .env
```

On Linux or macOS:

```bash
cp .env.docker.example .env
```

Verify the service:

```bash
curl http://127.0.0.1:52389/
```

Useful commands:

```bash
docker compose ps
docker compose logs -f web2gem
docker compose logs -f browser-helper
docker compose restart web2gem browser-helper
docker compose down
```

`docker compose down` keeps both named volumes. `docker compose down -v` deletes SQLite and every Chromium profile; never run it unless permanent deletion is intended.

## Browser-assisted renewal

- Configure the Google email, password, and authenticator Base32 seed for each account in the admin UI. The third field is the authenticator seed, not a current six-digit code.
- Checks run every six hours by default, with up to one hour of jitter. Automatic login is limited to two attempts per account per day.
- Automation handles only email, password, and TOTP on a best-effort basis. It does not bypass CAPTCHA, passkeys, phone approval, recovery, or Google security review; those states stop form submission and require a manual noVNC handoff.
- `Open browser` uses `http://127.0.0.1:6080/vnc.html`. Compose binds noVNC to host loopback only, and the standard noVNC clipboard panel supports copy and paste.
- Only one visible account session is allowed at a time. Switching accounts requires stopping the current session; idle visible sessions close after 30 minutes by default.
- When configured, Feishu sends deduplicated transition alerts for login-required, manual-action, and recovery states.
- `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` propagate to both containers. Compose appends internal service names and loopback addresses to `NO_PROXY`.
- Clearing browser credentials removes only encrypted email/password/TOTP data. It retains the account cookie and Chromium profile. Profile deletion is separate and retains the SQLite cookie and encrypted credentials.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `52389` | Host and container HTTP port. |
| `WEB2GEM_IMAGE` | `web2gem-account-pool:local` | Local image name used by Compose. |
| `BROWSER_HELPER_IMAGE` | `web2gem-browser-helper:local` | Browser-helper image name. |
| `SQLITE_PATH` | `/data/web2gem.sqlite` | SQLite file inside the persistent volume. |
| `SQLITE_BUSY_TIMEOUT_MS` | `5000` | SQLite lock wait timeout. |
| `WEB2GEM_MASTER_KEY_FILE` | `./secrets/web2gem_master_key` | File containing the 32-byte base64 key used to encrypt browser credentials. |
| `ADMIN_KEY` | empty | Required to use account-management endpoints and `/admin`. Use one strong value. |
| `API_KEYS` | empty | Optional comma-separated client API keys. Empty disables client authentication. |
| `BROWSER_HELPER_INTERNAL_TOKEN` | empty | Required independent token for container-to-container authentication. |
| `NOVNC_PORT` | `6080` | noVNC host port, published on loopback only. |
| `NOVNC_PASSWORD` | empty | Required VNC password; classic VNC uses only its first eight characters. |
| `NOVNC_PUBLIC_URL` | `http://127.0.0.1:6080/vnc.html` | Local noVNC URL opened by the admin UI. |
| `FEISHU_WEBHOOK_URL` / `FEISHU_SIGNING_SECRET` | empty | Feishu is enabled only when both are configured. |
| `BROWSER_CHECK_INTERVAL_SEC` | `21600` | Periodic browser check interval. |
| `BROWSER_CHECK_JITTER_SEC` | `3600` | Maximum scheduling jitter. |
| `BROWSER_AUTLOGIN_MAX_ATTEMPTS_PER_DAY` | `2` | Per-account daily automatic-login limit; maximum is two. |
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

The server creates the SQLite file, enables foreign keys and WAL mode, and applies numbered migrations idempotently before listening.

To inspect the volume:

```bash
docker volume inspect web2gem_web2gem-data
docker volume inspect web2gem_browser-profiles
```

Back up `web2gem-data`, `browser-profiles`, and `secrets\web2gem_master_key` **as one set**. For a consistent backup, stop both services and copy both volumes plus the key file using your normal Docker-volume backup method:

```bash
docker compose stop web2gem browser-helper
# back up web2gem-data, browser-profiles, and secrets\web2gem_master_key
docker compose start web2gem browser-helper
```

Losing the master key makes the encrypted email, password, and TOTP values unrecoverable, but it does not delete existing SQLite Gemini cookies or browser profiles. You may create a new key and re-enter credentials, but do not overwrite the only recoverable copy of the old key. Key rotation requires re-encrypting credentials; replacing the file alone is not a rotation procedure.

Update the checkout and rebuild without deleting the volume:

```bash
git pull
docker compose up -d --build
```

## Troubleshooting

- Container exits before listening: run `docker compose logs web2gem` and verify `/data` is writable.
- Browser helper exits: verify that the master-key file exists and that the internal token and noVNC password are non-empty, then inspect `docker compose logs browser-helper`.
- Admin page rejects access: make sure `ADMIN_KEY` is non-empty and use the same value in the UI.
- Client receives `401`: use one of the comma-separated values in `API_KEYS`, or leave `API_KEYS` empty for private local use.
- Generation returns `no_available_gemini_account`: import at least one usable account at `/admin` and inspect its health state.
- Gemini returns empty output: confirm `GEMINI_BL` is current; configure a compatible `GEMINI_ORIGIN` only when you intentionally use a forwarding endpoint.
- Port conflict: change `PORT` in `.env`, then recreate with `docker compose up -d`.
- Browser access fails while the API works: verify that both containers use the same `HTTP_PROXY` / `HTTPS_PROXY` and that the proxy accepts traffic from Docker's virtual network.

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
