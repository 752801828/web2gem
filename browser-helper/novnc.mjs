import { spawn as nodeSpawn } from "node:child_process";
import { access, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const PASSWORD_PATH = "/run/browser-helper/vnc-password";
const PROCESS_SPECS = [
	{
		name: "xvfb",
		command: "Xvfb",
		args: [":99", "-screen", "0", "1280x800x24", "-nolisten", "tcp"],
	},
	{
		name: "x11vnc",
		command: "x11vnc",
		args: [
			"-display",
			":99",
			"-rfbport",
			"5900",
			"-listen",
			"127.0.0.1",
			"-forever",
			"-shared",
			"-passwdfile",
			PASSWORD_PATH,
		],
	},
	{
		name: "websockify",
		command: "websockify",
		args: ["--web", "/usr/share/novnc", "6080", "127.0.0.1:5900"],
	},
];

export function createNoVncLifecycle(config, dependencies = {}) {
	const password = validPassword(config?.password);
	const spawn = dependencies.spawn || nodeSpawn;
	const makeDirectory = dependencies.mkdir || mkdir;
	const write = dependencies.writeFile || writeFile;
	const setMode = dependencies.chmod || chmod;
	const remove = dependencies.rm || rm;
	const waitReady = dependencies.waitReady || defaultWaitReady;
	const stopProcess = dependencies.stopProcess || terminate;
	const processEnvironment = displayEnvironment(dependencies.env || process.env);
	let active = [];
	let starting = null;
	let stopping = null;

	async function cleanup() {
		const processes = active;
		active = [];
		for (const process of [...processes].reverse()) {
			try {
				await stopProcess(process.child);
			} catch {
				// Continue stopping the remainder of the display stack.
			}
		}
		try {
			await remove(PASSWORD_PATH, { force: true });
		} catch {
			// Password cleanup is best effort after all readers have stopped.
		}
	}

	return Object.freeze({
		async start() {
			if (stopping) await stopping;
			if (active.length) return;
			if (starting) return starting;
			const attempt = (async () => {
				try {
					await makeDirectory(path.dirname(PASSWORD_PATH), {
						recursive: true,
						mode: 0o700,
					});
					await write(PASSWORD_PATH, `${password}\n`, { mode: 0o600, flag: "w" });
					await setMode(PASSWORD_PATH, 0o600);
					for (const spec of PROCESS_SPECS) {
						const child = spawn(spec.command, [...spec.args], {
							stdio: "ignore",
							env: processEnvironment,
						});
						active.push({ name: spec.name, child });
						await waitReady(spec.name, child);
					}
				} catch {
					await cleanup();
					throw new Error("browser display stack failed");
				}
			})();
			starting = attempt;
			try {
				await attempt;
			} finally {
				if (starting === attempt) starting = null;
			}
		},
		async stop() {
			if (stopping) return stopping;
			const attempt = (async () => {
				if (starting) await starting.catch(() => undefined);
				await cleanup();
			})();
			stopping = attempt;
			try {
				await attempt;
			} finally {
				if (stopping === attempt) stopping = null;
			}
		},
	});
}

function validPassword(value) {
	if (
		typeof value !== "string" ||
		!value ||
		value !== value.trim() ||
		value.length > 256 ||
		/[\r\n\0]/.test(value)
	)
		throw new Error("invalid noVNC configuration");
	return value;
}

function displayEnvironment(source) {
	return {
		...(source.PATH ? { PATH: source.PATH } : {}),
		...(source.HOME ? { HOME: source.HOME } : {}),
		...(source.LANG ? { LANG: source.LANG } : {}),
		...(source.LC_ALL ? { LC_ALL: source.LC_ALL } : {}),
		...(source.TMPDIR ? { TMPDIR: source.TMPDIR } : {}),
		DISPLAY: ":99",
	};
}

async function defaultWaitReady(name, child) {
	let fail;
	const failed = new Promise((_, reject) => {
		fail = () => reject(new Error("display process exited"));
		child.once("error", fail);
		child.once("exit", fail);
	});
	try {
		await Promise.race([
			name === "xvfb"
				? poll(child, () => access("/tmp/.X11-unix/X99"))
				: poll(child, () => connect(name === "x11vnc" ? 5900 : 6080)),
			failed,
		]);
	} finally {
		child.off("error", fail);
		child.off("exit", fail);
	}
}

async function poll(child, probe) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (child.exitCode !== null) throw new Error("process exited");
		try {
			await probe();
			return;
		} catch {
			await new Promise((done) => setTimeout(done, 50));
		}
	}
	throw new Error("readiness timed out");
}

function connect(port) {
	return new Promise((resolve, reject) => {
		const socket = net.connect({ host: "127.0.0.1", port });
		socket.once("connect", () => {
			socket.destroy();
			resolve();
		});
		socket.once("error", reject);
	});
}

async function terminate(child) {
	if (!child || child.exitCode !== null) return;
	await new Promise((resolve) => {
		let timer;
		const done = () => {
			if (timer) clearTimeout(timer);
			resolve();
		};
		child.once("exit", done);
		if (!child.kill("SIGTERM")) return done();
		timer = setTimeout(() => {
			if (child.exitCode === null) child.kill("SIGKILL");
		}, 5_000);
	});
}
