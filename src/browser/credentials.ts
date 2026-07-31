import type {
	BrowserCredentialCrypto,
	BrowserCredentials,
	EncryptedBrowserCredentials,
} from "./types";

const encoder = new TextEncoder();
const INVALID_CREDENTIALS = "browser credentials are invalid";

export function validateBrowserCredentials(input: unknown): BrowserCredentials {
	if (!isRecord(input)) throw new TypeError(INVALID_CREDENTIALS);
	const { email, password, totpSecret } = input;
	if (
		typeof email !== "string" ||
		typeof password !== "string" ||
		typeof totpSecret !== "string"
	) {
		throw new TypeError(INVALID_CREDENTIALS);
	}

	const normalizedEmail = email.trim().toLowerCase();
	const normalizedTotpSecret = totpSecret.replace(/[ -]/g, "").toUpperCase();
	if (
		!normalizedEmail ||
		encoder.encode(normalizedEmail).byteLength > 320 ||
		!password ||
		encoder.encode(password).byteLength > 1024 ||
		normalizedTotpSecret.length > 256 ||
		!isCanonicalBase32(normalizedTotpSecret)
	) {
		throw new TypeError(INVALID_CREDENTIALS);
	}

	return {
		email: normalizedEmail,
		password,
		totpSecret: normalizedTotpSecret,
	};
}

export async function encryptBrowserCredentials(
	binding: BrowserCredentialCrypto,
	accountId: string,
	input: unknown,
): Promise<EncryptedBrowserCredentials> {
	return binding.encrypt(accountId, validateBrowserCredentials(input));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalBase32(value: string): boolean {
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
	if (expectedPadding === undefined) return false;
	return paddingLength === 0 || paddingLength === expectedPadding;
}
