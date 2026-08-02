import { describe, test } from "vitest";
import { invalidateAdminSession } from "../../../src/admin-ui/session";
import {
	claimAccountOperation,
	emptyModelRoutingDrafts,
	releaseAccountOperation,
} from "../../../src/admin-ui/state";
import { assert } from "../assertions.js";
import { requiredValue, uiModelRouting } from "./_support/fixtures.js";

describe("admin UI state factories", () => {
	test("a stale claim owner cannot release a new session claim", () => {
		const stale = claimAccountOperation(["account-a"]);
		assert.equal(Boolean(stale), true);
		invalidateAdminSession();
		const current = claimAccountOperation(["account-a"]);
		assert.equal(Boolean(current), true);
		releaseAccountOperation(stale);
		assert.equal(claimAccountOperation(["account-a"]), null);
		releaseAccountOperation(current);
		assert.equal(Boolean(claimAccountOperation(["account-a"])), true);
		invalidateAdminSession();
	});
	test("creates independent model-routing drafts for every family and call", () => {
		const first = emptyModelRoutingDrafts();
		const second = emptyModelRoutingDrafts();
		first.pro.routes.push(
			requiredValue(requiredValue(uiModelRouting().families[0]).routes[0]),
		);
		first.flash.busy = true;

		assert.equal(first.pro === first.flash, false);
		assert.equal(first.pro.routes === first.flash.routes, false);
		assert.deepEqual(first.flash.routes, []);
		assert.deepEqual(second, {
			pro: { routes: [], busy: false, error: null, dirty: false },
			flash: { routes: [], busy: false, error: null, dirty: false },
			flash_lite: { routes: [], busy: false, error: null, dirty: false },
		});
	});
});
