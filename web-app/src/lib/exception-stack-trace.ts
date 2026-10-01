import { sanitizeTelemetryDiagnostic } from "./telemetry-privacy.ts";

export interface ApplicationExceptionFrame {
	platform: "web:javascript";
	filename: string;
	function?: string;
	lineno: number;
	colno: number;
	in_app: true;
}

export interface SafeRustErrorOrigin {
	kind: "source_location";
	file: string;
	line: number;
	column?: number;
}

export interface LocatedRustErrorOrigin {
	origin: SafeRustErrorOrigin;
	/** Zero-based index in the bounded Error.cause chain; absent for the primary error. */
	causeIndex?: number;
	rustStacktraceStatus?: RustStacktraceStatus;
}

export type RustStacktraceStatus = "not_captured";

const MAX_EXCEPTION_CAUSES = 4;
const MAX_EXCEPTION_FRAMES = 8;
const SAFE_ASSET_PATH = /^\/assets\/[a-zA-Z0-9_.-]{1,150}\.m?js$/;
const SAFE_SOURCE_PATH =
	/^\/src\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:[cm]?[jt]sx?)$/;
const SAFE_FUNCTION =
	/^(?:<anonymous>|[a-zA-Z_$][a-zA-Z0-9_$]*(?:\.(?:<anonymous>|[a-zA-Z_$][a-zA-Z0-9_$]*))*(?:\[\d+\])*)$/;

/** Parse only app bundle locations. Raw stack text never leaves the caller. */
export function applicationExceptionFrames(
	stack: unknown,
	name?: unknown,
	message?: unknown,
): ApplicationExceptionFrame[] {
	if (typeof stack !== "string") return [];
	const frames: ApplicationExceptionFrame[] = [];
	const seen = new Set<string>();
	const stackWithoutHeader = stripExceptionHeader(stack, name, message);
	if (typeof stackWithoutHeader !== "string") return [];
	for (const sourceLine of stackWithoutHeader.split(/\r?\n/).slice(0, 80)) {
		const parsed = parseFrameLine(sourceLine);
		if (!parsed || seen.has(parsed.key)) continue;
		seen.add(parsed.key);
		frames.push(parsed.frame);
		if (frames.length >= MAX_EXCEPTION_FRAMES) break;
	}
	return frames;
}

/** Re-encode approved locations as a stack-shaped string for OTLP attributes. */
export function safeApplicationStacktrace(
	stack: unknown,
	name?: unknown,
	message?: unknown,
): string | undefined {
	const frames = applicationExceptionFrames(stack, name, message);
	if (frames.length === 0) return undefined;
	return frames
		.map((frame) => {
			const location = `${frame.filename}:${frame.lineno}:${frame.colno}`;
			return frame.function
				? `    at ${frame.function} (${location})`
				: `    at ${location}`;
		})
		.join("\n");
}

/** Create bounded OTel exception fields, including a short cause chain. */
export function applicationExceptionAttributes(
	error: unknown,
): Record<string, string> {
	const chain: unknown[] = [];
	const seen = new Set<object>();
	let current = error;
	for (
		let depth = 0;
		depth <= MAX_EXCEPTION_CAUSES && current != null;
		depth++
	) {
		if (typeof current === "object" || typeof current === "function") {
			const identity = current as object;
			if (seen.has(identity)) break;
			seen.add(identity);
		}
		chain.push(current);
		current = causeOf(current);
	}
	if (chain.length === 0) return {};

	const nativeError = isNativeCodedError(chain[0]);
	const fields: Record<string, string> = {};
	const primary = exceptionFields(chain[0]);
	if (primary.type) fields["exception.type"] = primary.type;
	if (primary.message) fields["exception.message"] = primary.message;
	if (primary.stacktrace) fields["exception.stacktrace"] = primary.stacktrace;
	const locatedOrigin = safeRustErrorOriginInCauseChain(error);
	if (locatedOrigin) {
		fields["exception.rust_origin.kind"] = locatedOrigin.origin.kind;
		fields["exception.rust_origin.file"] = locatedOrigin.origin.file;
		fields["exception.rust_origin.line"] = String(locatedOrigin.origin.line);
		if (locatedOrigin.origin.column !== undefined)
			fields["exception.rust_origin.column"] = String(
				locatedOrigin.origin.column,
			);
		if (locatedOrigin.causeIndex !== undefined)
			fields["exception.rust_origin.cause_index"] = String(
				locatedOrigin.causeIndex,
			);
	}
	const rustStacktraceStatus = rustStacktraceStatusInChain(chain);
	if (rustStacktraceStatus)
		fields["exception.rust_stacktrace_status"] = rustStacktraceStatus;
	const causes = chain.slice(1);
	if (causes.length > 0)
		fields["exception.cause.count"] = String(causes.length);
	causes.forEach((cause, index) => {
		const detail = exceptionFields(cause, nativeError);
		const prefix = `exception.cause.${index}`;
		if (detail.type) fields[`${prefix}.type`] = detail.type;
		if (detail.message) fields[`${prefix}.message`] = detail.message;
		if (detail.stacktrace) fields[`${prefix}.stacktrace`] = detail.stacktrace;
	});
	return fields;
}

export function safeLixErrorCode(value: unknown): string | undefined {
	return typeof value === "string" && /^LIX_[A-Z0-9_]{1,100}$/.test(value)
		? value
		: undefined;
}

function isNativeCodedError(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	try {
		const candidate = value as { name?: unknown; code?: unknown };
		return candidate.name === "LixError" || !!safeLixErrorCode(candidate.code);
	} catch {
		return false;
	}
}

/** Keep Rust source locations repository-relative and free of build paths. */
export function safeRustErrorOrigin(
	value: unknown,
): SafeRustErrorOrigin | undefined {
	if (!value || typeof value !== "object") return undefined;
	let origin: unknown;
	try {
		origin = (value as { rustOrigin?: unknown }).rustOrigin;
	} catch {
		return undefined;
	}
	if (!origin || typeof origin !== "object") return undefined;
	let file: unknown;
	let line: unknown;
	let column: unknown;
	try {
		const fields = origin as {
			kind?: unknown;
			file?: unknown;
			line?: unknown;
			column?: unknown;
		};
		file = fields.file;
		if (fields.kind !== "source_location") return undefined;
		line = fields.line;
		column = fields.column;
	} catch {
		return undefined;
	}
	if (typeof file !== "string") return undefined;
	const normalized = file.replaceAll("\\", "/").split(/[?#]/, 1)[0] ?? "";
	if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized))
		return undefined;
	const pathSegments = normalized.split("/");
	if (pathSegments.some((segment) => segment === ".." || segment === ""))
		return undefined;
	const repositoryPath =
		/^packages\/[A-Za-z0-9_-]{1,80}\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.rs$/.test(
			normalized,
		)
			? normalized
			: undefined;
	if (
		!repositoryPath ||
		!Number.isSafeInteger(line) ||
		(line as number) < 1 ||
		(line as number) > 1_000_000
	)
		return undefined;
	return {
		kind: "source_location",
		file: repositoryPath,
		line: line as number,
		...(Number.isSafeInteger(column) &&
		(column as number) >= 0 &&
		(column as number) <= 100_000_000
			? { column: column as number }
			: {}),
	};
}

export function safeRustStacktraceStatus(
	value: unknown,
): RustStacktraceStatus | undefined {
	if (!value || typeof value !== "object") return undefined;
	try {
		return (value as { rustStacktraceStatus?: unknown })
			.rustStacktraceStatus === "not_captured"
			? "not_captured"
			: undefined;
	} catch {
		return undefined;
	}
}

function exceptionFields(
	value: unknown,
	suppressMessage = false,
): {
	type?: string;
	message?: string;
	stacktrace?: string;
} {
	if (typeof value === "string") {
		return suppressMessage
			? { type: "Error" }
			: { type: "Error", message: sanitizeTelemetryDiagnostic(value) };
	}
	if (!value || typeof value !== "object") return {};
	let name: unknown;
	let code: unknown;
	let messageValue: unknown;
	let stackValue: unknown;
	try {
		const candidate = value as {
			name?: unknown;
			code?: unknown;
			message?: unknown;
			stack?: unknown;
		};
		name = candidate.name;
		code = candidate.code;
		messageValue = candidate.message;
		stackValue = candidate.stack;
	} catch {
		return {};
	}
	const safeCode = safeLixErrorCode(code);
	const nativeError = name === "LixError" || safeCode !== undefined;
	const type = nativeError ? (safeCode ?? "LixError") : safeExceptionType(name);
	const message =
		safeCode ??
		(suppressMessage || nativeError || typeof messageValue !== "string"
			? undefined
			: sanitizeTelemetryDiagnostic(messageValue));
	const stacktrace = safeApplicationStacktrace(stackValue, name, messageValue);
	return {
		...(type ? { type } : {}),
		...(message ? { message } : {}),
		...(stacktrace ? { stacktrace } : {}),
	};
}

/** Return the first validated Rust source origin in a bounded cause chain. */
export function safeRustErrorOriginInCauseChain(
	value: unknown,
): LocatedRustErrorOrigin | undefined {
	const seen = new Set<object>();
	let current = value;
	for (
		let depth = 0;
		depth <= MAX_EXCEPTION_CAUSES && current != null;
		depth++
	) {
		if (typeof current === "object" || typeof current === "function") {
			const identity = current as object;
			if (seen.has(identity)) break;
			seen.add(identity);
		}
		const origin = safeRustErrorOrigin(current);
		if (origin) {
			const rustStacktraceStatus = safeRustStacktraceStatus(current);
			return {
				origin,
				...(depth > 0 ? { causeIndex: depth - 1 } : {}),
				...(rustStacktraceStatus ? { rustStacktraceStatus } : {}),
			};
		}
		current = causeOf(current);
	}
	return undefined;
}

function rustStacktraceStatusInChain(
	chain: unknown[],
): RustStacktraceStatus | undefined {
	for (const value of chain) {
		const status = safeRustStacktraceStatus(value);
		if (status) return status;
	}
	return undefined;
}

function stripExceptionHeader(
	stack: unknown,
	name: unknown,
	message: unknown,
): unknown {
	if (typeof stack !== "string" || typeof name !== "string") return stack;
	const header =
		typeof message === "string" && message.length > 0
			? `${name}: ${message}`
			: name;
	if (!stack.startsWith(header)) return stack;
	let remainder = stack.slice(header.length);
	if (remainder.startsWith("\r\n")) remainder = remainder.slice(2);
	else if (remainder.startsWith("\n")) remainder = remainder.slice(1);
	return remainder;
}

function safeExceptionType(value: unknown): string | undefined {
	return typeof value === "string" && /^[A-Z][A-Za-z0-9_]{0,63}$/.test(value)
		? value
		: undefined;
}

function causeOf(value: unknown): unknown {
	if (!value || typeof value !== "object") return undefined;
	try {
		return (value as { cause?: unknown }).cause;
	} catch {
		return undefined;
	}
}

function parseFrameLine(
	sourceLine: string,
): { key: string; frame: ApplicationExceptionFrame } | undefined {
	let line = sourceLine.trim();
	if (!line) return undefined;
	if (line.startsWith("at ")) {
		line = line.slice(3).trim();
		if (line.endsWith(")")) {
			const open = line.lastIndexOf(" (");
			if (open >= 0) {
				const functionName = safeFunctionName(line.slice(0, open));
				const frame = parseLocation(line.slice(open + 2, -1), functionName);
				return frame;
			}
		}
		return parseLocation(line);
	}
	const firefoxSeparator = line.lastIndexOf("@");
	if (firefoxSeparator >= 0) {
		const functionName = safeFunctionName(line.slice(0, firefoxSeparator));
		return parseLocation(line.slice(firefoxSeparator + 1), functionName);
	}
	return parseLocation(line);
}

function parseLocation(
	value: string,
	functionName?: string,
): { key: string; frame: ApplicationExceptionFrame } | undefined {
	const match = /^(.*):(\d{1,7}):(\d{1,9})$/.exec(value.trim());
	if (!match) return undefined;
	const rawFilename = match[1]!;
	const lineno = Number(match[2]);
	const colno = Number(match[3]);
	if (
		!Number.isSafeInteger(lineno) ||
		lineno < 1 ||
		lineno > 1_000_000 ||
		!Number.isSafeInteger(colno) ||
		colno < 0 ||
		colno > 100_000_000
	)
		return undefined;
	const filename = applicationAssetPath(rawFilename);
	if (!filename) return undefined;
	const frame: ApplicationExceptionFrame = {
		platform: "web:javascript",
		filename,
		...(functionName ? { function: functionName } : {}),
		lineno,
		colno,
		in_app: true,
	};
	return {
		key: `${filename}:${lineno}:${colno}:${functionName ?? ""}`,
		frame,
	};
}

function applicationAssetPath(value: string): string | undefined {
	let pathname: string;
	try {
		const url = new URL(value);
		if (
			(url.protocol !== "http:" && url.protocol !== "https:") ||
			url.username ||
			url.password
		)
			return undefined;
		pathname = url.pathname;
	} catch {
		pathname = value.split(/[?#]/, 1)[0] || "";
	}
	if (SAFE_ASSET_PATH.test(pathname)) return pathname;
	if (pathname === "/snapshot-fixture.tsx") return pathname;
	const viteSourceStart = pathname.lastIndexOf("/web-app/src/");
	if (viteSourceStart >= 0)
		pathname = pathname.slice(viteSourceStart + "/web-app".length);
	if (!SAFE_SOURCE_PATH.test(pathname)) return undefined;
	const segments = pathname.split("/");
	if (segments.some((segment) => segment === ".." || segment === "."))
		return undefined;
	return pathname;
}

function safeFunctionName(value: string): string | undefined {
	const name = value.trim().replace(/^(?:async|new)\s+/, "");
	if (name.length > 96 || !SAFE_FUNCTION.test(name)) return undefined;
	return name;
}
