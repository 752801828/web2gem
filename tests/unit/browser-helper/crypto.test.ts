import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, test } from "vitest";
import { assert } from "../assertions.js";

const cryptoModulePath: string = "../../../browser-helper/crypto.mjs";
const {
	decodeBrowserMasterKey,
	decryptBrowserCredentials,
	totp,
	totpCandidates,
} = await import(cryptoModulePath);

function encryptFixture(accountId: string, key: Buffer) {
	const credentials = {
		email: "owner@example.com",
		password: "test-password-placeholder",
		totpSecret: "JBSWY3DPEHPK3PXP",
	};
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	cipher.setAAD(Buffer.from(`web2gem:${accountId}:v1`));
	const encrypted = Buffer.concat([
		cipher.update(JSON.stringify(credentials), "utf8"),
		cipher.final(),
		cipher.getAuthTag(),
	]);
	return {
		credentials,
		envelope: {
			version: 1,
			ciphertext: encrypted.toString("base64"),
			nonce: nonce.toString("base64"),
			emailHash: createHash("sha256")
				.update(credentials.email)
				.digest("base64"),
		},
	};
}

describe("browser helper crypto", () => {
	test("decodes the canonical 32-byte Docker secret format", () => {
		const encoded = Buffer.alloc(32, 7).toString("base64");
		assert.deepEqual(
			decodeBrowserMasterKey(`${encoded}\n`),
			Buffer.alloc(32, 7),
		);
		for (const invalid of [
			"",
			encoded.slice(0, -1),
			`${encoded}\n\n`,
			"x".repeat(44),
		])
			assert.throws(
				() => decodeBrowserMasterKey(invalid),
				/browser master key is invalid/,
			);
	});

	test("decrypts the current AES-256-GCM envelope with account/version AAD", () => {
		const key = Buffer.alloc(32, 9);
		const fixture = encryptFixture("account-a", key);
		assert.deepEqual(
			decryptBrowserCredentials(key, "account-a", fixture.envelope),
			fixture.credentials,
		);

		for (const [accountId, envelope, activeKey] of [
			["account-b", fixture.envelope, key],
			["account-a", { ...fixture.envelope, version: 2 }, key],
			["account-a", { ...fixture.envelope, nonce: "not-base64" }, key],
			["account-a", fixture.envelope, Buffer.alloc(32, 8)],
		] as const) {
			let error: unknown;
			try {
				decryptBrowserCredentials(activeKey, accountId, envelope);
			} catch (caught) {
				error = caught;
			}
			assert.match(String(error), /browser credential decryption failed/);
			assert.doesNotMatch(
				String(error),
				/password-placeholder|ciphertext|not-base64|account-b/i,
			);
		}
	});

	test("matches RFC 6238 SHA-1 vectors as six-digit values", () => {
		const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
		for (const [seconds, expected] of [
			[59, "287082"],
			[1_111_111_109, "081804"],
			[1_111_111_111, "050471"],
			[1_234_567_890, "005924"],
			[2_000_000_000, "279037"],
			[20_000_000_000, "353130"],
		] as const)
			assert.equal(totp(secret, seconds), expected);
	});

	test("generates previous/current/next candidates and enforces sampled clock skew", () => {
		const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
		assert.deepEqual(totpCandidates(secret, 59), [
			totp(secret, 29),
			totp(secret, 59),
			totp(secret, 89),
		]);
		assert.deepEqual(
			totpCandidates(secret, 59, {
				serverDate: new Date(60_000).toUTCString(),
				maxClockSkewSec: 2,
			}),
			[totp(secret, 29), totp(secret, 59), totp(secret, 89)],
		);
		assert.throws(
			() =>
				totpCandidates(secret, 59, {
					serverDate: new Date(90_000).toUTCString(),
					maxClockSkewSec: 2,
				}),
			/browser clock is not synchronized/,
		);
	});
});
