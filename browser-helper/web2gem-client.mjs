const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1_024;
const PREFIX = "/internal/browser/accounts";
const BROWSER_STATES = new Set([
	"idle",
	"checking",
	"ready",
	"login_required",
	"manual_action_required",
	"error",
]);
const NOTIFICATION_STATES = new Set([
	"login_required",
	"manual_action_required",
	"error",
	"ready",
]);
const SAFE_REMOTE_CODES = new Set([
	"browser_account_not_found",
	"browser_candidate_invalid",
	"browser_identity_mismatch",
	"browser_cookie_verification_failed",
	"browser_account_restricted",
	"browser_cookie_conflict",
	"invalid_browser_helper_json",
]);

export class Web2gemClientError extends Error {
	constructor(status, code, message) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

export function createWeb2gemClient(config, options = {}) {
	let baseUrl;
	try {
		baseUrl = new URL(config.web2gemInternalUrl);
		if (
			baseUrl.protocol !== "http:" ||
			baseUrl.hostname !== "web2gem" ||
			baseUrl.username ||
			baseUrl.password ||
			baseUrl.pathname !== "/" ||
			baseUrl.search ||
			baseUrl.hash ||
			typeof config.internalToken !== "string" ||
			!config.internalToken ||
			config.internalToken !== config.internalToken.trim()
		)
			throw new Error();
	} catch {
		throw new Web2gemClientError(
			500,
			"web2gem_invalid_config",
			"invalid web2gem client configuration",
		);
	}
	const token = config.internalToken;
	const fetchImpl = options.fetch || fetch;
	const timeoutMs = options.timeoutMs || REQUEST_TIMEOUT_MS;
	const monotonicNow = options.monotonicNow || (() => performance.now());
	let serverDateSample = null;

	const call = async (method, path, body, validate) => {
		try {
			const response = await fetchImpl(new URL(path, baseUrl), {
				method,
				headers: {
					Authorization: `Bearer ${token}`,
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				redirect: "error",
				signal: AbortSignal.timeout(timeoutMs),
			});
			const sampledDate = response.headers.get("date");
			const sampledServerMs = sampledDate ? Date.parse(sampledDate) : NaN;
			if (Number.isFinite(sampledServerMs))
				serverDateSample = {
					serverMs: sampledServerMs,
					receivedAtMs: monotonicNow(),
				};
			const value = await readJson(response);
			if (!response.ok) throw remoteError(response.status, value);
			if (!validate(value)) invalidResponse(response.status);
			return value;
		} catch (error) {
			if (error instanceof Web2gemClientError) throw error;
			throw new Web2gemClientError(
				503,
				"web2gem_unavailable",
				"web2gem is unavailable",
			);
		}
	};

	return Object.freeze({
		get serverDate() {
			if (!serverDateSample) return null;
			const elapsedMs = Math.max(
				0,
				monotonicNow() - serverDateSample.receivedAtMs,
			);
			return new Date(serverDateSample.serverMs + elapsedMs).toUTCString();
		},
		async listAccounts() {
			const value = await call("GET", PREFIX, undefined, isAccountList);
			return value.accounts;
		},
		async acquireLease(accountId, owner, ttlSeconds) {
			const value = await call(
				"POST",
				accountPath(accountId, "lease"),
				{ owner, ttlSeconds },
				(value) => exactBoolean(value, "acquired"),
			);
			return value.acquired;
		},
		async releaseLease(accountId, owner) {
			await call(
				"DELETE",
				accountPath(accountId, "lease"),
				{ owner },
				(value) => exactTrue(value, "released"),
			);
		},
		async recordAutoLoginAttempt(accountId, date, maxAttempts) {
			if (
				typeof date !== "string" ||
				!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
				!Number.isSafeInteger(maxAttempts) ||
				maxAttempts < 1 ||
				maxAttempts > 2
			)
				throw new Web2gemClientError(
					400,
					"web2gem_invalid_request",
					"invalid web2gem request",
				);
			const value = await call(
				"POST",
				accountPath(accountId, "auto-login-attempt"),
				{ date, maxAttempts },
				isAttemptReservation,
			);
			return value;
		},
		getEncryptedCredentials(accountId) {
			return call(
				"GET",
				accountPath(accountId, "credentials"),
				undefined,
				isCredentialEnvelope,
			);
		},
		getSessionCookie(accountId) {
			return call(
				"GET",
				accountPath(accountId, "session-cookie"),
				undefined,
				isSessionCookie,
			);
		},
		async patchState(accountId, state) {
			await call(
				"PATCH",
				accountPath(accountId, "state"),
				state,
				(value) => exactTrue(value, "updated"),
			);
		},
		async patchNotificationState(
			accountId,
			expectedState,
			notificationState,
		) {
			const value = await call(
				"PATCH",
				accountPath(accountId, "state"),
				{ expectedState, notificationState },
				(value) => exactBoolean(value, "updated"),
			);
			return value.updated;
		},
		submitCandidateCookie(accountId, candidate) {
			return call(
				"POST",
				accountPath(accountId, "candidate-cookie"),
				candidate,
				isCandidateResult,
			);
		},
	});
}

async function readJson(response) {
	if (
		!/^application\/json(?:\s*;|$)/i.test(
			response.headers.get("content-type") || "",
		)
	)
		invalidResponse(response.status);
	if (!response.body) invalidResponse(response.status);
	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let bytes = 0;
	let text = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_RESPONSE_BYTES) {
				await reader.cancel();
				throw new Web2gemClientError(
					502,
					"web2gem_response_too_large",
					"web2gem response is too large",
				);
			}
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
		return JSON.parse(text);
	} catch (error) {
		if (error instanceof Web2gemClientError) throw error;
		invalidResponse(response.status);
	}
}

function remoteError(status, value) {
	const code = value?.error?.code;
	return new Web2gemClientError(
		status,
		typeof code === "string" && SAFE_REMOTE_CODES.has(code)
			? code
			: "web2gem_request_failed",
		"web2gem request failed",
	);
}

function invalidResponse(status) {
	throw new Web2gemClientError(
		status || 502,
		"web2gem_invalid_response",
		"web2gem returned an invalid response",
	);
}

function isSessionCookie(value) {
	return (
		plainObject(value) &&
		Object.keys(value).length === 2 &&
		validCookieValue(value.psid) &&
		validCookieValue(value.psidts)
	);
}

function validCookieValue(value) {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 4_096 &&
		!/[;=\s]/.test(value)
	);
}

function accountPath(accountId, action) {
	if (typeof accountId !== "string" || !accountId || accountId.length > 256)
		throw new Web2gemClientError(
			400,
			"web2gem_invalid_request",
			"invalid web2gem request",
		);
	return `${PREFIX}/${encodeURIComponent(accountId)}/${action}`;
}

function plainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactBoolean(value, key) {
	return (
		plainObject(value) &&
		Object.keys(value).length === 1 &&
		typeof value[key] === "boolean"
	);
}

function exactTrue(value, key) {
	return exactBoolean(value, key) && value[key] === true;
}

function isAttemptReservation(value) {
	return (
		plainObject(value) &&
		Object.keys(value).length === 2 &&
		typeof value.reserved === "boolean" &&
		Number.isSafeInteger(value.count) &&
		value.count > 0
	);
}

function isAccountList(value) {
	return (
		plainObject(value) &&
		Object.keys(value).length === 1 &&
		Array.isArray(value.accounts) &&
		value.accounts.every(isScheduleAccount)
	);
}

function isScheduleAccount(value) {
	return (
		plainObject(value) &&
		Object.keys(value).length === 7 &&
		typeof value.id === "string" &&
		value.id.length > 0 &&
		(value.label === null || typeof value.label === "string") &&
		isAccountStatus(value.status) &&
		nonnegativeInteger(value.authFailureCount) &&
		(value.autoLoginAttemptDate === null ||
			(typeof value.autoLoginAttemptDate === "string" &&
				/^\d{4}-\d{2}-\d{2}$/.test(value.autoLoginAttemptDate))) &&
		nonnegativeInteger(value.autoLoginAttemptCount) &&
		(value.notificationState === null ||
			NOTIFICATION_STATES.has(value.notificationState))
	);
}

function isAccountStatus(value) {
	return (
		plainObject(value) &&
		Object.keys(value).length === 6 &&
		typeof value.credentialsConfigured === "boolean" &&
		BROWSER_STATES.has(value.state) &&
		nullableTimestamp(value.lastCheckAtMs) &&
		nullableTimestamp(value.lastCookieUpdateAtMs) &&
		nullableTimestamp(value.lastAutoLoginAtMs) &&
		(value.failureCode === null ||
			(typeof value.failureCode === "string" &&
				/^[a-z0-9_]{1,64}$/.test(value.failureCode)))
	);
}

function nullableTimestamp(value) {
	return value === null || nonnegativeInteger(value);
}

function nonnegativeInteger(value) {
	return Number.isSafeInteger(value) && value >= 0;
}

function isCredentialEnvelope(value) {
	return (
		plainObject(value) &&
		Object.keys(value).length === 4 &&
		value.version === 1 &&
		typeof value.ciphertext === "string" &&
		typeof value.nonce === "string" &&
		typeof value.emailHash === "string"
	);
}

function isCandidateResult(value) {
	return (
		plainObject(value) &&
		Object.keys(value).length === 3 &&
		typeof value.changed === "boolean" &&
		value.state === "ready" &&
		nullableTimestamp(value.lastCookieUpdateAtMs)
	);
}
