import { describe, test } from "vitest";
import { assert } from "../assertions.js";

const modulePath: string = "../../../browser-helper/novnc-clipboard.mjs";
const { copyRemoteClipboard, pasteLocalClipboard } = await import(modulePath);

describe("noVNC clipboard bridge", () => {
	test("moves text in both directions and leaves a keyboard fallback", async () => {
		const textarea = {
			value: "remote text",
			focused: 0,
			selected: 0,
			focus() {
				this.focused += 1;
			},
			select() {
				this.selected += 1;
			},
		};
		let sent = "";
		let copied = "";
		assert.equal(
			await pasteLocalClipboard(
				{ readText: async () => "local text" },
				textarea,
				(text: string) => {
					sent = text;
				},
			),
			true,
		);
		assert.equal(textarea.value, "local text");
		assert.equal(sent, "local text");
		assert.equal(
			await copyRemoteClipboard(
				{
					writeText: async (text: string) => {
						copied = text;
					},
				},
				textarea,
			),
			true,
		);
		assert.equal(copied, "local text");

		assert.equal(await copyRemoteClipboard({}, textarea), false);
		assert.equal(textarea.focused, 1);
		assert.equal(textarea.selected, 1);
	});
});
