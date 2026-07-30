# web2gem 多账号池

[English](README.md)

这是一个面向单机 Docker 自托管的 Gemini Web 网关，兼容 OpenAI 和 Google Gemini API。服务使用本地 SQLite 持久化多个账号的状态，并提供账号管理页面。

## 部署模型

- 一台机器、一个应用容器。
- 一个本地 SQLite 数据库：`/data/web2gem.sqlite`。
- 一个 Compose 命名卷：`web2gem-data`，用于持久化。
- 在 `/admin` 管理多个 Gemini 账号。
- 使用 Node.js 标准 HTTP 和 `fetch`，不依赖外部数据库服务。

## 快速部署

需要安装 Docker Desktop，或带 Compose 的 Docker Engine。

PowerShell：

```powershell
Copy-Item .env.docker.example .env
```

Linux 或 macOS：

```bash
cp .env.docker.example .env
```

编辑 `.env`，至少填写一个高强度 `ADMIN_KEY`。如果 API 客户端也需要鉴权，再填写 `API_KEYS`。然后构建并启动：

```bash
docker compose up -d --build
```

验证服务：

```bash
curl http://127.0.0.1:52389/
```

打开 `http://127.0.0.1:52389/admin`，输入 `ADMIN_KEY`，导入你自己的 Gemini 账号。账号 cookie 和密钥都属于敏感信息，不要提交 `.env` 或导出的账号数据。

常用命令：

```bash
docker compose ps
docker compose logs -f web2gem
docker compose restart web2gem
docker compose down
```

`docker compose down` 会保留数据卷。除非你明确要删除账号数据库，否则不要执行 `docker compose down -v`。

## 参数说明

| 参数 | 默认值 | 用途 |
| --- | --- | --- |
| `PORT` | `52389` | 宿主机和容器 HTTP 端口。 |
| `WEB2GEM_IMAGE` | `web2gem-account-pool:local` | Compose 使用的本地镜像名。 |
| `SQLITE_PATH` | `/data/web2gem.sqlite` | 持久化卷内的 SQLite 文件。 |
| `SQLITE_BUSY_TIMEOUT_MS` | `5000` | SQLite 等待写锁的超时时间。 |
| `ADMIN_KEY` | 空 | `/admin` 和账号管理接口的密钥。请使用一个高强度值。 |
| `API_KEYS` | 空 | 可选，逗号分隔的客户端 API Key；留空表示不启用客户端鉴权。 |
| `DEFAULT_MODEL` | `gemini-3.5-flash` | 请求未指定模型时使用的默认模型。 |
| `GEMINI_BL` | 空 | 可选的上游 build label 覆盖值。 |
| `GEMINI_ORIGIN` | 空 | 可选的兼容转发服务地址。 |
| `RETRY_ATTEMPTS` | 内置值 | 通用重试次数。 |
| `GEMINI_ACCOUNT_MAX_ATTEMPTS` | 内置值 | 单次请求最多尝试的不同账号数。 |
| `GEMINI_ACCOUNT_REFRESH_INTERVAL_SEC` | 内置值 | 托管 cookie 的刷新周期。 |
| `GEMINI_ACCOUNT_CAPABILITY_TTL_SEC` | 内置值 | 账号能力缓存时间。 |
| `GEMINI_ACCOUNT_CAPABILITY_MODE` | 内置值 | 账号能力发现模式。 |
| `RETRY_DELAY_SEC` | 内置值 | 重试间隔。 |
| `REQUEST_TIMEOUT_SEC` | 内置值 | 上游请求超时。 |
| `REQUEST_BODY_MAX_BYTES` | `67108864` | 请求体最大字节数。 |
| `LOG_REQUESTS` | 内置值 | 是否记录请求日志。 |
| `CURRENT_INPUT_FILE_ENABLED` | 内置值 | 是否启用 current-input 文件路径。 |
| `CURRENT_INPUT_FILE_MIN_BYTES` | 内置值 | 该文件路径的最小字节数。 |
| `GENERIC_FILE_UPLOAD_MAX_BYTES` | 内置值 | 通用文件上传大小上限。 |

完整模板见 [`.env.docker.example`](.env.docker.example)，Compose 会显式传入所有受支持的运行时参数。

## API 接口

如果设置了 `API_KEYS`，请求需要携带 `Authorization: Bearer <key>`。

OpenAI 兼容 Chat Completions 示例：

```bash
curl http://127.0.0.1:52389/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.5-flash","messages":[{"role":"user","content":"你好"}]}'
```

主要路由：

- `GET /`：健康检查。
- `GET /v1/models`：OpenAI 兼容模型列表。
- `POST /v1/chat/completions`：OpenAI 兼容对话补全。
- `GET /v1beta/models` 和 `GET /v1/models/{model}`：Google 兼容模型查询。
- `POST /v1beta/models/{model}:generateContent`：Google 兼容内容生成。
- `GET /admin`：账号管理页面。
- `/admin/accounts` 和 `/admin/model-routing`：需要 `ADMIN_KEY` 的管理接口。

空账号池仍可响应健康检查和公开模型查询；需要账号的生成请求会返回 `503 no_available_gemini_account`，直到你导入可用账号。

## 持久化、备份和更新

服务启动时会创建 SQLite 文件，开启 foreign keys 和 WAL，并以幂等方式执行 `migrations/0001_gemini_accounts.sql`，完成后才开始监听端口。

查看数据卷：

```bash
docker volume inspect web2gem_web2gem-data
```

建议短暂停止应用后，再用你惯用的 Docker volume 备份方式复制数据：

```bash
docker compose stop web2gem
# 备份 web2gem-data 数据卷
docker compose start web2gem
```

更新代码并重建时不要删除数据卷：

```bash
git pull
docker compose up -d --build
```

## 常见问题

- 容器启动后立即退出：执行 `docker compose logs web2gem`，并确认 `/data` 可写。
- 管理页面无法登录：确认 `ADMIN_KEY` 不为空，页面里填写的值必须与 `.env` 一致。
- 客户端返回 `401`：使用 `API_KEYS` 中的任意一个值，或者仅在私有本机环境中将其留空。
- 生成返回 `no_available_gemini_account`：在 `/admin` 至少导入一个可用账号，并查看账号健康状态。
- Gemini 返回空内容：确认 `GEMINI_BL` 仍然有效；只有明确使用转发服务时才设置兼容的 `GEMINI_ORIGIN`。
- 端口冲突：修改 `.env` 中的 `PORT`，再执行 `docker compose up -d` 重建容器。

## 开发与质量检查

在 Docker 之外开发需要 Node.js 22+ 和 pnpm。

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

覆盖率 CI 会生成 `lcov` 和 `JSON summary` 产物。生产 bundle 是 `dist/app.js`，Docker 入口是 `server/docker-server.mjs`。

## 许可证

见 [LICENSE](LICENSE)。
