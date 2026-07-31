export type BrowserCredentials = {
	email: string;
	password: string;
	totpSecret: string;
};

export type EncryptedBrowserCredentials = {
	version: 1;
	ciphertext: string;
	nonce: string;
	emailHash: string;
};

export type BrowserCredentialCrypto = {
	encrypt(
		accountId: string,
		credentials: BrowserCredentials,
	): Promise<EncryptedBrowserCredentials>;
	decrypt(
		accountId: string,
		encrypted: EncryptedBrowserCredentials,
	): Promise<BrowserCredentials>;
};
