import { timingSafeEqual, webcrypto } from "node:crypto";

const { subtle } = webcrypto;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const ENCRYPTION_FAILED = "browser credential encryption failed";
const DECRYPTION_FAILED = "browser credential decryption failed";
const CREDENTIAL_KEYS = ["email", "password", "totpSecret"];
const ENCRYPTED_KEYS = ["version", "ciphertext", "nonce", "emailHash"];
const MAX_EMAIL_BYTES = 320;
const MAX_PASSWORD_BYTES = 1024;
const MAX_TOTP_LENGTH = 256;
// JSON may expand each input byte to a six-byte escape, plus fixed fields and tag.
const MAX_CIPHERTEXT_BYTES =
	16 + 6 * (MAX_EMAIL_BYTES + MAX_PASSWORD_BYTES) + MAX_TOTP_LENGTH + 128;
const MAX_CIPHERTEXT_BASE64_LENGTH = Math.ceil(MAX_CIPHERTEXT_BYTES / 3) * 4;

export function createCredentialCryptoBinding(masterKey) {
	if (!(masterKey instanceof Uint8Array) || masterKey.byteLength !== 32) {
		throw new Error("browser master key must be exactly 32 bytes");
	}
	const keyBytes = new Uint8Array(masterKey);
	const keyPromise = subtle.importKey(
		"raw",
		keyBytes,
		"AES-GCM",
		false,
		["encrypt", "decrypt"],
	);

	return Object.freeze({
		async encrypt(accountId, credentials) {
			try {
				if (!validAccountId(accountId) || !isCanonicalCredentials(credentials)) {
					throw new Error(ENCRYPTION_FAILED);
				}
				const nonce = webcrypto.getRandomValues(new Uint8Array(12));
				const ciphertext = await subtle.encrypt(
					aesGcmParams(accountId, nonce),
					await keyPromise,
					encoder.encode(JSON.stringify(credentials)),
				);
				return {
					version: 1,
					ciphertext: Buffer.from(ciphertext).toString("base64"),
					nonce: Buffer.from(nonce).toString("base64"),
					emailHash: await hashEmail(credentials.email),
				};
			} catch {
				throw new Error(ENCRYPTION_FAILED);
			}
		},
		async decrypt(accountId, encrypted) {
			try {
				if (!validAccountId(accountId) || !isEncryptedEnvelope(encrypted)) {
					throw new Error(DECRYPTION_FAILED);
				}
				const nonce = decodeBase64(encrypted.nonce, 12);
				const ciphertext = decodeBase64(
					encrypted.ciphertext,
					undefined,
					MAX_CIPHERTEXT_BASE64_LENGTH,
				);
				const expectedHash = decodeBase64(encrypted.emailHash, 32);
				if (ciphertext.byteLength < 16) throw new Error(DECRYPTION_FAILED);
				const plaintext = await subtle.decrypt(
					aesGcmParams(accountId, nonce),
					await keyPromise,
					ciphertext,
				);
				const credentials = JSON.parse(decoder.decode(plaintext));
				if (!isCanonicalCredentials(credentials)) {
					throw new Error(DECRYPTION_FAILED);
				}
				const actualHash = decodeBase64(await hashEmail(credentials.email), 32);
				if (!timingSafeEqual(expectedHash, actualHash)) {
					throw new Error(DECRYPTION_FAILED);
				}
				return credentials;
			} catch {
				throw new Error(DECRYPTION_FAILED);
			}
		},
	});
}

function aesGcmParams(accountId, nonce) {
	return {
		name: "AES-GCM",
		iv: nonce,
		additionalData: encoder.encode(`web2gem:${accountId}:v1`),
		tagLength: 128,
	};
}

async function hashEmail(email) {
	const canonicalEmail = email.trim().toLowerCase();
	const digest = await subtle.digest("SHA-256", encoder.encode(canonicalEmail));
	return Buffer.from(digest).toString("base64");
}

function decodeBase64(value, expectedLength, maxEncodedLength = Infinity) {
	const expectedEncodedLength =
		expectedLength === undefined
			? undefined
			: Math.ceil(expectedLength / 3) * 4;
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maxEncodedLength ||
		(expectedEncodedLength !== undefined &&
			value.length !== expectedEncodedLength) ||
		value.length % 4 !== 0 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
			value,
		)
	) {
		throw new Error(DECRYPTION_FAILED);
	}
	const decoded = Buffer.from(value, "base64");
	if (
		decoded.toString("base64") !== value ||
		(expectedLength !== undefined && decoded.byteLength !== expectedLength)
	) {
		throw new Error(DECRYPTION_FAILED);
	}
	return decoded;
}

function validAccountId(value) {
	return typeof value === "string" && value.length > 0;
}

function isCanonicalCredentials(value) {
	return (
		hasExactKeys(value, CREDENTIAL_KEYS) &&
		typeof value.email === "string" &&
		value.email.length > 0 &&
		value.email === value.email.trim().toLowerCase() &&
		encoder.encode(value.email).byteLength <= MAX_EMAIL_BYTES &&
		typeof value.password === "string" &&
		value.password.length > 0 &&
		encoder.encode(value.password).byteLength <= MAX_PASSWORD_BYTES &&
		typeof value.totpSecret === "string" &&
		value.totpSecret.length <= MAX_TOTP_LENGTH &&
		isCanonicalBase32(value.totpSecret)
	);
}

function isEncryptedEnvelope(value) {
	return (
		hasExactKeys(value, ENCRYPTED_KEYS) &&
		value.version === 1 &&
		typeof value.ciphertext === "string" &&
		typeof value.nonce === "string" &&
		typeof value.emailHash === "string"
	);
}

function hasExactKeys(value, expectedKeys) {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		return false;
	}
	const keys = Object.keys(value);
	return (
		keys.length === expectedKeys.length &&
		expectedKeys.every((key) => Object.hasOwn(value, key))
	);
}

function isCanonicalBase32(value) {
	const match = /^([A-Z2-7]+)(=*)$/.exec(value);
	if (!match) return false;
	const dataLength = match[1]?.length ?? 0;
	const paddingLength = match[2]?.length ?? 0;
	const expectedPadding = new Map([
		[0, 0],
		[2, 6],
		[4, 4],
		[5, 3],
		[7, 1],
	]).get(dataLength % 8);
	return (
		expectedPadding !== undefined &&
		(paddingLength === 0 || paddingLength === expectedPadding)
	);
}
