import { describe, test } from "vitest";
import { assert } from "../assertions.js";

const modulePath: string = "../../../browser-helper/entrypoint.mjs";
const { bootstrapBrowserHelper, runBrowserHelper } = await import(modulePath);

function dependencies(calls: string[]) {
	return {
		mkdir: async (path: string) => calls.push(`mkdir:${path}`),
		chown: async (path: string, uid: number, gid: number) =>
			calls.push(`chown:${path}:${uid}:${gid}`),
		chmod: async (path: string, mode: number) =>
			calls.push(`chmod:${path}:${mode.toString(8)}`),
		rm: async (path: string) => calls.push(`rm:${path}`),
		copyFile: async (source: string, target: string) =>
			calls.push(`copy:${source}:${target}`),
		setgroups: (groups: readonly number[]) =>
			calls.push(`setgroups:${groups.length}`),
		setgid: (gid: number) => calls.push(`setgid:${gid}`),
		setuid: (uid: number) => calls.push(`setuid:${uid}`),
		importMain: async () => {
			calls.push("import-main");
			return {
				main: async ({ masterKeyPath }: { masterKeyPath: string }) => {
					calls.push(`main:${masterKeyPath}`);
				},
			};
		},
	};
}

describe("browser helper root bootstrap", () => {
	test("copies the key and drops every privilege before importing main", async () => {
		const calls: string[] = [];
		await bootstrapBrowserHelper(dependencies(calls));
		assert.deepEqual(calls, [
			"mkdir:/run/browser-helper",
			"chown:/run/browser-helper:10001:10001",
			"chmod:/run/browser-helper:700",
			"mkdir:/profiles",
			"chown:/profiles:10001:10001",
			"chmod:/profiles:700",
			"rm:/run/browser-helper/master-key",
			"copy:/run/secrets/web2gem_master_key:/run/browser-helper/master-key",
			"chown:/run/browser-helper/master-key:10001:10001",
			"chmod:/run/browser-helper/master-key:400",
			"setgroups:0",
			"setgid:10001",
			"setuid:10001",
			"import-main",
			"main:/run/browser-helper/master-key",
		]);
	});

	test("fails closed and logs no secret when copying the key fails", async () => {
		const calls: string[] = [];
		const privateBytes = "private-master-key-bytes";
		const deps = dependencies(calls);
		const logs: string[] = [];
		let exitCode = 0;
		await runBrowserHelper({
			...deps,
			copyFile: async () => {
				throw new Error(privateBytes);
			},
			logError: (message: string) => logs.push(message),
			setExitCode: (code: number) => {
				exitCode = code;
			},
		});
		assert.equal(exitCode, 1);
		assert.deepEqual(logs, ["browser helper failed to start"]);
		assert.doesNotMatch(
			JSON.stringify({ calls, logs }),
			new RegExp(privateBytes),
		);
		assert.equal(
			calls.some((call) => call.startsWith("setuid:")),
			false,
		);
		assert.equal(calls.includes("import-main"), false);
	});

	test("fails closed and logs no secret when main cannot read the copied key", async () => {
		const calls: string[] = [];
		const privateBytes = "unreadable-private-master-key";
		const logs: string[] = [];
		let exitCode = 0;
		await runBrowserHelper({
			...dependencies(calls),
			importMain: async () => ({
				main: async () => {
					throw new Error(privateBytes);
				},
			}),
			logError: (message: string) => logs.push(message),
			setExitCode: (code: number) => {
				exitCode = code;
			},
		});
		assert.equal(exitCode, 1);
		assert.deepEqual(logs, ["browser helper failed to start"]);
		assert.doesNotMatch(
			JSON.stringify({ calls, logs }),
			new RegExp(privateBytes),
		);
		assert.equal(calls.includes("setuid:10001"), true);
	});
});
