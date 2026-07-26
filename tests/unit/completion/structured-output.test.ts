import { describe, test } from "vitest";
import {
	buildStructuredOutputRequirement,
	finalizeStructuredOutputText,
	getStructuredResponseFormat,
} from "../../../src/completion/structured-output";
import { assert } from "../assertions.js";

describe("structured output", () => {
	test("builds requirements from Chat and Responses format shapes", async () => {
		assert.equal(
			getStructuredResponseFormat({
				text: { format: { type: "json_object" } },
			})?.type,
			"json_object",
		);
		assert.equal(getStructuredResponseFormat(null), null);
		assert.equal(buildStructuredOutputRequirement({}), null);
		assert.equal(
			buildStructuredOutputRequirement({ type: "unsupported" }),
			null,
		);

		const defaulted = buildStructuredOutputRequirement({
			type: "json_schema",
			name: " ",
			schema: { type: "object" },
		});
		if (defaulted?.type !== "json_schema") {
			throw new Error("expected a json_schema requirement");
		}
		assert.match(defaulted.instruction, /Schema name: response/);
		assert.match(defaulted.instruction, /Strict mode: true/);
		const invalid = buildStructuredOutputRequirement({
			type: "json_schema",
			json_schema: { name: "bad" },
		});
		if (!invalid || !("error" in invalid)) {
			throw new Error("expected an invalid schema requirement");
		}
		assert.equal(
			invalid.error,
			"response_format json_schema requires a schema object",
		);

		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const unserializable = buildStructuredOutputRequirement({
			type: "json_schema",
			json_schema: { schema: cyclic },
		});
		if (!unserializable || !("error" in unserializable)) {
			throw new Error("expected an unserializable schema requirement");
		}
		assert.equal(
			unserializable.error,
			"response_format json_schema schema must be JSON serializable",
		);
	});

	test("finalizes JSON documents extracted from noisy model text", async () => {
		// Public finalizer covers embedded / nested / fenced JSON candidates.
		assert.deepEqual(
			finalizeStructuredOutputText('prefix [1,{"a":"}"}] suffix', {
				type: "json_object",
			}),
			{
				text: '[1,{"a":"}"}]',
				error: "structured output must be a JSON object",
			},
		);
		assert.deepEqual(
			finalizeStructuredOutputText('prefix [{"ok":true} } suffix', {
				type: "json_object",
			}),
			{
				text: '{"ok":true}',
			},
		);
		assert.equal(
			finalizeStructuredOutputText('prefix {"a":] suffix', {
				type: "json_object",
			}).error,
			"structured output was not valid JSON",
		);
		assert.equal(
			finalizeStructuredOutputText("{{{{", { type: "json_object" }).error,
			"structured output was not valid JSON",
		);
		assert.deepEqual(
			finalizeStructuredOutputText('prefix {"ok":true} suffix', {
				type: "json_object",
			}),
			{ text: '{"ok":true}' },
		);
		assert.deepEqual(
			finalizeStructuredOutputText('```json\n{"ok":true}\n```', {
				type: "json_object",
			}),
			{ text: '{"ok":true}' },
		);
		assert.equal(
			finalizeStructuredOutputText("no json here", { type: "json_object" })
				.error,
			"structured output was not valid JSON",
		);
	});

	test("canonicalizes and finalizes schema output", async () => {
		const requirement = buildStructuredOutputRequirement({
			type: "json_schema",
			name: "loose_result",
			strict: false,
			schema: { type: "object", properties: { ok: { type: "boolean" } } },
		});
		if (requirement?.type !== "json_schema") {
			throw new Error("expected a json_schema requirement");
		}
		assert.match(requirement.instruction, /Schema name: loose_result/);
		assert.match(requirement.instruction, /Strict mode: false/);
		// Without a requirement the finalizer returns the raw text unchanged.
		assert.deepEqual(finalizeStructuredOutputText(" raw ", null), {
			text: " raw ",
		});
		assert.deepEqual(
			finalizeStructuredOutputText('prefix {"ok":true} suffix', requirement),
			{ text: '{"ok":true}' },
		);
		assert.match(
			finalizeStructuredOutputText('prefix {"ok":true} suffix', {
				type: "json_schema",
				schema: { allOf: [{ type: "object" }, { required: ["missing"] }] },
			}).error,
			/\.missing is required/,
		);
		assert.equal(
			finalizeStructuredOutputText("not json", requirement).error,
			"structured output was not valid JSON",
		);
	});

	test("validates json_object and delegates representative JSON schemas", async () => {
		assert.deepEqual(finalizeStructuredOutputText("{}", null), { text: "{}" });
		assert.equal(
			finalizeStructuredOutputText('"nope"', { type: "json_object" }).error,
			"structured output must be a JSON object",
		);
		assert.deepEqual(
			finalizeStructuredOutputText('{"ok":true}', {
				type: "json_schema",
				schema: {
					type: "object",
					required: ["ok"],
					properties: { ok: { type: "boolean" } },
				},
			}),
			{ text: '{"ok":true}' },
		);
	});
});
