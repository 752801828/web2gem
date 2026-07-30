import { describe, test } from "vitest";
import { uploadMultipartFile } from "../../../../src/gemini/uploads/multipart";
import { assert } from "../../assertions.js";
import { withFetch } from "../../_support/globals.js";
import { createMemoryCache, withCaches } from "../_support/cache.js";
import {
	assertMultipartRequest,
	baseUploadConfig,
	createUploadFetchRouter,
	resetUploadState,
	seedCachedPushId,
} from "./_support/upload-fixtures.js";

describe("multipart upload bodies", () => {
	test("writes exact bytes through a standard readable stream", async () => {
		const cfg = baseUploadConfig({ cookie: "__Secure-1PSID=psid" });
		const cache = createMemoryCache();
		await seedCachedPushId(cache, cfg, "push-multipart");
		const router = createUploadFetchRouter({
			contentPush: async (init) => {
				await assertMultipartRequest(init, {
					filename: "bad_name.txt",
					mime: "text/plain",
					bodyText: "ABC",
					pushId: "push-multipart",
				});
				return new Response("/uploaded/multipart-ref", { status: 200 });
			},
		});

		await withCaches(cache, async () => {
			await withFetch(router.fetch, async () => {
				resetUploadState();
				assert.equal(
					await uploadMultipartFile(cfg, {
						bytes: new Uint8Array([65, 66, 67]),
						mime: " text/plain\r\n ",
						filename: 'bad"name.txt',
					}),
					"/uploaded/multipart-ref",
				);
			});
		});

		assert.deepEqual(router.requests, [
			"https://content-push.googleapis.com/upload",
		]);
	});
});
