import { describe, test } from "vitest";
import { uploadMultipartFile } from "../../../../src/gemini/uploads/multipart";
import { assert } from "../../assertions.js";
import { withFetch, withPatchedGlobal } from "../../_support/globals.js";
import { createMemoryCache, withCaches } from "../_support/cache.js";
import {
	assertMultipartRequest,
	baseUploadConfig,
	createUploadFetchRouter,
	resetUploadState,
	seedCachedPushId,
} from "./_support/upload-fixtures.js";

describe("multipart upload bodies", () => {
	test("writes exact bytes through FixedLengthStream", async () => {
		const lengths: number[] = [];
		class FakeFixedLengthStream {
			readonly readable: ReadableStream<Uint8Array>;
			readonly writable: WritableStream<Uint8Array>;

			constructor(length: number) {
				lengths.push(length);
				const stream = new TransformStream<Uint8Array, Uint8Array>();
				this.readable = stream.readable;
				this.writable = stream.writable;
			}
		}

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

		await withPatchedGlobal(
			"FixedLengthStream",
			FakeFixedLengthStream,
			async () => {
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
			},
		);

		assert.equal(lengths.length, 1);
		assert.equal((lengths[0] || 0) > 0, true);
		assert.deepEqual(router.requests, [
			"https://content-push.googleapis.com/upload",
		]);
	});

	test("uses a readable stream fallback with the same content shape", async () => {
		const cfg = baseUploadConfig({ cookie: "__Secure-1PSID=psid" });
		const cache = createMemoryCache();
		await seedCachedPushId(cache, cfg, "push-multipart");
		const router = createUploadFetchRouter({
			contentPush: async (init) => {
				await assertMultipartRequest(init, {
					filename: "bad_name.txt",
					mime: "text/plain",
					bodyText: "XYZ",
					pushId: "push-multipart",
				});
				return new Response("/uploaded/multipart-ref", { status: 200 });
			},
		});

		await withPatchedGlobal("FixedLengthStream", undefined, async () => {
			await withCaches(cache, async () => {
				await withFetch(router.fetch, async () => {
					resetUploadState();
					assert.equal(
						await uploadMultipartFile(cfg, {
							bytes: new Uint8Array([88, 89, 90]),
							mime: "text/plain",
							filename: 'bad"name.txt',
						}),
						"/uploaded/multipart-ref",
					);
				});
			});
		});

		assert.deepEqual(router.requests, [
			"https://content-push.googleapis.com/upload",
		]);
	});
});
