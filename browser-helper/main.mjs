import { pathToFileURL } from "node:url";
import { readBrowserMasterKey } from "../server/secrets.mjs";
import { createChromiumLifecycle } from "./chromium.mjs";
import { loadBrowserHelperConfig } from "./config.mjs";
import { decryptBrowserCredentials } from "./crypto.mjs";
import { createFeishuNotifier } from "./feishu.mjs";
import { runGoogleLogin } from "./google-login.mjs";
import { createNoVncLifecycle } from "./novnc.mjs";
import { createBrowserScheduler } from "./scheduler.mjs";
import {
	createHelperControlServer,
	createProfileStore,
	createVisibleSessionCoordinator,
} from "./server.mjs";
import { createWeb2gemClient } from "./web2gem-client.mjs";

export function createBrowserHelperProcess(config, masterKey, dependencies = {}) {
	if (!(masterKey instanceof Uint8Array) || masterKey.byteLength !== 32)
		throw new Error("browser helper master key is unavailable");
	const client = (dependencies.createClient || createWeb2gemClient)(config);
	const browser = (dependencies.createBrowser || createChromiumLifecycle)({
		proxy: proxyFromEnvironment(dependencies.env || process.env),
		env: dependencies.env || process.env,
	});
	const novnc = (dependencies.createNoVnc || createNoVncLifecycle)({
		password: config.novncPassword,
	});
	let scheduler;
	const sessions = (dependencies.createSessions || createVisibleSessionCoordinator)(
		config,
		{
			novnc,
			scheduler: {
				enqueue(job) {
					return scheduler.enqueue(job);
				},
			},
		},
	);
	const login = dependencies.runLogin || runGoogleLogin;
	const notifier = (dependencies.createNotifier || createFeishuNotifier)(config, {
		client,
	});
	scheduler = (dependencies.createScheduler || createBrowserScheduler)(config, {
		client,
		browser,
		notifier,
		decryptCredentials: (accountId, envelope) =>
			decryptBrowserCredentials(masterKey, accountId, envelope),
		runLogin: (input) =>
			input.mode === "visible" ? sessions.hold(input, login) : login(input),
	});
	const profiles = (dependencies.createProfiles || createProfileStore)(
		{ profilesRoot: "/profiles" },
		{
			isBusy: (accountId) =>
				sessions.isActive(accountId) || scheduler.isBusy(accountId),
		},
	);
	const server = (dependencies.createServer || createHelperControlServer)(
		{ ...config, controlToken: config.internalToken },
		{ scheduler, sessions, profiles },
	);
	let stopping = null;
	const stop = () => {
		if (stopping) return stopping;
		stopping = (async () => {
			let firstError;
			try {
				await server.stop();
			} catch (error) {
				firstError = error;
			}
			sessions.requestStop();
			for (const operation of [
				() => scheduler.stop(),
				() => browser.close(),
				() => novnc.stop(),
			])
				try {
					await operation();
				} catch (error) {
					firstError ??= error;
				}
			if (firstError) throw firstError;
		})();
		return stopping;
	};
	return Object.freeze({
		async start() {
			await scheduler.start();
			try {
				await server.start();
			} catch (error) {
				await scheduler.stop();
				throw error;
			}
		},
		stop,
	});
}

export async function main(options = {}) {
	const config = loadBrowserHelperConfig(options.env || process.env);
	const masterKey = (options.readMasterKey || readBrowserMasterKey)(
		options.masterKeyPath,
	);
	const processLifecycle = createBrowserHelperProcess(
		config,
		masterKey,
		options.dependencies,
	);
	let shuttingDown = false;
	const shutdown = () => {
		if (shuttingDown) return;
		shuttingDown = true;
		processLifecycle
			.stop()
			.then(() => process.exit(0), () => process.exit(1));
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
	await processLifecycle.start();
	return processLifecycle;
}

function proxyFromEnvironment(env) {
	const value = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
	if (!value) return undefined;
	try {
		const url = new URL(value);
		if (!['http:', 'https:', 'socks5:'].includes(url.protocol)) throw new Error();
		const username = decodeURIComponent(url.username);
		const password = decodeURIComponent(url.password);
		url.username = "";
		url.password = "";
		return {
			server: url.href.replace(/\/$/, ""),
			...(username ? { username } : {}),
			...(password ? { password } : {}),
		};
	} catch {
		throw new Error("invalid browser helper proxy configuration");
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
)
	main().catch(() => {
		console.error("browser helper failed to start");
		process.exitCode = 1;
	});
