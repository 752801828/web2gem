# web2gem 多账号池

[English](README.md)

这是一个面向单机 Docker 自托管的 Gemini Web 网关，兼容 OpenAI 和 Google Gemini API。服务使用本地 SQLite 持久化多个账号，并通过独立浏览器容器维护登录 Profile 和更新经过验证的 cookie。

## 部署模型

- 一台机器、两个容器：`web2gem` 和 `browser-helper`。
- 一个本地 SQLite 数据库：`/data/web2gem.sqlite`。
- `web2gem-data` 保存 SQLite，`browser-profiles` 保存 Chromium Profile。
- 只有 `web2gem` 写 SQLite；`browser-helper` 通过内部鉴权接口提交状态和候选 cookie。
- 在 `/admin` 管理多个 Gemini 账号。
- 不依赖 Cloudflare D1 或其他外部数据库。

## 快速部署

需要安装 Docker Desktop，或带 Compose 的 Docker Engine。以下是 Windows CMD 完整示例；命令直接写入随机值，不会在终端打印密钥：

```cmd
cd /d D:\web2gem-original
copy /Y .env.docker.example .env
powershell -NoProfile -Command "$r=[Security.Cryptography.RandomNumberGenerator]::Create();$b=New-Object byte[] 32;$r.GetBytes($b);New-Item -ItemType Directory -Force 'secrets'|Out-Null;[IO.File]::WriteAllText('secrets\web2gem_master_key',[Convert]::ToBase64String($b),[Text.UTF8Encoding]::new($false))"
powershell -NoProfile -Command "$p='.env';$s=[IO.File]::ReadAllText($p);$r=[Security.Cryptography.RandomNumberGenerator]::Create();function secret([int]$n){$b=New-Object byte[] $n;$r.GetBytes($b);-join($b|ForEach-Object{$_.ToString('x2')})};$s=[regex]::Replace($s,'(?m)^ADMIN_KEY=.*$','ADMIN_KEY='+(secret 32));$s=[regex]::Replace($s,'(?m)^BROWSER_HELPER_INTERNAL_TOKEN=.*$','BROWSER_HELPER_INTERNAL_TOKEN='+(secret 32));$s=[regex]::Replace($s,'(?m)^NOVNC_PASSWORD=.*$','NOVNC_PASSWORD='+(secret 16));[IO.File]::WriteAllText($p,$s,[Text.UTF8Encoding]::new($false))"
notepad .env
```

在 `.env` 中填写**已经轮换**的 `FEISHU_WEBHOOK_URL` 和 `FEISHU_SIGNING_SECRET`。聊天、日志或历史配置中曾暴露的值不得继续使用。飞书通知不需要时，两项都留空。按需设置 `API_KEYS` 和代理；不要复用 `ADMIN_KEY`、内部 token 或 noVNC 密码。

然后启动两个服务：

```cmd
cd /d D:\web2gem-original
docker compose up -d --build
docker compose ps
```

健康检查和管理页面默认地址：

```cmd
curl http://127.0.0.1:52389/
```

打开 `http://127.0.0.1:52389/admin`，输入 `ADMIN_KEY`，导入你自己的 Gemini 账号。账号 cookie、登录凭据和所有密钥均为敏感信息，不要提交 `.env`、`secrets` 或导出的账号数据。

PowerShell 仅复制模板时也可以使用：

PowerShell：

```powershell
Copy-Item .env.docker.example .env
```

Linux 或 macOS：

```bash
cp .env.docker.example .env
```

常用命令：

```bash
docker compose ps
docker compose logs -f web2gem
docker compose logs -f browser-helper
docker compose restart web2gem browser-helper
docker compose down
```

`docker compose down` 会保留数据卷。`docker compose down -v` 会删除 SQLite 和所有浏览器 Profile，除非确定要永久清空数据，否则不要执行。

## 浏览器辅助续期

- 在管理页为账号配置 Google 邮箱、密码和身份验证器的 Base32 密钥；这里需要的是身份验证器密钥，不是当前六位验证码。
- 默认每 6 小时检查一次，并加入最多 1 小时随机抖动；每个账号每天最多自动登录 2 次。
- 自动登录仅尽力处理邮箱、密码和 TOTP。它不会绕过 CAPTCHA、Passkey、手机确认、账号恢复或 Google 安全审查；遇到这些页面会停止自动提交并转为人工处理。
- 点击对应账号的“打开浏览器”，会打开 `http://127.0.0.1:6080/vnc.html`。noVNC 只映射到宿主机回环地址，内置剪贴板面板可用于复制粘贴。
- 同一时间只能有一个可见账号会话。切换账号前需确认停止当前会话；空闲会话默认 30 分钟关闭。
- 配置飞书后，只在登录需要处理、人工挑战和恢复等状态转换时发送去重通知。
- `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY` 会同时传给两个容器。Compose 会自动把内部服务名和回环地址追加到 `NO_PROXY`。
- 清除登录凭据只删除 SQLite 中的加密邮箱/密码/TOTP，不删除现有账号 cookie 或 Chromium Profile。删除 Profile 是独立操作，也不会删除 SQLite cookie 或加密凭据。

## 参数说明

| 参数 | 默认值 | 用途 |
| --- | --- | --- |
| `PORT` | `52389` | 宿主机和容器 HTTP 端口。 |
| `WEB2GEM_IMAGE` | `web2gem-account-pool:local` | Compose 使用的本地镜像名。 |
| `BROWSER_HELPER_IMAGE` | `web2gem-browser-helper:local` | 浏览器辅助容器镜像名。 |
| `SQLITE_PATH` | `/data/web2gem.sqlite` | 持久化卷内的 SQLite 文件。 |
| `SQLITE_BUSY_TIMEOUT_MS` | `5000` | SQLite 等待写锁的超时时间。 |
| `WEB2GEM_MASTER_KEY_FILE` | `./secrets/web2gem_master_key` | 32 字节 base64 主密钥文件，用于加密浏览器登录凭据。 |
| `ADMIN_KEY` | 空 | `/admin` 和账号管理接口的密钥。请使用一个高强度值。 |
| `API_KEYS` | 空 | 可选，逗号分隔的客户端 API Key；留空表示不启用客户端鉴权。 |
| `BROWSER_HELPER_INTERNAL_TOKEN` | 空 | 两个容器之间的独立鉴权 token，必填。 |
| `NOVNC_PORT` | `6080` | 仅绑定宿主机回环地址的 noVNC 端口。 |
| `NOVNC_PASSWORD` | 空 | noVNC/VNC 密码，必填；经典 VNC 只使用前 8 个字符。 |
| `NOVNC_PUBLIC_URL` | `http://127.0.0.1:6080/vnc.html` | 管理页打开的本机 noVNC 地址。 |
| `FEISHU_WEBHOOK_URL` / `FEISHU_SIGNING_SECRET` | 空 | 两项都设置才启用飞书通知。 |
| `BROWSER_CHECK_INTERVAL_SEC` | `21600` | 浏览器定期检查间隔。 |
| `BROWSER_CHECK_JITTER_SEC` | `3600` | 检查时间的最大随机抖动。 |
| `BROWSER_AUTLOGIN_MAX_ATTEMPTS_PER_DAY` | `2` | 每账号每天自动登录上限，最大值也是 2。 |
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

服务启动时会创建 SQLite 文件，开启 foreign keys 和 WAL，并按编号幂等执行 `migrations` 目录中的迁移，完成后才开始监听端口。

查看数据卷：

```bash
docker volume inspect web2gem_web2gem-data
docker volume inspect web2gem_browser-profiles
```

必须把 `web2gem-data`、`browser-profiles` 和 `secrets\web2gem_master_key` **作为同一组备份**。一致性备份前先停止两个服务，再使用你惯用的 Docker volume 备份方式复制两个卷和主密钥文件：

```bash
docker compose stop web2gem browser-helper
# 备份 web2gem-data、browser-profiles 和 secrets\web2gem_master_key
docker compose start web2gem browser-helper
```

主密钥丢失后，已加密的邮箱、密码和 TOTP 无法恢复；SQLite 中现有 Gemini cookie 和 `browser-profiles` 不会因此被删除。恢复时可以生成新主密钥并重新配置每个账号的登录凭据，但不要用新密钥覆盖唯一可恢复的旧备份。正常轮换主密钥也必须先重新加密所有凭据，不能只替换文件。

更新代码并重建时不要删除数据卷：

```bash
git pull
docker compose up -d --build
```

## 常见问题

- 容器启动后立即退出：执行 `docker compose logs web2gem`，并确认 `/data` 可写。
- `browser-helper` 启动失败：确认主密钥文件存在，且内部 token 和 noVNC 密码均非空；再查看 `docker compose logs browser-helper`。
- 管理页面无法登录：确认 `ADMIN_KEY` 不为空，页面里填写的值必须与 `.env` 一致。
- 客户端返回 `401`：使用 `API_KEYS` 中的任意一个值，或者仅在私有本机环境中将其留空。
- 生成返回 `no_available_gemini_account`：在 `/admin` 至少导入一个可用账号，并查看账号健康状态。
- Gemini 返回空内容：确认 `GEMINI_BL` 仍然有效；只有明确使用转发服务时才设置兼容的 `GEMINI_ORIGIN`。
- 端口冲突：修改 `.env` 中的 `PORT`，再执行 `docker compose up -d` 重建容器。
- 浏览器无法联网但主服务正常：检查两个容器是否使用相同的 `HTTP_PROXY` / `HTTPS_PROXY`，并确认代理允许来自 Docker 虚拟网络的连接。

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
