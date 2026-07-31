import { describe, test } from "vitest";
import {
	CandidateCookieService,
	type CandidateCookieStore,
} from "../../../src/browser/candidate-cookie";
import {
	identityHashFromCookie,
	sha256Hex,
} from "../../../src/gemini/accounts/domain";
import type {
	GeminiAccountProbe,
	GeminiAccountVerifier,
} from "../../../src/gemini/accounts/probe";
import type { GeminiVerifiedBrowserCookieWrite } from "../../../src/gemini/accounts/types";
import { assert } from "../assertions.js";
import { baseGeminiClientConfig } from "../gemini/_support/client-fixtures.js";

const NOW = 123_456;
const OLD_COOKIE = "__Secure-1PSID=old-psid; __Secure-1PSIDTS=old-ts";
const MODEL: GeminiAccountProbe["models"][number] = {
	modelId: "model-pro",
	displayName: "Pro",
	description: "verified",
	available: true,
	capacity: 1,
	capacityField: 13,
	modelNumber: 1,
	discoveryOrder: 0,
};

async function fixture(
	options: {
		psid?: string;
		psidts?: string;
		observedEmail?: string | null;
		storedEmail?: string | null;
		verify?: GeminiAccountVerifier;
		writeResult?: { changed: boolean; reason?: "conflict" };
	} = {},
) {
	const psid = options.psid ?? "old-psid";
	const psidts = options.psidts ?? "old-ts";
	const writes: GeminiVerifiedBrowserCookieWrite[] = [];
	let refreshed = 0;
	const store: CandidateCookieStore = {
		async getBrowserCandidateAccount(accountId) {
			return {
				id: accountId,
				cookie_header: OLD_COOKIE,
				cookie_hash: await sha256Hex(OLD_COOKIE),
				identity_hash: await identityHashFromCookie(OLD_COOKIE),
				login_email_hash:
					options.storedEmail === undefined
						? await sha256Hex("owner@example.com")
						: options.storedEmail,
			};
		},
		async replaceVerifiedBrowserCookie(_accountId, write) {
			writes.push(write);
			return (
				options.writeResult ?? { changed: write.cookieHeader !== OLD_COOKIE }
			);
		},
	};
	const verify =
		options.verify ??
		(async () => ({
			ok: true as const,
			probe: { statusCode: 1000, issue: null, models: [MODEL] },
		}));
	const service = new CandidateCookieService({
		store,
		baseConfig: baseGeminiClientConfig(),
		verifyAccount: verify,
		refreshPool: async () => {
			refreshed += 1;
		},
	});
	const result = await service.replace({
		accountId: "account-a",
		psid,
		psidts,
		observedEmail: options.observedEmail ?? null,
		nowMs: NOW,
	});
	return { result, writes, refreshed };
}

describe("verified browser candidate cookies", () => {
	test("keeps unchanged secret bytes while recording a verified ready check", async () => {
		const { result, writes, refreshed } = await fixture();
		assert.deepEqual(result, {
			ok: true,
			changed: false,
			state: "ready",
			lastCookieUpdateAtMs: NOW,
		});
		assert.equal(writes.length, 1);
		assert.equal(writes[0]?.changed, false);
		assert.deepEqual(writes[0]?.probe.models, [MODEL]);
		assert.equal(refreshed, 1);
	});

	test("accepts a changed cookie for the same identity without an observed email", async () => {
		const { result, writes } = await fixture({ psidts: "new-ts" });
		assert.equal(result.ok, true);
		assert.equal(result.ok && result.changed, true);
		assert.equal(writes.length, 1);
		assert.equal(writes[0]?.changed, true);
	});

	test("accepts a changed identity only when canonical observed email matches configured credentials", async () => {
		const { result, writes } = await fixture({
			psid: "new-identity",
			psidts: "new-ts",
			observedEmail: "  OWNER@Example.COM ",
		});
		assert.equal(result.ok, true);
		assert.equal(writes.length, 1);
	});

	for (const [name, options] of [
		[
			"changed identity without credentials",
			{ psid: "new", storedEmail: null },
		],
		["changed identity without observed email", { psid: "new" }],
		[
			"changed identity with the wrong observed email",
			{ psid: "new", observedEmail: "wrong@example.com" },
		],
	] as const) {
		test(`rejects ${name} without mutation`, async () => {
			const { result, writes, refreshed } = await fixture(options);
			assert.deepEqual(result, {
				ok: false,
				code: "browser_identity_mismatch",
			});
			assert.equal(writes.length, 0);
			assert.equal(refreshed, 0);
		});
	}

	for (const [reason, code] of [
		["missing_page_at_token", "browser_cookie_verification_failed"],
		["status_probe_failed", "browser_cookie_verification_failed"],
	] as const) {
		test(`rejects ${reason} without mutation`, async () => {
			const { result, writes } = await fixture({
				verify: async () => ({ ok: false, reason }),
			});
			assert.deepEqual(result, { ok: false, code });
			assert.equal(writes.length, 0);
		});
	}

	test("rejects a restricted Gemini status without mutation", async () => {
		const { result, writes } = await fixture({
			verify: async () => ({
				ok: true,
				probe: { statusCode: 1016, issue: "auth", models: [] },
			}),
		});
		assert.deepEqual(result, { ok: false, code: "browser_account_restricted" });
		assert.equal(writes.length, 0);
	});

	test("rejects a verifier success without a probe before mutation", async () => {
		const { result, writes } = await fixture({
			verify: async () => ({ ok: true }),
		});
		assert.deepEqual(result, {
			ok: false,
			code: "browser_cookie_verification_failed",
		});
		assert.equal(writes.length, 0);
	});

	test("maps duplicate cookie or identity writes to a safe conflict", async () => {
		const { result } = await fixture({
			psidts: "new",
			writeResult: { changed: false, reason: "conflict" },
		});
		assert.deepEqual(result, { ok: false, code: "browser_cookie_conflict" });
	});

	test("rejects non-bare cookie values before account lookup", async () => {
		for (const psid of ["", "__Secure-1PSID=value", "value=x", "value;other"]) {
			const { result, writes } = await fixture({ psid });
			assert.deepEqual(result, {
				ok: false,
				code: "browser_candidate_invalid",
			});
			assert.equal(writes.length, 0);
		}
	});
});
