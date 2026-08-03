import { readFile } from "node:fs/promises";
import { describe, test } from "vitest";
import { assert } from "../assertions.js";

async function source(path: string): Promise<string> {
	return readFile(path, "utf8");
}

describe("admin workspace layout", () => {
	test("owns the collapsed account import disclosure", async () => {
		const [app, overview, workspace] = await Promise.all([
			source("src/admin-ui/app.tsx"),
			source("src/admin-ui/sections/OverviewSection.tsx"),
			source("src/admin-ui/sections/Workspace.tsx"),
		]);
		assert.doesNotMatch(app, /<ImportPanel\s*\/>/);
		assert.doesNotMatch(overview, /importExpanded|Import accounts/);
		assert.match(workspace, /<ImportPanel\s*\/>/);
		assert.match(workspace, /aria-controls="import-panel"/);
		assert.match(workspace, /tr\("Add accounts"\)/);
	});

	test("floats row action popovers above the workspace", async () => {
		const [component, css] = await Promise.all([
			source("src/admin-ui/components/AccountActions.tsx"),
			source("src/admin-ui/styles/components.css"),
		]);
		assert.match(
			component,
			/class="action-menu-items account-action-popover"[\s\S]*popover="auto"/,
		);
		assert.match(css, /\.account-action-popover\s*\{[^}]*position:\s*fixed/s);
	});
});
