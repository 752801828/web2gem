import { signal } from "@preact/signals";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, test } from "vitest";
import {
	BrowserCredentialsModal,
	createBrowserCredentialBuffer,
} from "../../../src/admin-ui/components/BrowserCredentialsModal";
import { AccountActions } from "../../../src/admin-ui/components/AccountActions";
import { updateAdminKey } from "../../../src/admin-ui/session";
import {
	browserCredentialsDraft,
	connectionVerified,
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
		const bufferA = createBrowserCredentialBuffer();
		const bufferB = createBrowserCredentialBuffer();
		const activeAccount = signal<"account-a" | "account-b">("account-a");
		const requestStarted = deferred();
		const requestResponse = deferred<Response>();
		const Harness = () => {
			const accountId = activeAccount.value;
			return h(BrowserCredentialsModal, {
				key: accountId,
				buffer: accountId === "account-a" ? bufferA : bufferB,
			});
		};

		await withPatchedGlobal("HTMLElement", FakeElement, () =>
			withPatchedGlobal("document", document, () =>
				withAdminEnvironment(
					async (path: RequestInfo | URL) => {
						if (String(path).endsWith("/browser/credentials")) {
							requestStarted.resolve();
							return requestResponse.promise;
						}
						return Response.json(uiAccountOverview());
					},
					async () => {
						updateAdminKey("admin-secret");
						connectionVerified.value = true;
						browserCredentialsDraft.value = {
							accountId: "account-a",
							accountLabel: "A",
							credentialsConfigured: false,
						};
						bufferA.values.email = "a@example.com";
						bufferA.values.password = "password-a";
						bufferA.values.totpSecret = "JBSWY3DPEHPK3PXP";
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
						form.dispatch("submit");
						await Promise.resolve();
						assert.equal(requestStarted.settled, true);
						await requestStarted.promise;

						browserCredentialsDraft.value = {
							accountId: "account-b",
							accountLabel: "B",
							credentialsConfigured: false,
						};
						activeAccount.value = "account-b";
						act(() => render(h(Harness, {}), root as unknown as Element));
						assert.deepEqual(bufferA.values, {
							email: "",
							password: "",
							totpSecret: "",
						});
						bufferB.values.email = "b@example.com";
						bufferB.values.password = "password-b";
						bufferB.values.totpSecret = "JBSWY3DPEHPK3PXP";
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
						await act(async () => {
							for (let index = 0; index < 20; index += 1) {
								if (!Object.hasOwn(rowBusy.value, "account-a")) return;
								await Promise.resolve();
							}
							throw new Error("credential save did not finish");
						});
						assert.equal(browserCredentialsDraft.value?.accountId, "account-b");
						assert.equal(bufferB.values.email, "b@example.com");
						act(() => render(null, root as unknown as Element));
						assert.deepEqual(bufferB.values, {
							email: "",
							password: "",
							totpSecret: "",
						});
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
