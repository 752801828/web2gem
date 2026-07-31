export type CandidateCookieInput = {
	accountId: string;
	psid: string;
	psidts: string;
	observedEmail: string | null;
	nowMs: number;
};

export type CandidateCookieResult =
	| {
			ok: true;
			changed: boolean;
			state: "ready";
			lastCookieUpdateAtMs: number;
	  }
	| {
			ok: false;
			code:
				| "browser_candidate_invalid"
				| "browser_account_not_found"
				| "browser_identity_mismatch"
				| "browser_cookie_verification_failed"
				| "browser_account_restricted"
				| "browser_cookie_conflict";
	  };

type CandidateProbe = {
	statusCode: number;
	issue:
		| "auth"
		| "rate_limit"
		| "user_action"
		| "location"
		| "transient"
		| null;
	models: readonly {
		modelId: string;
		displayName: string;
		description: string;
		available: boolean;
		capacity: number;
		capacityField: number;
		modelNumber: number;
		discoveryOrder: number;
	}[];
};

type CandidateAccount = {
	id: string;
	cookie_header: string;
	cookie_hash: string;
	identity_hash: string;
	login_email_hash: string | null;
};

type CandidateWrite = {
	cookieHeader: string;
	cookieHash: string;
	identityHash: string;
	changed: boolean;
	probe: CandidateProbe;
	nowMs: number;
};

export type CandidateCookieStore = {
	getBrowserCandidateAccount(
		accountId: string,
	): Promise<CandidateAccount | null>;
	replaceVerifiedBrowserCookie(
		accountId: string,
		write: CandidateWrite,
	): Promise<{ changed: boolean; reason?: "conflict" }>;
};

type CandidateSessionConfig<TConfig extends object> = TConfig & {
	cookie: string;
	sapisid: string;
	gemini_account: { accountId: string; cookieHash: string };
};

type CandidateVerifier<TConfig extends object> = (input: {
	config: CandidateSessionConfig<TConfig>;
	level: "status";
}) => Promise<
	| { ok: true; probe?: CandidateProbe }
	| {
			ok: false;
			reason: "missing_page_at_token" | "status_probe_failed";
	  }
>;

type CandidateCookieServiceOptions<TConfig extends object> = {
	store: CandidateCookieStore;
	baseConfig: TConfig;
	verifyAccount: CandidateVerifier<TConfig>;
	pool?: { refreshSnapshot(nowMs?: number): Promise<void> };
	refreshPool?: () => Promise<void>;
};

export class CandidateCookieService<TConfig extends object> {
	constructor(
		private readonly options: CandidateCookieServiceOptions<TConfig>,
	) {}

	async replace(input: CandidateCookieInput): Promise<CandidateCookieResult> {
		if (!validInput(input))
			return { ok: false, code: "browser_candidate_invalid" };
		const account = await this.options.store.getBrowserCandidateAccount(
			input.accountId,
		);
		if (!account) return { ok: false, code: "browser_account_not_found" };

		const cookieHeader = `__Secure-1PSID=${input.psid}; __Secure-1PSIDTS=${input.psidts}`;
		const cookieHash = await sha256Hex(cookieHeader);
		const identityHash = await sha256Hex(input.psid);
		if (
			identityHash !== account.identity_hash &&
			!(await observedIdentityMatches(input.observedEmail, account))
		)
			return { ok: false, code: "browser_identity_mismatch" };

		const verification = await this.options.verifyAccount({
			config: {
				...this.options.baseConfig,
				cookie: cookieHeader,
				sapisid: "",
				gemini_account: { accountId: account.id, cookieHash },
			},
			level: "status",
		});
		if (!verification.ok || !verification.probe)
			return { ok: false, code: "browser_cookie_verification_failed" };
		if (verification.probe.issue !== null)
			return { ok: false, code: "browser_account_restricted" };

		const stored = await this.options.store.replaceVerifiedBrowserCookie(
			account.id,
			{
				cookieHeader,
				cookieHash,
				identityHash,
				changed: cookieHash !== account.cookie_hash,
				probe: verification.probe,
				nowMs: input.nowMs,
			},
		);
		if (stored.reason === "conflict")
			return { ok: false, code: "browser_cookie_conflict" };
		await this.refreshPool(input.nowMs);
		return {
			ok: true,
			changed: stored.changed,
			state: "ready",
			lastCookieUpdateAtMs: input.nowMs,
		};
	}

	private async refreshPool(nowMs: number): Promise<void> {
		if (this.options.pool) await this.options.pool.refreshSnapshot(nowMs);
		else if (this.options.refreshPool) await this.options.refreshPool();
	}
}

function validInput(input: CandidateCookieInput): boolean {
	return (
		typeof input.accountId === "string" &&
		input.accountId.trim().length > 0 &&
		bareCookieValue(input.psid) &&
		bareCookieValue(input.psidts) &&
		(input.observedEmail === null || typeof input.observedEmail === "string") &&
		Number.isSafeInteger(input.nowMs) &&
		input.nowMs >= 0
	);
}

function bareCookieValue(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !/[\s=;]/.test(value);
}

async function observedIdentityMatches(
	observedEmail: string | null,
	account: CandidateAccount,
): Promise<boolean> {
	if (!observedEmail || !account.login_email_hash) return false;
	const canonical = observedEmail.trim().toLowerCase();
	if (!canonical) return false;
	return timingSafeHexEqual(
		await sha256Hex(canonical),
		account.login_email_hash,
	);
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

function timingSafeHexEqual(left: string, right: string): boolean {
	const leftBytes = hexBytes(left);
	const rightBytes = hexBytes(right);
	if (!leftBytes || !rightBytes) return false;
	const size = Math.max(leftBytes.length, rightBytes.length);
	let different = leftBytes.length ^ rightBytes.length;
	for (let index = 0; index < size; index++)
		different |= (leftBytes[index] || 0) ^ (rightBytes[index] || 0);
	return different === 0;
}

function hexBytes(value: string): Uint8Array | null {
	if (!/^[0-9a-f]{64}$/.test(value)) return null;
	const bytes = new Uint8Array(32);
	for (let index = 0; index < bytes.length; index++)
		bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
	return bytes;
}
