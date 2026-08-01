const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const SAFE_CODE = /^[a-z0-9_]{1,64}$/;

export class BrowserHelperClientError extends Error {
	constructor(status, code, message) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

export function createBrowserHelperClient(sourceEnv = process.env, options = {}) {
	const internalUrl = stringValue(sourceEnv.BROWSER_HELPER_INTERNAL_URL);
	const internalToken = stringValue(sourceEnv.BROWSER_HELPER_INTERNAL_TOKEN);
	const novncPublicUrl = stringValue(sourceEnv.NOVNC_PUBLIC_URL);
	if (!internalUrl && !internalToken && !novncPublicUrl) return null;
	if (!internalUrl || !internalToken || !novncPublicUrl) invalidConfig();

	const baseUrl = validatedInternalUrl(internalUrl);
	const publicUrl = validatedPublicUrl(novncPublicUrl);
	const fetchImpl = options.fetch || fetch;
	const timeoutMs = options.timeoutMs || REQUEST_TIMEOUT_MS;

	const call = async (method, path) => {
		try {
			const response = await fetchImpl(new URL(path, baseUrl), {
				method,
				headers: { Authorization: `Bearer ${internalToken}` },
				redirect: "error",
				signal: AbortSignal.timeout(timeoutMs),
			});
			const body = await readBoundedResponse(response);
			if (!response.ok) {
				const detail = safeError(body);
				throw new BrowserHelperClientError(
					response.status,
					detail.code,
					detail.message,
				);
			}
		} catch (error) {
			if (error instanceof BrowserHelperClientError) throw error;
			throw new BrowserHelperClientError(
				503,
				"browser_helper_unavailable",
				"browser helper is unavailable",
			);
		}
	};

	return {
		checkNow(accountId) {
			return call("POST", `/checks/${encodeURIComponent(accountId)}`);
		},
		async openVisible(accountId) {
			await call("POST", `/sessions/${encodeURIComponent(accountId)}/open`);
			return { url: publicUrl };
		},
		stopVisible() {
			return call("POST", "/sessions/stop");
		},
		deleteProfile(accountId) {
			return call("DELETE", `/profiles/${encodeURIComponent(accountId)}`);
		},
	};
}

async function readBoundedResponse(response) {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let size = 0;
	let text = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return text + decoder.decode();
		size += value.byteLength;
		if (size > MAX_RESPONSE_BYTES) {
			await reader.cancel();
			throw new BrowserHelperClientError(
				502,
				"browser_helper_response_too_large",
				"browser helper response is too large",
			);
		}
		text += decoder.decode(value, { stream: true });
	}
}

function safeError(text) {
	try {
		const parsed = JSON.parse(text);
		const code = parsed?.error?.code;
		if (typeof code === "string" && SAFE_CODE.test(code)) {
			return {
				code,
				message: "browser helper request failed",
			};
		}
	} catch {}
	return {
		code: "browser_helper_request_failed",
		message: "browser helper request failed",
	};
}

function validatedInternalUrl(value) {
	const url = parsedHttpUrl(value);
	if (
		url.hostname !== "browser-helper" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		invalidConfig();
	if (!url.pathname.endsWith("/")) url.pathname += "/";
	return url;
}

function validatedPublicUrl(value) {
	const url = parsedHttpUrl(value);
	if (
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
	)
		invalidConfig();
	return url.href;
}

function parsedHttpUrl(value) {
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") invalidConfig();
		return url;
	} catch {
		invalidConfig();
	}
}

function stringValue(value) {
	return typeof value === "string" ? value.trim() : "";
}

function invalidConfig() {
	throw new Error("invalid browser helper configuration");
}
