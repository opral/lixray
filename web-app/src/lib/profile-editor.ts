import { demoProfileDocument } from "./demo-identity.ts";

export interface EditableProfileLink {
	key: string;
	label: string;
	uri: string;
}

export interface EditableProfile {
	name: string;
	bio: string;
	title: string;
	organization: string;
	location: string;
	avatarUri: string;
	links: Array<EditableProfileLink>;
}

export const PROFILE_UPDATED_EVENT = "lixray:profile-updated";
const DEMO_PROFILE_STORAGE_KEY = "lixray.demo.public-profile.v1";

export function editableProfileFromDocument(
	document: unknown,
): EditableProfile {
	const card = jsContactCard(document);
	const title = firstRecordValue(card.titles);
	const organizationId = stringValue(title?.organizationId);
	const organization = organizationId
		? recordValue(card.organizations, organizationId)
		: firstRecordValue(card.organizations);
	const avatar =
		recordValue(card.media, "avatar") ?? firstRecordValue(card.media);

	return {
		name: stringValue(recordValue(card.name)?.full) ?? "",
		bio: stringValue(firstRecordValue(card.notes)?.note) ?? "",
		title: stringValue(title?.name) ?? "",
		organization: stringValue(organization?.name) ?? "",
		location: stringValue(firstRecordValue(card.addresses)?.full) ?? "",
		avatarUri: avatar?.kind === "photo" ? (stringValue(avatar.uri) ?? "") : "",
		links: recordEntries(card.links).map(([key, link]) => ({
			key,
			label: stringValue(link.label) ?? "",
			uri: stringValue(link.uri) ?? "",
		})),
	};
}

export function profileDocumentWithEdits(
	document: unknown,
	values: EditableProfile,
	options: { allowLocalHttp?: boolean } = {},
): Record<string, unknown> {
	const card = structuredClone(jsContactCard(document));
	const normalized = normalizeEditableProfile(values, options);

	card.name = {
		...(recordValue(card.name) ?? {}),
		full: normalized.name,
	};
	setFirstRecord(card, "notes", "bio", normalized.bio, (current, value) => ({
		...current,
		note: value,
	}));
	const organizationKey = setFirstRecord(
		card,
		"organizations",
		"primary",
		normalized.organization,
		(current, value) => ({ ...current, name: value }),
	);
	setFirstRecord(
		card,
		"titles",
		"primary",
		normalized.title,
		(current, value) => {
			const next: Record<string, unknown> = {
				...current,
				kind: "title",
				name: value,
			};
			if (organizationKey) next.organizationId = organizationKey;
			else delete next.organizationId;
			return next;
		},
	);
	setFirstRecord(
		card,
		"addresses",
		"primary",
		normalized.location,
		(current, value) => ({ ...current, full: value }),
	);

	const media = { ...(recordValue(card.media) ?? {}) };
	if (normalized.avatarUri) {
		media.avatar = {
			...(recordValue(media.avatar) ?? {}),
			"@type": "Media",
			kind: "photo",
			uri: normalized.avatarUri,
		};
	} else {
		delete media.avatar;
	}
	if (Object.keys(media).length === 0) delete card.media;
	else card.media = media;

	const currentLinks = recordEntries(card.links);
	const links: Record<string, unknown> = {};
	for (const [index, link] of normalized.links.entries()) {
		const existing = currentLinks.find(([key]) => key === link.key);
		const key = existing?.[0] ?? `link${index + 1}`;
		links[key] = {
			...(existing?.[1] ?? {}),
			uri: link.uri,
			label: link.label || displayUri(link.uri),
		};
	}
	if (Object.keys(links).length === 0) delete card.links;
	else card.links = links;

	return card;
}

export function demoProfileDocumentWithOverride(
	origin: string,
	storage: Pick<Storage, "getItem"> = window.localStorage,
): Record<string, unknown> {
	try {
		const stored = storage.getItem(DEMO_PROFILE_STORAGE_KEY);
		if (stored) return jsContactCard(JSON.parse(stored));
	} catch {
		// Invalid or unavailable browser storage falls back to the seeded card.
	}
	return demoProfileDocument(origin);
}

export function saveDemoProfileDocument(
	document: Record<string, unknown>,
	storage: Pick<Storage, "setItem"> = window.localStorage,
): void {
	storage.setItem(
		DEMO_PROFILE_STORAGE_KEY,
		JSON.stringify(jsContactCard(document)),
	);
}

function normalizeEditableProfile(
	values: EditableProfile,
	options: { allowLocalHttp?: boolean },
): EditableProfile {
	const name = limitedRequired(values.name, "Display name", 80);
	const bio = limitedOptional(values.bio, "Bio", 280);
	const title = limitedOptional(values.title, "Title", 80);
	const organization = limitedOptional(values.organization, "Organization", 80);
	const location = limitedOptional(values.location, "Location", 120);
	const avatarUri = normalizedUri(values.avatarUri, "Avatar URL", options);
	const links = values.links
		.map((link, index) => ({
			key: safeRecordKey(link.key, index),
			label: limitedOptional(link.label, "Link label", 80),
			uri: normalizedUri(link.uri, "Link URL", {}),
		}))
		.filter((link) => link.uri);
	return { name, bio, title, organization, location, avatarUri, links };
}

function limitedRequired(
	value: string,
	label: string,
	maxLength: number,
): string {
	const normalized = value.trim();
	if (!normalized) throw new Error(`${label} is required.`);
	if (normalized.length > maxLength) {
		throw new Error(`${label} must be ${maxLength} characters or fewer.`);
	}
	return normalized;
}

function limitedOptional(
	value: string,
	label: string,
	maxLength: number,
): string {
	const normalized = value.trim();
	if (normalized.length > maxLength) {
		throw new Error(`${label} must be ${maxLength} characters or fewer.`);
	}
	return normalized;
}

function normalizedUri(
	value: string,
	label: string,
	options: { allowLocalHttp?: boolean },
): string {
	const normalized = value.trim();
	if (!normalized) return "";
	if (normalized.length > 2048) throw new Error(`${label} is too long.`);
	let uri: URL;
	try {
		uri = new URL(normalized);
	} catch {
		throw new Error(`${label} must be a complete URL.`);
	}
	const localHttp =
		options.allowLocalHttp === true &&
		uri.protocol === "http:" &&
		["localhost", "127.0.0.1", "::1"].includes(uri.hostname);
	if (uri.protocol !== "https:" && !localHttp) {
		throw new Error(`${label} must use HTTPS.`);
	}
	return uri.href;
}

function safeRecordKey(value: string, index: number): string {
	return /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : `link${index + 1}`;
}

function setFirstRecord(
	card: Record<string, unknown>,
	property: string,
	fallbackKey: string,
	value: string,
	update: (
		current: Record<string, unknown>,
		value: string,
	) => Record<string, unknown>,
): string | null {
	const records = { ...(recordValue(card[property]) ?? {}) };
	const key = recordEntries(records)[0]?.[0] ?? fallbackKey;
	if (value) records[key] = update(recordValue(records[key]) ?? {}, value);
	else delete records[key];
	if (Object.keys(records).length === 0) delete card[property];
	else card[property] = records;
	return value ? key : null;
}

function jsContactCard(value: unknown): Record<string, unknown> {
	if (
		!isRecord(value) ||
		value["@type"] !== "Card" ||
		value.version !== "2.0"
	) {
		throw new Error("The public profile is not a JSContact 2.0 Card.");
	}
	return value;
}

function recordValue(
	value: unknown,
	key?: string,
): Record<string, unknown> | null {
	if (!isRecord(value)) return null;
	if (key) return isRecord(value[key]) ? value[key] : null;
	return value;
}

function recordEntries(
	value: unknown,
): Array<[string, Record<string, unknown>]> {
	if (!isRecord(value)) return [];
	return Object.entries(value).filter(
		(entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]),
	);
}

function firstRecordValue(value: unknown): Record<string, unknown> | null {
	return recordEntries(value)[0]?.[1] ?? null;
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function displayUri(value: string): string {
	const uri = new URL(value);
	return `${uri.hostname.replace(/^www\./, "")}${uri.pathname === "/" ? "" : uri.pathname}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
