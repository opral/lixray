export interface McpExceptionFrame {
	filename: string;
	lineno: number;
	colno: number;
}

export interface McpExceptionStacktrace {
	type: "raw";
	frames: McpExceptionFrame[];
}

const MAX_FRAMES = 32;
const MAX_STACK_CHARACTERS = 32_768;
const SAFE_PATH = /^[A-Za-z0-9._/@+-]+$/;
const SAFE_NODE_PATH = /^node:[A-Za-z0-9._/-]+$/;

/** Keep source locations from V8 error stacks while dropping messages and names. */
export function mcpExceptionStacktrace(
	caught: unknown,
): McpExceptionStacktrace | undefined {
	const frames: McpExceptionFrame[] = [];
	const seen = new Set<string>();
	const visited = new Set<object>();
	let current = caught;

	for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
		if (visited.has(current)) break;
		visited.add(current);
		for (const frame of errorFrames(current)) {
			const key = `${frame.filename}:${frame.lineno}:${frame.colno}`;
			if (seen.has(key)) continue;
			seen.add(key);
			frames.push(frame);
			if (frames.length === MAX_FRAMES) break;
		}
		if (frames.length === MAX_FRAMES) break;
		try {
			current = current.cause;
		} catch {
			break;
		}
	}

	return frames.length > 0 ? { type: "raw", frames } : undefined;
}

function errorFrames(error: Error): McpExceptionFrame[] {
	try {
		const rawStack = error.stack;
		if (typeof rawStack !== "string") return [];
		const stack = rawStack.slice(0, MAX_STACK_CHARACTERS);
		// V8 puts Error#toString first. Removing the exact header prevents a
		// multiline, user-controlled message from masquerading as stack frames.
		const header = Error.prototype.toString.call(error);
		const prefix = `${header}\n`;
		if (!stack.startsWith(prefix)) return [];
		return stack
			.slice(prefix.length)
			.split(/\r?\n/)
			.flatMap((line) => {
				const frame = parseV8Frame(line);
				return frame ? [frame] : [];
			});
	} catch {
		return [];
	}
}

function parseV8Frame(line: string): McpExceptionFrame | undefined {
	const body = /^\s*at\s+(.+?)\s*$/.exec(line)?.[1];
	if (!body) return undefined;
	const location = /^.*\((.*)\)$/.exec(body)?.[1] ?? body;
	const match = /^(.*):(\d+):(\d+)$/.exec(location);
	if (!match) return undefined;
	const filename = safeFilename(match[1]!);
	const lineno = Number(match[2]);
	const colno = Number(match[3]);
	if (
		!filename ||
		!Number.isSafeInteger(lineno) ||
		!Number.isSafeInteger(colno)
	)
		return undefined;
	return { filename, lineno, colno };
}

function safeFilename(path: string): string | undefined {
	if (SAFE_NODE_PATH.test(path)) return path;
	let normalized: string | undefined;
	const dependencyIndex = path.lastIndexOf("/node_modules/");
	if (dependencyIndex >= 0) {
		normalized = `node_modules/${path.slice(dependencyIndex + "/node_modules/".length)}`;
	} else {
		const appIndex = path.lastIndexOf("/web-app/");
		if (appIndex >= 0) normalized = path.slice(appIndex + 1);
		else if (path.startsWith("web-app/")) normalized = path;
	}
	if (
		!normalized ||
		!SAFE_PATH.test(normalized) ||
		normalized.split("/").includes("..")
	)
		return undefined;
	return normalized;
}
