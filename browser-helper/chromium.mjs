import { createHash } from "node:crypto";
import path from "node:path";
import { chromium } from "playwright-core";

const GEMINI_ORIGIN = "https://gemini.google.com";
const CONTAINER_ARGS = [
	"--no-first-run",
	"--disable-dev-shm-usage",
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
} = {}) {
	let activeContext = null;
	let closePromise = null;

	async function start(accountId, headless) {
		if (activeContext) throw new Error("browser context is already active");
		const launch = Promise.resolve(
			browserType.launchPersistentContext(
				profilePathForAccount(accountId, profilesRoot),
				{
					executablePath,
					headless,
					proxy,
					args: [...CONTAINER_ARGS],
				},
			),
		);
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
