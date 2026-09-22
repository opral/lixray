import { ErrorTracking } from "@posthog/core";
export interface RepositoryErrorFrame {
	platform: "web:javascript";
	filename: string;
	function?: string;
	lineno: number;
	colno: number;
	in_app: true;
	chunk_id?: string;
}

/** Asset locations only: exclude error messages, URL queries and page paths. */
export function sanitizeRepositoryErrorFrames(
	value: unknown,
): RepositoryErrorFrame[] {
	if (!Array.isArray(value)) return [];
	return value.slice(0, 8).flatMap((item: unknown) => {
		if (!item || typeof item !== "object") return [];
		const frame = item as Record<string, unknown>;
		if (
			typeof frame.filename !== "string" ||
			!/^\/assets\/[a-zA-Z0-9_.-]{1,150}\.m?js$/.test(frame.filename)
		)
			return [];
		if (
			typeof frame.lineno !== "number" ||
			!Number.isSafeInteger(frame.lineno) ||
			frame.lineno < 1 ||
			frame.lineno > 1_000_000
		)
			return [];
		if (
			typeof frame.colno !== "number" ||
			!Number.isSafeInteger(frame.colno) ||
			frame.colno < 0 ||
			frame.colno > 100_000_000
		)
			return [];
		const name =
			typeof frame.function === "string" &&
			/^[a-zA-Z0-9_$.[\]<> ]{1,80}$/.test(frame.function)
				? frame.function
				: undefined;
		return [
			{
				platform: "web:javascript" as const,
				filename: frame.filename,
				...(name ? { function: name } : {}),
				...(typeof frame.chunk_id === "string" &&
				/^[a-f0-9-]{36}$/i.test(frame.chunk_id)
					? { chunk_id: frame.chunk_id }
					: {}),
				lineno: frame.lineno,
				colno: frame.colno,
				in_app: true as const,
			},
		];
	});
}

const builder = new ErrorTracking.ErrorPropertiesBuilder(
	[
		new ErrorTracking.ErrorCoercer(),
		new ErrorTracking.ObjectCoercer(),
		new ErrorTracking.PrimitiveCoercer(),
	],
	ErrorTracking.createDefaultStackParser(),
);

export function repositoryErrorFrames(error: unknown): RepositoryErrorFrame[] {
	try {
		const exception = builder.buildFromUnknown(error).$exception_list[0];
		const frames = (exception?.stacktrace?.frames ?? [])
			.slice(-8)
			.map((frame) => {
				let filename = frame.filename;
				try {
					filename = new URL(filename ?? "").pathname;
				} catch {
					/* Already a relative path. */
				}
				return { ...frame, filename };
			});
		return sanitizeRepositoryErrorFrames(frames);
	} catch {
		return [];
	}
}
