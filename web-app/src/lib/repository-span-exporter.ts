import { ExportResultCode } from "@opentelemetry/core";
import type { SpanExporter, ReadableSpan } from "@opentelemetry/sdk-trace-base";

/** A batch may contain a cancelled old repository and a new one. Authorize each independently. */
export function createRepositorySpanExporter(
	create: (repositoryId: string | null) => SpanExporter,
	fallback: () => string | null,
): SpanExporter {
	const pending = new Set<SpanExporter>();
	return {
		export(spans, callback) {
			const groups = new Map<string | null, ReadableSpan[]>();
			for (const span of spans) {
				const id = span.attributes["lix.id"];
				const key = typeof id === "string" ? id : fallback();
				const group = groups.get(key) ?? [];
				group.push(span);
				groups.set(key, group);
			}
			if (!groups.size) {
				callback({ code: ExportResultCode.SUCCESS });
				return;
			}
			let remaining = groups.size;
			let failure: Error | undefined;
			for (const [id, group] of groups) {
				const exporter = create(id);
				pending.add(exporter);
				exporter.export(group, (result) => {
					if (result.code !== ExportResultCode.SUCCESS)
						failure ??=
							result.error ?? new Error("Repository span export failed");
					pending.delete(exporter);
					void exporter.shutdown().catch(() => undefined);
					if (--remaining === 0)
						callback(
							failure
								? { code: ExportResultCode.FAILED, error: failure }
								: { code: ExportResultCode.SUCCESS },
						);
				});
			}
		},
		async shutdown() {
			await Promise.all([...pending].map((exporter) => exporter.shutdown()));
		},
	};
}
