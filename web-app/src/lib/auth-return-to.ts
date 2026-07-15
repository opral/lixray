const authReturnBase = "https://lixray.invalid";

export function normalizeAuthReturnTo(value: string): string {
	if (!value.startsWith("/")) return "/";
	try {
		const url = new URL(value, authReturnBase);
		if (url.origin !== authReturnBase) return "/";
		return `${url.pathname}${url.search}${url.hash}`;
	} catch {
		return "/";
	}
}
