import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { outputLine } from "../server/io.mjs";
import { commandAvailable, outputCommand, runCommand } from "./process.mjs";

export function smokeResourceNames(pid, nonce) {
	const suffix = `${Number(pid) || 0}-${String(nonce)
		.replace(/[^a-z0-9]/gi, "")
		.slice(0, 12)}`.toLowerCase();
	return Object.freeze({
		project: `web2gem-smoke-${suffix}`,
		webImage: `web2gem:smoke-${suffix}`,
		helperImage: `web2gem-browser-helper:smoke-${suffix}`,
	});
}

export function assertLoopbackPort(raw, expectedContainerPort) {
	const match = /^127\.0\.0\.1:(\d+)$/m.exec(String(raw).trim());
	if (!match || !Number(match[1]))
		throw new Error(
			`Docker smoke failed: ${expectedContainerPort} was not mapped to loopback`,
		);
	return Number(match[1]);
}

export function assertSmokeRedacted(logs, secrets) {
	const text = String(logs);
	for (const secret of secrets) {
		if (secret && text.includes(secret))
			throw new Error("Docker smoke failed: container logs exposed a secret");
	}
}

async function main() {
	if (!(await commandAvailable("docker"))) {
		outputLine("Docker smoke skipped: docker executable not found");
		return;
	}
	const daemon = await runCommand("docker", ["info"], {
		allowFailure: true,
		stdio: "ignore",
	});
	if (daemon.code !== 0)
		throw new Error("Docker smoke failed: Docker daemon is unavailable");

	const names = smokeResourceNames(process.pid, randomBytes(8).toString("hex"));
	const temp = await mkdtemp(join(tmpdir(), `${names.project}-`));
	const secretFile = join(temp, "web2gem_master_key");
	const masterKey = randomBytes(32).toString("base64");
	const apiKey = `api-${randomBytes(24).toString("hex")}`;
	const adminKey = `admin-${randomBytes(24).toString("hex")}`;
	const internalToken = `internal-${randomBytes(24).toString("hex")}`;
	const novncPassword = `vnc-${randomBytes(18).toString("hex")}`;
	const compose = resolve("compose.yaml");
	const composeArgs = [
		"compose",
		"--project-name",
		names.project,
		"--file",
		compose,
	];
	const port = await freePort();
	let novncPort = await freePort();
	while (novncPort === port) novncPort = await freePort();
	const env = {
		...process.env,
		PORT: String(port),
		NOVNC_PORT: String(novncPort),
		WEB2GEM_IMAGE: names.webImage,
		BROWSER_HELPER_IMAGE: names.helperImage,
		WEB2GEM_MASTER_KEY_FILE: secretFile,
		API_KEYS: apiKey,
		ADMIN_KEY: adminKey,
		BROWSER_HELPER_INTERNAL_TOKEN: internalToken,
		NOVNC_PASSWORD: novncPassword,
		NOVNC_PUBLIC_URL: `http://127.0.0.1:${novncPort}/vnc.html`,
		BROWSER_CHECK_INTERVAL_SEC: "86400",
		BROWSER_CHECK_JITTER_SEC: "0",
		FEISHU_WEBHOOK_URL: "",
		FEISHU_SIGNING_SECRET: "",
	};
	let composeAttempted = false;
	try {
		await writeFile(secretFile, `${masterKey}\n`, { mode: 0o600 });
		composeAttempted = true;
		await runCommand(
			"docker",
			[...composeArgs, "up", "-d", "--build", "--wait"],
			{ env },
		);
		await assertHealthy(composeArgs, env, "web2gem");
		await assertHealthy(composeArgs, env, "browser-helper");
		const mappedNovncPort = assertLoopbackPort(
			await outputCommand(
				"docker",
				[...composeArgs, "port", "browser-helper", "6080"],
				{ env },
			),
			6080,
		);
		assert(mappedNovncPort === novncPort, "noVNC port mapping changed");
		await waitForHealth(`http://127.0.0.1:${port}/`);
		await waitForHealth(`http://127.0.0.1:${novncPort}/vnc.html`);
		const health = await fetch(`http://127.0.0.1:${port}/`);
		assert(health.status === 200, `health status ${health.status}`);
		assert(
			(await health.json()).status === "ok",
			"health payload did not report ok",
		);
		const authFailure = await fetch(`http://127.0.0.1:${port}/v1/models`);
		assert(
			authFailure.status === 401,
			`auth failure status ${authFailure.status}`,
		);

		const models = await fetch(`http://127.0.0.1:${port}/v1/models`, {
			headers: { Authorization: `Bearer ${apiKey}` },
		});
		assert(
			models.status === 200,
			`authenticated models status ${models.status}`,
		);
		const emptyAccountPool = await fetch(
			`http://127.0.0.1:${port}/v1/chat/completions`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: "gemini-3.1-pro",
					messages: [{ role: "user", content: "hello" }],
				}),
			},
		);
		assert(
			emptyAccountPool.status === 503,
			`empty account pool status ${emptyAccountPool.status}`,
		);
		assert(
			(await emptyAccountPool.json()).error?.code ===
				"no_available_gemini_account",
			"empty account pool did not return the availability error",
		);

		const webContainerBefore = await serviceContainer(
			composeArgs,
			env,
			"web2gem",
		);
		await runCommand(
			"docker",
			[
				...composeArgs,
				"exec",
				"-T",
				"browser-helper",
				"node",
				"-e",
				"require('node:fs').writeFileSync('/profiles/.smoke-profile','ok')",
			],
			{ env, stdio: "ignore" },
		);
		await runCommand("docker", [...composeArgs, "restart", "browser-helper"], {
			env,
			stdio: "ignore",
		});
		await waitForServiceHealth(composeArgs, env, "browser-helper");
		assert(
			(await serviceContainer(composeArgs, env, "web2gem")) ===
				webContainerBefore,
			"helper restart recreated web2gem",
		);
		assert(
			(
				await outputCommand(
					"docker",
					[
						...composeArgs,
						"exec",
						"-T",
						"browser-helper",
						"node",
						"-e",
						"process.stdout.write(require('node:fs').readFileSync('/profiles/.smoke-profile','utf8'))",
					],
					{ env },
				)
			).trim() === "ok",
			"browser profile volume did not persist",
		);

		const sqliteWrite = [
			"const{DatabaseSync}=require('node:sqlite')",
			"const d=new DatabaseSync(process.env.SQLITE_PATH)",
			"d.prepare(\"INSERT OR REPLACE INTO gemini_pool_meta(key,value,updated_at_ms) VALUES('smoke_persistence','ok',1)\").run()",
			"d.close()",
		].join(";");
		await runCommand(
			"docker",
			[...composeArgs, "exec", "-T", "web2gem", "node", "-e", sqliteWrite],
			{ env, stdio: "ignore" },
		);
		await runCommand(
			"docker",
			[...composeArgs, "up", "-d", "--no-deps", "--force-recreate", "web2gem"],
			{ env, stdio: "ignore" },
		);
		await waitForServiceHealth(composeArgs, env, "web2gem");
		const sqliteRead = [
			"const{DatabaseSync}=require('node:sqlite')",
			"const d=new DatabaseSync(process.env.SQLITE_PATH,{readOnly:true})",
			"process.stdout.write(d.prepare(\"SELECT value FROM gemini_pool_meta WHERE key='smoke_persistence'\").get()?.value||'')",
			"d.close()",
		].join(";");
		assert(
			(
				await outputCommand(
					"docker",
					[...composeArgs, "exec", "-T", "web2gem", "node", "-e", sqliteRead],
					{ env },
				)
			).trim() === "ok",
			"SQLite volume did not persist",
		);

		const logs = await outputCommand(
			"docker",
			[...composeArgs, "logs", "--no-color"],
			{ env },
		);
		assertSmokeRedacted(logs, [
			masterKey,
			apiKey,
			adminKey,
			internalToken,
			novncPassword,
		]);
		outputLine("Docker smoke check passed");
	} finally {
		if (composeAttempted)
			await runCommand("docker", [...composeArgs, "down", "--remove-orphans"], {
				env,
				allowFailure: true,
				stdio: "ignore",
			});
		for (const volume of [
			`${names.project}_web2gem-data`,
			`${names.project}_browser-profiles`,
		])
			await outputCommand("docker", ["volume", "rm", volume], {
				allowFailure: true,
			});
		for (const image of [names.webImage, names.helperImage])
			await outputCommand("docker", ["image", "rm", image], {
				allowFailure: true,
			});
		await rm(temp, { recursive: true, force: true });
	}
}

async function serviceContainer(composeArgs, env, service) {
	const id = (
		await outputCommand("docker", [...composeArgs, "ps", "-q", service], {
			env,
		})
	).trim();
	assert(id, `${service} container is missing`);
	return id;
}

async function assertHealthy(composeArgs, env, service) {
	const id = await serviceContainer(composeArgs, env, service);
	const status = (
		await outputCommand(
			"docker",
			["inspect", "--format", "{{.State.Health.Status}}", id],
			{ env },
		)
	).trim();
	assert(status === "healthy", `${service} health status ${status}`);
}

async function waitForServiceHealth(composeArgs, env, service) {
	let last = "missing";
	for (let index = 0; index < 90; index += 1) {
		try {
			const id = await serviceContainer(composeArgs, env, service);
			last = (
				await outputCommand(
					"docker",
					["inspect", "--format", "{{.State.Health.Status}}", id],
					{ env, allowFailure: true },
				)
			).trim();
			if (last === "healthy") return;
		} catch {}
		await delay(1_000);
	}
	throw new Error(`Docker smoke failed: ${service} health status ${last}`);
}

async function waitForHealth(url) {
	let lastError = null;
	for (let index = 0; index < 60; index += 1) {
		try {
			const response = await fetch(url, {
				signal: AbortSignal.timeout(2_000),
			});
			if (response.ok) return;
			lastError = new Error(`health status ${response.status}`);
		} catch (error) {
			lastError = error;
		}
		await delay(500);
	}
	throw new Error(
		`Docker smoke failed: health did not become ready: ${lastError}`,
	);
}

function freePort() {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.unref();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close((error) => {
				if (error) reject(error);
				else if (address && typeof address === "object")
					resolvePort(address.port);
				else reject(new Error("Docker smoke failed: no free port"));
			});
		});
	});
}

function delay(ms) {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function assert(ok, message) {
	if (!ok) throw new Error(`Docker smoke failed: ${message}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	await main();
