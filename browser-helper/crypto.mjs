import {
	createDecipheriv,
	createHash,
	createHmac,
	timingSafeEqual,
} from "node:crypto";

const DECRYPTION_FAILED = "browser credential decryption failed";
const INVALID_MASTER_KEY = "browser master key is invalid";
const INVALID_TOTP = "TOTP secret is invalid";
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_CIPHERTEXT_BYTES = 16 + 6 * (320 + 1_024) + 256 + 128;
const MAX_CIPHERTEXT_BASE64 = Math.ceil(MAX_CIPHERTEXT_BYTES / 3) * 4;

export function decodeBrowserMasterKey(encoded) {
	try {
		if (typeof encoded !== "string") throw new Error(INVALID_MASTER_KEY);
		const value = encoded.endsWith("\r\n")
			? encoded.slice(0, -2)
			: encoded.endsWith("\n")
				? encoded.slice(0, -1)
				: encoded;
		return decodeBase64(value, 32);
	} catch {
		throw new Error(INVALID_MASTER_KEY);
	}
}

export function decryptBrowserCredentials(masterKey, accountId, envelope) {
	try {
		const key = Buffer.from(masterKey);
		if (key.byteLength !== 32 || typeof accountId !== "string" || !accountId)
			throw new Error(DECRYPTION_FAILED);
		if (
			!exactKeys(envelope, ["version", "ciphertext", "nonce", "emailHash"]) ||
			envelope.version !== 1
		)
			throw new Error(DECRYPTION_FAILED);
		const nonce = decodeBase64(envelope.nonce, 12);
		const encrypted = decodeBase64(
			envelope.ciphertext,
			undefined,
			MAX_CIPHERTEXT_BASE64,
		);
		const expectedEmailHash = decodeBase64(envelope.emailHash, 32);
		if (encrypted.byteLength < 16) throw new Error(DECRYPTION_FAILED);
		const ciphertext = encrypted.subarray(0, -16);
		const decipher = createDecipheriv("aes-256-gcm", key, nonce);
		decipher.setAAD(Buffer.from(`web2gem:${accountId}:v1`));
		decipher.setAuthTag(encrypted.subarray(-16));
		const plaintext = Buffer.concat([
			decipher.update(ciphertext),
			decipher.final(),
		]);
		const credentials = JSON.parse(utf8Decoder.decode(plaintext));
		if (!validCredentials(credentials)) throw new Error(DECRYPTION_FAILED);
		const actualEmailHash = createHash("sha256")
			.update(credentials.email)
			.digest();
		if (!timingSafeEqual(expectedEmailHash, actualEmailHash))
			throw new Error(DECRYPTION_FAILED);
		return credentials;
	} catch {
		throw new Error(DECRYPTION_FAILED);
	}
}

export function totp(secret, unixSeconds) {
	try {
		if (
			!Number.isSafeInteger(unixSeconds) ||
			unixSeconds < 0 ||
			typeof secret !== "string"
		)
			throw new Error(INVALID_TOTP);
		const counter = Buffer.alloc(8);
		counter.writeBigUInt64BE(BigInt(Math.floor(unixSeconds / 30)));
		const digest = createHmac("sha1", decodeBase32(secret))
			.update(counter)
			.digest();
		const offset = digest[19] & 0x0f;
		const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
		return String(value).padStart(6, "0");
	} catch {
		throw new Error(INVALID_TOTP);
	}
}

export function totpCandidates(
	secret,
	unixSeconds,
	{ serverDate, maxClockSkewSec = 120 } = {},
) {
	if (
		!Number.isSafeInteger(maxClockSkewSec) ||
		maxClockSkewSec < 0 ||
		maxClockSkewSec > 300
	)
		throw new Error("browser clock skew limit is invalid");
	if (serverDate !== undefined && serverDate !== null) {
		const serverMs = Date.parse(serverDate);
		if (!Number.isFinite(serverMs))
			throw new Error("browser server date is invalid");
		if (Math.abs(unixSeconds - serverMs / 1_000) > maxClockSkewSec)
			throw new Error("browser clock is not synchronized");
	}
	return [
		totp(secret, unixSeconds - 30),
		totp(secret, unixSeconds),
		totp(secret, unixSeconds + 30),
	];
}

function decodeBase32(value) {
	if (!canonicalBase32(value)) throw new Error(INVALID_TOTP);
	const data = value.replace(/=+$/, "");
	const output = Buffer.alloc(Math.floor((data.length * 5) / 8));
	let accumulator = 0;
	let bits = 0;
	let index = 0;
	for (const character of data) {
		const digit = BASE32.indexOf(character);
		if (digit < 0) throw new Error(INVALID_TOTP);
		accumulator = (accumulator << 5) | digit;
		bits += 5;
		if (bits >= 8) {
			bits -= 8;
			output[index++] = (accumulator >>> bits) & 0xff;
			accumulator &= (1 << bits) - 1;
		}
	}
	if (!output.length) throw new Error(INVALID_TOTP);
	return output;
}

function canonicalBase32(value) {
	if (typeof value !== "string" || value.length > 256) return false;
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

function decodeBase64(value, expectedLength, maxLength = Number.MAX_SAFE_INTEGER) {
	const expectedEncoded =
		expectedLength === undefined ? undefined : Math.ceil(expectedLength / 3) * 4;
	if (
		typeof value !== "string" ||
		!value ||
		value.length > maxLength ||
		value.length % 4 !== 0 ||
		(expectedEncoded !== undefined && value.length !== expectedEncoded) ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
			value,
		)
	)
		throw new Error(DECRYPTION_FAILED);
	const decoded = Buffer.from(value, "base64");
	if (
		decoded.toString("base64") !== value ||
		(expectedLength !== undefined && decoded.byteLength !== expectedLength)
	)
		throw new Error(DECRYPTION_FAILED);
	return decoded;
}

function validCredentials(value) {
	return (
		exactKeys(value, ["email", "password", "totpSecret"]) &&
		typeof value.email === "string" &&
		value.email.length > 0 &&
		value.email === value.email.trim().toLowerCase() &&
		Buffer.byteLength(value.email) <= 320 &&
		typeof value.password === "string" &&
		value.password.length > 0 &&
		Buffer.byteLength(value.password) <= 1_024 &&
		typeof value.totpSecret === "string" &&
		value.totpSecret.length <= 256 &&
		canonicalBase32(value.totpSecret)
	);
}

function exactKeys(value, keys) {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	)
		return false;
	const actual = Object.keys(value);
	return (
		actual.length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key))
	);
}
