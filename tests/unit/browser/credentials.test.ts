import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import {
	encryptBrowserCredentials,
	validateBrowserCredentials,
} from "../../../src/browser/credentials";
import type {
	BrowserCredentialCrypto,
	BrowserCredentials,
	EncryptedBrowserCredentials,
} from "../../../src/browser/types";
import { assert } from "../assertions.js";

type CredentialCryptoModule = {
	createCredentialCryptoBinding(key: Uint8Array): BrowserCredentialCrypto;
};
type SecretsModule = {
	readBrowserMasterKey(path?: string): Uint8Array | null;
};

const credentialCryptoModule = (await import(
	new URL("../../../server/credential-crypto.mjs", import.meta.url).href
)) as CredentialCryptoModule;
const secretsModule = (await import(
	new URL("../../../server/secrets.mjs", import.meta.url).href
)) as SecretsModule;

const credentials: BrowserCredentials = {
	email: "user@example.com",
	password: "correct horse battery staple",
	totpSecret: "JBSWY3DPEHPK3PXP",
};

function key(fill: number): Uint8Array {
	return new Uint8Array(32).fill(fill);
}

function noncanonicalBase64Alias(value: string): string {
	const alphabet =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	const paddingIndex = value.indexOf("=");
	const characterIndex = paddingIndex - 1;
	const index = alphabet.indexOf(value[characterIndex] ?? "");
	return `${value.slice(0, characterIndex)}${alphabet[index + 1]}${value.slice(characterIndex + 1)}`;
}

async function authenticatedEnvelope(
	masterKey: Uint8Array,
	accountId: string,
	plaintext: string,
): Promise<EncryptedBrowserCredentials> {
	const nonce = crypto.getRandomValues(new Uint8Array(12));
	const importedKey = await crypto.subtle.importKey(
		"raw",
		new Uint8Array(masterKey).buffer,
		"AES-GCM",
		false,
		["encrypt"],
	);
	const ciphertext = await crypto.subtle.encrypt(
		{
			name: "AES-GCM",
			iv: nonce,
			additionalData: new TextEncoder().encode(`web2gem:${accountId}:v1`),
			tagLength: 128,
		},
		importedKey,
		new TextEncoder().encode(plaintext),
	);
	const emailHash = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode("user@example.com"),
	);
	return {
		version: 1,
		ciphertext: Buffer.from(ciphertext).toString("base64"),
		nonce: Buffer.from(nonce).toString("base64"),
		emailHash: Buffer.from(emailHash).toString("base64"),
	};
}

async function errorText(
	run: () => unknown | Promise<unknown>,
): Promise<string> {
	try {
		await run();
		return "";
	} catch (error) {
		return String(error);
	}
}

describe("browser credential validation", () => {
	test("canonicalizes email and TOTP input before encryption", async () => {
		let seen: BrowserCredentials | undefined;
		const binding: BrowserCredentialCrypto = {
			async encrypt(_accountId, value) {
				seen = value;
				return {
					version: 1,
					ciphertext: "ciphertext",
					nonce: "nonce",
					emailHash: "hash",
				};
			},
			async decrypt() {
				throw new Error("unused");
			},
		};

		await encryptBrowserCredentials(binding, "account-1", {
			email: "  User@Example.COM  ",
			password: "password",
			totpSecret: "jbsw-y3dp ehpk3pxp",
		});

		assert.deepEqual(seen, {
			email: "user@example.com",
			password: "password",
			totpSecret: "JBSWY3DPEHPK3PXP",
		});
	});

	test("rejects malformed base32 seeds and impossible padding", () => {
		for (const totpSecret of [
			"ABC1",
			"A",
			"ABC",
			"ABCDEF",
			"MY=ABCDE",
			"MY=====",
			"MZXW6===X",
		]) {
			assert.throws(
				() => validateBrowserCredentials({ ...credentials, totpSecret }),
				/browser credentials are invalid/,
			);
		}
		assert.equal(
			validateBrowserCredentials({ ...credentials, totpSecret: "MY======" })
				.totpSecret,
			"MY======",
		);
	});

	test("enforces UTF-8 byte limits and the normalized seed limit", () => {
		assert.equal(
			validateBrowserCredentials({
				...credentials,
				email: `${"a".repeat(308)}@example.com`,
			}).email.length,
			320,
		);
		assert.throws(
			() =>
				validateBrowserCredentials({
					...credentials,
					email: `${"\u00e9".repeat(155)}@example.com`,
				}),
			/browser credentials are invalid/,
		);
		assert.equal(
			validateBrowserCredentials({
				...credentials,
				password: "p".repeat(1024),
			}).password.length,
			1024,
		);
		assert.throws(
			() =>
				validateBrowserCredentials({
					...credentials,
					password: "\u5bc6".repeat(342),
				}),
			/browser credentials are invalid/,
		);
		assert.equal(
			validateBrowserCredentials({
				...credentials,
				totpSecret: "A".repeat(256),
			}).totpSecret.length,
			256,
		);
		assert.throws(
			() =>
				validateBrowserCredentials({
					...credentials,
					totpSecret: "A".repeat(257),
				}),
			/browser credentials are invalid/,
		);
	});

	test("never includes supplied credential values in validation errors", async () => {
		const supplied = {
			email: "private-email@example.test",
			password: "private-password",
			totpSecret: "private-seed!",
		};
		const message = await errorText(() => validateBrowserCredentials(supplied));
		for (const value of Object.values(supplied)) {
			assert.doesNotMatch(
				message,
				new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
			);
		}
	});
});

describe("browser credential cryptography", () => {
	test("round trips with AES-GCM and independent nonces", async () => {
		const binding = credentialCryptoModule.createCredentialCryptoBinding(
			key(7),
		);
		const first = await binding.encrypt("account-1", credentials);
		const second = await binding.encrypt("account-1", credentials);

		assert.deepEqual(await binding.decrypt("account-1", first), credentials);
		assert.equal(first.version, 1);
		assert.equal(Buffer.from(first.nonce, "base64").byteLength, 12);
		assert.equal(first.nonce === second.nonce, false);
		assert.equal(first.ciphertext === second.ciphertext, false);
	});

	test("hashes the canonical lower-case email", async () => {
		const binding = credentialCryptoModule.createCredentialCryptoBinding(
			key(8),
		);
		const canonical = await binding.encrypt("account-1", credentials);

		assert.match(canonical.emailHash, /^[A-Za-z0-9+/]{43}=$/);
		const expected = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode("user@example.com"),
		);
		assert.equal(canonical.emailHash, Buffer.from(expected).toString("base64"));
	});

	test("copies key bytes before asynchronous key import", async () => {
		const sourceKey = key(13);
		const binding =
			credentialCryptoModule.createCredentialCryptoBinding(sourceKey);
		sourceKey.fill(14);
		const encrypted = await binding.encrypt("account-1", credentials);
		const originalKeyBinding =
			credentialCryptoModule.createCredentialCryptoBinding(key(13));

		assert.deepEqual(
			await originalKeyBinding.decrypt("account-1", encrypted),
			credentials,
		);
	});

	test("rejects a wrong key and changed-account AAD", async () => {
		const encrypted = await credentialCryptoModule
			.createCredentialCryptoBinding(key(9))
			.encrypt("account-1", credentials);

		await assert.rejects(
			() =>
				credentialCryptoModule
					.createCredentialCryptoBinding(key(10))
					.decrypt("account-1", encrypted),
			/browser credential decryption failed/,
		);
		await assert.rejects(
			() =>
				credentialCryptoModule
					.createCredentialCryptoBinding(key(9))
					.decrypt("account-2", encrypted),
			/browser credential decryption failed/,
		);
	});

	test("uses fixed safe errors for malformed encrypted data", async () => {
		const binding = credentialCryptoModule.createCredentialCryptoBinding(
			key(11),
		);
		const supplied = {
			version: 1,
			ciphertext: "private-ciphertext",
			nonce: "private-nonce",
			emailHash: "private-email-hash",
		} as EncryptedBrowserCredentials;
		const message = await errorText(() =>
			binding.decrypt("private-account", supplied),
		);

		for (const value of [
			"private-ciphertext",
			"private-nonce",
			"private-email-hash",
			"private-account",
		]) {
			assert.doesNotMatch(message, new RegExp(value));
		}
		assert.match(message, /browser credential decryption failed/);
	});

	test("requires an exact plain encrypted envelope with bounded canonical base64", async () => {
		const binding = credentialCryptoModule.createCredentialCryptoBinding(
			key(15),
		);
		const valid = await binding.encrypt("account-1", credentials);
		const envelopes: unknown[] = [
			[valid],
			{ ...valid, extra: "private-extra" },
			Object.assign(Object.create({ inherited: true }), valid),
			{ ...valid, nonce: Buffer.alloc(11).toString("base64") },
			{ ...valid, nonce: `${valid.nonce}\n` },
			{ ...valid, emailHash: noncanonicalBase64Alias(valid.emailHash) },
			{ ...valid, emailHash: Buffer.alloc(31).toString("base64") },
			{ ...valid, ciphertext: Buffer.alloc(15).toString("base64") },
			{ ...valid, ciphertext: Buffer.alloc(9000).toString("base64") },
		];
		for (const encrypted of envelopes) {
			const message = await errorText(() =>
				binding.decrypt("account-1", encrypted as EncryptedBrowserCredentials),
			);
			assert.equal(message, "Error: browser credential decryption failed");
			assert.doesNotMatch(message, /private-extra/);
		}
	});

	test("rejects authenticated JSON outside the exact canonical credential schema", async () => {
		const masterKey = key(16);
		const binding =
			credentialCryptoModule.createCredentialCryptoBinding(masterKey);
		const invalidPlaintexts = [
			"[]",
			"null",
			JSON.stringify({ ...credentials, extra: "private-extra" }),
			JSON.stringify({
				email: " User@Example.COM ",
				password: "p",
				totpSecret: "MY======",
			}),
			JSON.stringify({
				email: "user@example.com",
				password: "",
				totpSecret: "MY======",
			}),
			JSON.stringify({
				email: "user@example.com",
				password: "p",
				totpSecret: "ABC1",
			}),
			JSON.stringify({
				email: `${"a".repeat(309)}@example.com`,
				password: "p",
				totpSecret: "MY======",
			}),
			JSON.stringify({
				email: "user@example.com",
				password: "p".repeat(1025),
				totpSecret: "MY======",
			}),
			JSON.stringify({
				email: "user@example.com",
				password: "p",
				totpSecret: "A".repeat(257),
			}),
			'{"email":"user@example.com","password":"p","totpSecret":"MY======","__proto__":"private-proto"}',
			'{"email":"user@example.com","password":"p","totpSecret":"MY======","constructor":"private-constructor"}',
		];

		for (const plaintext of invalidPlaintexts) {
			const encrypted = await authenticatedEnvelope(
				masterKey,
				"account-1",
				plaintext,
			);
			const message = await errorText(() =>
				binding.decrypt("account-1", encrypted),
			);
			assert.equal(message, "Error: browser credential decryption failed");
			assert.doesNotMatch(message, /private-/);
		}
	});

	test("encrypt accepts only exact canonical credentials", async () => {
		const binding = credentialCryptoModule.createCredentialCryptoBinding(
			key(17),
		);
		for (const value of [
			{ ...credentials, email: " User@Example.COM " },
			{ ...credentials, totpSecret: "jbsw-y3dp ehpk3pxp" },
			{ ...credentials, extra: "private-extra" },
			Object.assign(Object.create({ inherited: true }), credentials),
		]) {
			const message = await errorText(() =>
				binding.encrypt("account-1", value as BrowserCredentials),
			);
			assert.equal(message, "Error: browser credential encryption failed");
			assert.doesNotMatch(message, /private-extra/);
		}
	});
});

describe("browser master key secret", () => {
	test("returns null when the secret file is absent", () => {
		assert.equal(
			secretsModule.readBrowserMasterKey(
				join(tmpdir(), `missing-web2gem-key-${crypto.randomUUID()}`),
			),
			null,
		);
	});

	test("accepts exactly 32 decoded bytes and trims one trailing newline", async () => {
		const directory = await mkdtemp(join(tmpdir(), "web2gem-secret-"));
		try {
			const path = join(directory, "master-key");
			const expected = key(12);
			await writeFile(path, `${Buffer.from(expected).toString("base64")}\r\n`);
			assert.deepEqual(secretsModule.readBrowserMasterKey(path), expected);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("fails safely for invalid existing secret files", async () => {
		const directory = await mkdtemp(join(tmpdir(), "web2gem-secret-"));
		try {
			for (const [index, value] of [
				Buffer.alloc(31).toString("base64"),
				`${Buffer.alloc(32).toString("base64")}garbage`,
				`${Buffer.alloc(32).toString("base64")}\n\n`,
				"not-base64-private-key",
			].entries()) {
				const path = join(directory, `master-key-${index}`);
				await writeFile(path, value);
				assert.throws(
					() => secretsModule.readBrowserMasterKey(path),
					/browser master key must decode to exactly 32 bytes/,
				);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("redacts unreadable secret paths and filesystem errors", () => {
		const privatePath = tmpdir();
		const message = (() => {
			try {
				secretsModule.readBrowserMasterKey(privatePath);
				return "";
			} catch (error) {
				return String(error);
			}
		})();
		assert.equal(message, "Error: browser master key could not be read");
		assert.doesNotMatch(message, new RegExp(privatePath));
	});
});
