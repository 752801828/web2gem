import { mkdir, rm } from "node:fs/promises";
import esbuild from "esbuild";
import { buildAdminUi } from "./build-admin-ui.mjs";

const { html: adminUiHtml } = await buildAdminUi();

const includeHarnessBundle =
	process.argv.includes("--harness-bundle") ||
	/^(1|true|yes|on)$/i.test(process.env.BUILD_HARNESS_BUNDLE || "");
const outDir = process.env.BUILD_DIR || "dist";

await mkdir(outDir, { recursive: true });

await Promise.all([
	rm(`${outDir}/app.js.map`, { force: true }),
	rm(`${outDir}/harness.js`, { force: true }),
	rm(`${outDir}/harness.js.map`, { force: true }),
]);

const common = {
	bundle: true,
	format: "esm",
	target: "es2025",
	platform: "node",
	sourcemap: false,
	legalComments: "none",
	define: {
		__WEB2GEM_ADMIN_UI_HTML__: JSON.stringify(adminUiHtml),
	},
	logLevel: "info",
};

await esbuild.build({
	...common,
	entryPoints: ["src/index.ts"],
	outfile: `${outDir}/app.js`,
});

if (includeHarnessBundle) {
	await esbuild.build({
		...common,
		entryPoints: ["src/harness-exports.ts"],
		outfile: `${outDir}/harness.js`,
	});
}
