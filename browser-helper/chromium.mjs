import { createHash } from "node:crypto";
import { readlink as readLink, unlink as removeFile } from "node:fs/promises";
import { hostname as systemHostname } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const GEMINI_ORIGIN = "https://gemini.google.com";
const CONTAINER_ARGS = [
	"--no-first-run",
	"--disable-dev-shm-usage",
	"--disable-blink-features=AutomationControlled",
	"--no-sandbox",
	"--disable-setuid-sandbox",
];

export function profilePathForAccount(accountId, profilesRoot = "/profiles") {
	if (
		typeof accountId !== "string" ||
		!accountId ||
		Buffer.byteLength(accountId) > 1_024
	)
		throw new Error("browser account id is invalid");
	const root = path.resolve(profilesRoot);
	const directory = createHash("sha256").update(accountId).digest("hex");
	return path.join(root, directory);
}

export function createChromiumLifecycle({
	browserType = chromium,
	profilesRoot = "/profiles",
	executablePath = "/usr/bin/chromium",
	proxy,
	env = process.env,
	currentHostname = systemHostname(),
	readlink = readLink,
	unlink = removeFile,
	processAlive = isProcessAlive,
} = {}) {
	const browserEnv = safeBrowserEnvironment(env);
	let activeContext = null;
	let closePromise = null;

	async function start(accountId, headless) {
		if (activeContext) throw new Error("browser context is already active");
		const profilePath = profilePathForAccount(accountId, profilesRoot);
		const launch = (async () => {
			await removeStaleSingletons(profilePath, {
				currentHostname,
				readlink,
				unlink,
				processAlive,
			});
			return browserType.launchPersistentContext(
				profilePath,
				{
					executablePath,
					headless,
					ignoreDefaultArgs: ["--enable-automation"],
					proxy,
					env: browserEnv,
					args: [...CONTAINER_ARGS],
				},
			);
		})();
		activeContext = launch;
		try {
			return await launch;
		} catch (error) {
			if (activeContext === launch) activeContext = null;
			throw error;
		}
	}

	return {
		startHeadless: (accountId) => start(accountId, true),
		startVisible: (accountId) => start(accountId, false),
		async cookies() {
			if (!activeContext) throw new Error("browser context is not active");
			return (await activeContext).cookies(GEMINI_ORIGIN);
		},
		async close() {
			if (closePromise) return closePromise;
			if (!activeContext) return;
			const context = activeContext;
			const attempt = (async () => {
				await (await context).close();
				if (activeContext === context) activeContext = null;
			})();
			closePromise = attempt;
			try {
				return await attempt;
			} finally {
				if (closePromise === attempt) closePromise = null;
			}
		},
	};
}

async function removeStaleSingletons(
	profilePath,
	{ currentHostname, readlink, unlink, processAlive },
) {
	let target;
	try {
		target = await readlink(path.join(profilePath, "SingletonLock"));
	} catch (error) {
		if (error?.code === "ENOENT") return;
		throw error;
	}
	const match = /^(.*)-([1-9]\d*)$/.exec(path.basename(target));
	if (!match) return;
	const stale = match[1] !== currentHostname || !processAlive(Number(match[2]));
	if (!stale) return;
	for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"])
		try {
			await unlink(path.join(profilePath, name));
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
}

function isProcessAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

function safeBrowserEnvironment(source) {
	const allowed = [
		"PATH",
		"HOME",
		"LANG",
		"LANGUAGE",
		"LC_ALL",
		"LC_CTYPE",
		"TZ",
		"TMPDIR",
		"TMP",
		"TEMP",
		"SSL_CERT_FILE",
		"SSL_CERT_DIR",
		"NODE_EXTRA_CA_CERTS",
	];
	return {
		...Object.fromEntries(
			allowed
				.filter((key) => typeof source?.[key] === "string")
				.map((key) => [key, source[key]]),
		),
		DISPLAY: ":99",
	};
}
