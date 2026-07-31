import { timingSafeEqual, webcrypto } from "node:crypto";

const { subtle } = webcrypto;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const ENCRYPTION_FAILED = "browser credential encryption failed";
const DECRYPTION_FAILED = "browser credential decryption failed";

export function createCredentialCryptoBinding(masterKey) {
	if (!(masterKey instanceof Uint8Array) || masterKey.byteLength !== 32) {
		throw new Error("browser master key must be exactly 32 bytes");
	}
	const keyPromise = subtle.importKey(
		"raw",
		new Uint8Array(masterKey),
		"AES-GCM",
		false,
		["encrypt", "decrypt"],
	);

	return Object.freeze({
		async encrypt(accountId, credentials) {
			try {
				if (!validAccountId(accountId) || !isCredentials(credentials)) {
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
				if (!validAccountId(accountId) || !isEncryptedCredentials(encrypted)) {
					throw new Error(DECRYPTION_FAILED);
				}
				const nonce = decodeBase64(encrypted.nonce, 12);
				const ciphertext = decodeBase64(encrypted.ciphertext);
				const expectedHash = decodeBase64(encrypted.emailHash, 32);
				if (ciphertext.byteLength < 16) throw new Error(DECRYPTION_FAILED);
				const plaintext = await subtle.decrypt(
					aesGcmParams(accountId, nonce),
					await keyPromise,
					ciphertext,
				);
				const credentials = JSON.parse(decoder.decode(plaintext));
				if (!isCredentials(credentials)) throw new Error(DECRYPTION_FAILED);
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

function decodeBase64(value, expectedLength) {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
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

function isCredentials(value) {
	return (
		value !== null &&
		typeof value === "object" &&
		typeof value.email === "string" &&
		typeof value.password === "string" &&
		typeof value.totpSecret === "string"
	);
}

function isEncryptedCredentials(value) {
	return (
		value !== null &&
		typeof value === "object" &&
		value.version === 1 &&
		typeof value.ciphertext === "string" &&
		typeof value.nonce === "string" &&
		typeof value.emailHash === "string"
	);
}
