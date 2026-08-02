import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, test } from "vitest";
import { AccountActions } from "../../../src/admin-ui/components/AccountActions";
import { BrowserCredentialsModal } from "../../../src/admin-ui/components/BrowserCredentialsModal";
import { updateAdminKey } from "../../../src/admin-ui/session";
import {
	browserCredentialsDraft,
	connectionVerified,
	loading,
	rowBusy,
} from "../../../src/admin-ui/state";
import { withPatchedGlobal } from "../_support/globals.js";
import { deferred } from "../_support/deferred.js";
import { assert } from "../assertions.js";
import { withAdminEnvironment } from "./_support/environment.js";
import { uiAccount, uiAccountOverview } from "./_support/fixtures.js";
import { resetAdminSessionState } from "./_support/state.js";

class FakeNode {
	parentNode: FakeElement | null = null;
	childNodes: FakeNode[] = [];
	ownerDocument: FakeDocument;
	constructor(
		readonly nodeType: number,
		document: FakeDocument,
	) {
		this.ownerDocument = document;
	}
	get firstChild(): FakeNode | null {
		return this.childNodes[0] || null;
	}
	insertBefore(child: FakeNode, reference: FakeNode | null): FakeNode {
		child.parentNode?.removeChild(child);
		child.parentNode = this as unknown as FakeElement;
		const index = reference ? this.childNodes.indexOf(reference) : -1;
		if (index < 0) this.childNodes.push(child);
		else this.childNodes.splice(index, 0, child);
		return child;
	}
	removeChild(child: FakeNode): FakeNode {
		const index = this.childNodes.indexOf(child);
		if (index >= 0) this.childNodes.splice(index, 1);
		child.parentNode = null;
		return child;
	}
}

class FakeText extends FakeNode {
	constructor(
		document: FakeDocument,
		public data: string,
	) {
		super(3, document);
	}
}

class FakeElement extends FakeNode {
	attributes = new Map<string, string>();
	listeners = new Map<string, EventListener>();
	oninput: ((event: Event) => void) | null = null;
	onsubmit: ((event: Event) => void) | null = null;
	value = "";
	name = "";
	spellcheck = true;
	checked = false;
	constructor(
		document: FakeDocument,
		readonly localName: string,
	) {
		super(1, document);
	}
	setAttribute(name: string, value: unknown): void {
		this.attributes.set(name, String(value));
	}
	removeAttribute(name: string): void {
		this.attributes.delete(name);
	}
	hasAttribute(name: string): boolean {
		return this.attributes.has(name);
	}
	addEventListener(name: string, listener: EventListener): void {
		this.listeners.set(name, listener);
	}
	removeEventListener(name: string): void {
		this.listeners.delete(name);
	}
	focus(): void {
		this.ownerDocument.activeElement = this;
	}
	querySelector<T extends FakeElement = FakeElement>(
		selector: string,
	): T | null {
		return this.querySelectorAll<T>(selector)[0] || null;
	}
	querySelectorAll<T extends FakeElement = FakeElement>(selector: string): T[] {
		const descendants = this.descendants();
		if (selector === "[data-dialog-initial]")
			return descendants.filter((item) =>
				item.attributes.has("data-dialog-initial"),
			) as T[];
		if (selector === "form")
			return descendants.filter((item) => item.localName === "form") as T[];
		if (selector === "input")
			return descendants.filter((item) => item.localName === "input") as T[];
		return descendants.filter((item) =>
			["button", "input", "select", "textarea", "a"].includes(item.localName),
		) as T[];
	}
	dispatch(name: string): void {
		this.listeners.get(name)?.call(this, {
			preventDefault() {},
			currentTarget: this,
			target: this,
			type: name,
		} as unknown as Event);
	}
	private descendants(): FakeElement[] {
		const result: FakeElement[] = [];
		for (const child of this.childNodes) {
			if (!(child instanceof FakeElement)) continue;
			result.push(child, ...child.descendants());
		}
		return result;
	}
}

class FakeDocument {
	activeElement: FakeElement | null = null;
	documentElement = new FakeElement(this, "html");
	createElement(name: string): FakeElement {
		return new FakeElement(this, name);
	}
	createElementNS(_namespace: string, name: string): FakeElement {
		return this.createElement(name);
	}
	createTextNode(value: string): FakeText {
		return new FakeText(this, value);
	}
	addEventListener(): void {}
	removeEventListener(): void {}
}

describe("browser credentials modal lifecycle", () => {
	afterEach(resetAdminSessionState);

	test("a keyed account switch wipes A while pending and preserves B", async () => {
		const document = new FakeDocument();
		const root = document.createElement("main");
		const requestStarted = deferred();
		const requestResponse = deferred<Response>();
		const reloadStarted = deferred();
		const reloadResponse = deferred<Response>();
		const credentialBodies: string[] = [];
		const Harness = () => {
			const draft = browserCredentialsDraft.value;
			return draft
				? h(BrowserCredentialsModal, { key: draft.accountId })
				: null;
		};

		await withPatchedGlobal("HTMLElement", FakeElement, () =>
			withPatchedGlobal("document", document, () =>
				withAdminEnvironment(
					async (path: RequestInfo | URL, init: RequestInit = {}) => {
						if (String(path).endsWith("/browser/credentials")) {
							credentialBodies.push(String(init.body));
							requestStarted.resolve();
							return requestResponse.promise;
						}
						reloadStarted.resolve();
						return reloadResponse.promise;
					},
					async () => {
						updateAdminKey("admin-secret");
						connectionVerified.value = true;
						browserCredentialsDraft.value = {
							accountId: "account-a",
							accountLabel: "A",
							credentialsConfigured: false,
						};
						act(() => render(h(Harness, {}), root as unknown as Element));
						const form = root.querySelector("form");
						if (!form) throw new Error("expected credentials form");
						assert.deepEqual([...form.listeners.keys()], ["submit"]);
						const inputs = root.querySelectorAll("input");
						assert.deepEqual(
							inputs.map((input) => input.name),
							["email", "password", "totpSecret"],
						);
						assert.equal(inputs[0]?.spellcheck, false);
						act(() => {
							const values = [
								"a@example.com",
								"password-a",
								"JBSWY3DPEHPK3PXP",
							];
							for (const [index, input] of inputs.entries()) {
								input.value = values[index] || "";
								input.dispatch("input");
							}
						});
						form.dispatch("submit");
						await Promise.resolve();
						assert.equal(requestStarted.settled, true);
						await requestStarted.promise;
						assert.deepEqual(JSON.parse(credentialBodies[0] || "null"), {
							email: "a@example.com",
							password: "password-a",
							totpSecret: "JBSWY3DPEHPK3PXP",
						});

						browserCredentialsDraft.value = {
							accountId: "account-b",
							accountLabel: "B",
							credentialsConfigured: false,
						};
						act(() => render(h(Harness, {}), root as unknown as Element));
						const inputsB = root.querySelectorAll("input");
						assert.deepEqual(
							inputsB.map((input) => input.value),
							["", "", ""],
						);
						act(() => {
							const values = [
								"b@example.com",
								"password-b",
								"JBSWY3DPEHPK3PXP",
							];
							for (const [index, input] of inputsB.entries()) {
								input.value = values[index] || "";
								input.dispatch("input");
							}
						});
						requestResponse.resolve(
							Response.json({
								credentialsConfigured: true,
								status: {
									state: "ready",
									lastCheckAtMs: 1,
									lastCookieUpdateAtMs: null,
									lastAutoLoginAtMs: null,
									failureCode: null,
								},
							}),
						);
						await reloadStarted.promise;
						await act(async () => {
							for (let index = 0; index < 20; index += 1) {
								if (!Object.hasOwn(rowBusy.value, "account-a")) return;
								await Promise.resolve();
							}
							throw new Error("credential save did not finish");
						});
						assert.equal(browserCredentialsDraft.value?.accountId, "account-b");
						assert.deepEqual(
							root.querySelectorAll("input").map((input) => input.value),
							["b@example.com", "password-b", "JBSWY3DPEHPK3PXP"],
						);
						assert.equal(loading.value, true);
						reloadResponse.resolve(Response.json(uiAccountOverview()));
						await act(async () => {
							for (let index = 0; index < 20 && loading.value; index += 1)
								await Promise.resolve();
						});
						assert.equal(loading.value, false);
						act(() => render(null, root as unknown as Element));
					},
				),
			),
		);
	});

	test("account action labels identify the mounted account", async () => {
		const document = new FakeDocument();
		const root = document.createElement("main");
		await withPatchedGlobal("HTMLElement", FakeElement, () =>
			withPatchedGlobal("document", document, () => {
				act(() =>
					render(
						h(AccountActions, {
							account: uiAccount({ label: "Primary" }),
						}),
						root as unknown as Element,
					),
				);
				const buttons = root.querySelectorAll("button");
				assert.equal(buttons.length, 9);
				for (const button of buttons) {
					const label = button.attributes.get("aria-label") || "";
					assert.equal(label.includes("Primary"), true);
				}
				act(() => render(null, root as unknown as Element));
			}),
		);
	});
});
