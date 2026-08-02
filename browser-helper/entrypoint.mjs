import { constants } from "node:fs";
import {
	chmod as fsChmod,
	chown as fsChown,
	copyFile as fsCopyFile,
	mkdir as fsMkdir,
	rm as fsRm,
} from "node:fs/promises";
import { pathToFileURL } from "node:url";

const BROWSER_UID = 10_001;
const BROWSER_GID = 10_001;
const RUNTIME_DIRECTORY = "/run/browser-helper";
const PROFILES_DIRECTORY = "/profiles";
const SOURCE_KEY = "/run/secrets/web2gem_master_key";
const RUNTIME_KEY = `${RUNTIME_DIRECTORY}/master-key`;

export async function prepareBrowserRuntime(dependencies = {}) {
	const makeDirectory = dependencies.mkdir || fsMkdir;
	const changeOwner = dependencies.chown || fsChown;
	const changeMode = dependencies.chmod || fsChmod;
	const remove = dependencies.rm || fsRm;
	const copy = dependencies.copyFile || fsCopyFile;

	for (const directory of [RUNTIME_DIRECTORY, PROFILES_DIRECTORY]) {
		await makeDirectory(directory, { recursive: true, mode: 0o700 });
		await changeOwner(directory, BROWSER_UID, BROWSER_GID);
		await changeMode(directory, 0o700);
	}
	await remove(RUNTIME_KEY, { force: true });
	await copy(SOURCE_KEY, RUNTIME_KEY, constants.COPYFILE_EXCL);
	await changeOwner(RUNTIME_KEY, BROWSER_UID, BROWSER_GID);
	await changeMode(RUNTIME_KEY, 0o400);
	return RUNTIME_KEY;
}

export function dropBrowserPrivileges(dependencies = {}) {
	const setgroups = dependencies.setgroups || process.setgroups?.bind(process);
	const setgid = dependencies.setgid || process.setgid?.bind(process);
	const setuid = dependencies.setuid || process.setuid?.bind(process);
	if (!setgroups || !setgid || !setuid)
		throw new Error("browser helper privilege drop is unavailable");
	setgroups([]);
	setgid(BROWSER_GID);
	setuid(BROWSER_UID);
}

export async function bootstrapBrowserHelper(dependencies = {}) {
	const masterKeyPath = await prepareBrowserRuntime(dependencies);
	dropBrowserPrivileges(dependencies);
	const module = await (dependencies.importMain || (() => import("./main.mjs")))();
	if (typeof module.main !== "function")
		throw new Error("browser helper main is unavailable");
	return module.main({ masterKeyPath });
}

export async function runBrowserHelper(dependencies = {}) {
	try {
		await bootstrapBrowserHelper(dependencies);
	} catch {
		(dependencies.logError || console.error)("browser helper failed to start");
		if (dependencies.setExitCode) dependencies.setExitCode(1);
		else process.exitCode = 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	await runBrowserHelper();
