// Regenerate with: pnpm --dir web-app exec node scripts/generate-otlp-schema.mjs
// Official OpenTelemetry protobuf definitions, Apache-2.0 licensed:
// https://github.com/open-telemetry/opentelemetry-proto/blob/v1.9.0/LICENSE
// Only the trace service and its three imported schemas are included.
import { writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";

const revision = "a8951735f7801e8adfaec5c0ace9262771cfec6e"; // v1.9.0
const base = `https://raw.githubusercontent.com/open-telemetry/opentelemetry-proto/${revision}/`;
const files = [
	"opentelemetry/proto/common/v1/common.proto",
	"opentelemetry/proto/resource/v1/resource.proto",
	"opentelemetry/proto/trace/v1/trace.proto",
	"opentelemetry/proto/collector/trace/v1/trace_service.proto",
];
const root = new protobuf.Root();
for (const file of files) {
	const response = await fetch(new URL(file, base));
	if (!response.ok) throw new Error(`Cannot fetch ${file}: ${response.status}`);
	protobuf.parse(await response.text(), root);
}
root.resolveAll();
const license = await fetch(new URL("LICENSE", base));
if (!license.ok)
	throw new Error(`Cannot fetch schema license: ${license.status}`);
await writeFile(
	new URL("../src/worker/otlp-traces.LICENSE", import.meta.url),
	await license.text(),
);
await writeFile(
	new URL("../src/worker/otlp-traces.schema.json", import.meta.url),
	JSON.stringify(
		{
			_source: `Generated from open-telemetry/opentelemetry-proto ${revision} (v1.9.0); Apache-2.0. Regenerate with scripts/generate-otlp-schema.mjs.`,
			...root.toJSON(),
		},
		null,
		2,
	) + "\n",
);
execFileSync(
	"pnpm",
	["exec", "oxfmt", "--write", "src/worker/otlp-traces.schema.json"],
	{
		cwd: fileURLToPath(new URL("..", import.meta.url)),
		stdio: "inherit",
	},
);
