export function jsContactAvatarUri(value: unknown): string | null {
	if (
		!isRecord(value) ||
		value["@type"] !== "Card" ||
		value.version !== "2.0"
	) {
		return null;
	}
	const media = value.media;
	if (!isRecord(media)) return null;

	const entries = Object.entries(media);
	const candidates = [
		...entries.filter(([key]) => key === "avatar"),
		...entries.filter(([key]) => key !== "avatar"),
	];
	for (const [, candidate] of candidates) {
		if (!isRecord(candidate) || candidate.kind !== "photo") continue;
		const uri = safePublicImageUri(candidate.uri);
		if (uri) return uri;
	}
	return null;
}

function safePublicImageUri(value: unknown): string | null {
	if (typeof value !== "string") return null;
	try {
		const url = new URL(value);
		const localHttp =
			url.protocol === "http:" &&
			["localhost", "127.0.0.1", "::1"].includes(url.hostname);
		return url.protocol === "https:" || localHttp ? url.href : null;
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
