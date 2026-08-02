import { EventEmitter } from "node:events";
import { describe, test } from "vitest";
import { assert } from "../assertions.js";

const modulePath: string = "../../../browser-helper/novnc.mjs";
const { createNoVncLifecycle, terminateProcess } = await import(modulePath);

function fixture(options: { failReadyAt?: string } = {}) {
	const calls: unknown[][] = [];
	const processes: Array<EventEmitter & { kill: (signal: string) => boolean }> =
		[];
	const lifecycle = createNoVncLifecycle(
		{ password: "private-vnc-password" },
		{
			env: {
				PATH: "/usr/bin",
				LANG: "C.UTF-8",
				NOVNC_PASSWORD: "must-not-reach-child",
				BROWSER_HELPER_INTERNAL_TOKEN: "must-not-reach-child",
			},
			async mkdir(path: string, value: unknown) {
				calls.push(["mkdir", path, value]);
			},
			async writeFile(path: string, value: string, config: unknown) {
				calls.push(["write", path, value, config]);
			},
			async chmod(path: string, mode: number) {
				calls.push(["chmod", path, mode]);
			},
			async rm(path: string) {
				calls.push(["rm", path]);
			},
			spawn(command: string, args: string[], config: Record<string, unknown>) {
				calls.push(["spawn", command, args, config]);
				const child = Object.assign(new EventEmitter(), {
					exitCode: null as number | null,
					kill(signal: string) {
						calls.push(["kill", command, signal]);
						queueMicrotask(() => {
							child.exitCode = 0;
							child.emit("exit", 0, signal);
						});
						return true;
					},
				});
				processes.push(child);
				return child;
			},
			async waitReady(name: string) {
				calls.push(["ready", name]);
				if (name === options.failReadyAt) throw new Error("not ready");
			},
		},
	);
	return { lifecycle, calls, processes };
}

describe("noVNC process lifecycle", () => {
	test("starts the exact display stack without putting the password in argv or URLs", async () => {
		const active = fixture();
		await active.lifecycle.start();
		const spawns = active.calls.filter(([name]) => name === "spawn");
		assert.deepEqual(
			spawns.map(([, command, args]) => [command, args]),
			[
				["Xvfb", [":99", "-screen", "0", "1280x800x24", "-nolisten", "tcp"]],
				[
					"x11vnc",
					[
						"-display",
						":99",
						"-rfbport",
						"5900",
						"-listen",
						"127.0.0.1",
						"-forever",
						"-shared",
						"-passwdfile",
						"/run/browser-helper/vnc-password",
					],
				],
				["websockify", ["--web", "/usr/share/novnc", "6080", "127.0.0.1:5900"]],
			],
		);
		assert.deepEqual(
			active.calls.filter(([name]) => name === "ready").map((call) => call[1]),
			["xvfb", "x11vnc", "websockify"],
		);
		const write = active.calls.find(([name]) => name === "write");
		assert.equal(write?.[2], "private-vnc-password\n");
		assert.deepEqual(write?.[3], { mode: 0o600, flag: "w" });
		assert.deepEqual(
			active.calls.find(([name]) => name === "chmod"),
			["chmod", "/run/browser-helper/vnc-password", 0o600],
		);
		assert.equal(
			JSON.stringify(spawns).includes("private-vnc-password"),
			false,
		);
		assert.deepEqual((spawns[0]?.[3] as { env?: unknown } | undefined)?.env, {
			PATH: "/usr/bin",
			LANG: "C.UTF-8",
			DISPLAY: ":99",
		});

		await active.lifecycle.stop();
		assert.deepEqual(
			active.calls.filter(([name]) => name === "kill").map((call) => call[1]),
			["websockify", "x11vnc", "Xvfb"],
		);
		assert.deepEqual(active.calls.at(-1), [
			"rm",
			"/run/browser-helper/vnc-password",
		]);
	});

	test("cleans up already-started processes in reverse order after readiness failure", async () => {
		const active = fixture({ failReadyAt: "x11vnc" });
		await assert.rejects(active.lifecycle.start(), /display stack failed/);
		assert.deepEqual(
			active.calls.filter(([name]) => name === "kill").map((call) => call[1]),
			["x11vnc", "Xvfb"],
		);
		await active.lifecycle.stop();
		assert.equal(active.calls.filter(([name]) => name === "kill").length, 2);
	});

	test("finishes termination after SIGKILL even when a child never emits exit", async () => {
		const child = Object.assign(new EventEmitter(), {
			exitCode: null,
			signals: [] as string[],
			kill(signal: string) {
				this.signals.push(signal);
				return true;
			},
		});
		await terminateProcess(child, { sleep: async () => undefined });
		assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
		assert.equal(child.listenerCount("exit"), 0);
		assert.equal(child.listenerCount("error"), 0);
	});

	test("marks the stack failed and cleans up after a post-readiness process exit", async () => {
		const active = fixture();
		const started = await active.lifecycle.start();
		assert.equal(started.failureSignal.aborted, false);
		active.processes[1].exitCode = 1;
		active.processes[1].emit("exit", 1, null);
		for (
			let index = 0;
			index < 20 && !started.failureSignal.aborted;
			index += 1
		)
			await Promise.resolve();
		assert.equal(started.failureSignal.aborted, true);
		await active.lifecycle.stop();
		assert.equal(
			active.calls.filter(([name]) => name === "kill").length >= 2,
			true,
		);
	});
});
