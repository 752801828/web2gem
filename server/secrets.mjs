import { readFileSync } from "node:fs";

const DEFAULT_MASTER_KEY_PATH = "/run/secrets/web2gem_master_key";
const INVALID_MASTER_KEY =
	"browser master key must decode to exactly 32 bytes";
const UNREADABLE_MASTER_KEY = "browser master key could not be read";

export function readBrowserMasterKey(path = DEFAULT_MASTER_KEY_PATH) {
	let encoded;
	try {
		encoded = readFileSync(path, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw new Error(UNREADABLE_MASTER_KEY);
	}

	if (encoded.endsWith("\r\n")) encoded = encoded.slice(0, -2);
	else if (encoded.endsWith("\n")) encoded = encoded.slice(0, -1);

	if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
		throw new Error(INVALID_MASTER_KEY);
	}
	const key = Buffer.from(encoded, "base64");
	if (key.byteLength !== 32 || key.toString("base64") !== encoded) {
		throw new Error(INVALID_MASTER_KEY);
	}
	return new Uint8Array(key);
}
