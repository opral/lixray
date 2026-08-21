import {
	DEMO_PROFILE_HANDLE,
	DEMO_PROFILE_NAMESPACE_ID,
} from "~/lib/demo-identity";
import { isDemoModeEnabled } from "~/lib/demo-client";
import { demoProfileDocumentWithOverride } from "~/lib/profile-editor";
import { getBrowserSupabaseClient } from "~/lib/supabase";

export interface PublicProfileLink {
	label: string;
	uri: string;
}

export interface PublicProfile {
	namespaceId: string;
	handle: string;
	name: string;
	avatarUri: string | null;
	bio: string | null;
	title: string | null;
	organization: string | null;
	location: string | null;
	links: Array<PublicProfileLink>;
	joinedAt: string;
	contactCardUri: string;
}

export interface ProfileRepositoryActivity {
	slug: string;
}

/**
 * Profile activity is intentionally a read-model placeholder. Replace this
 * with a scheduled indexer that materializes public lix statistics; identity
 * and profile presentation already resolve through the canonical profile URI.
 */
export const PLACEHOLDER_PROFILE_ACTIVITY = {
	totalFiles: 312,
	repositories: [
		{ slug: "handbook" },
		{ slug: "customer-roadmap" },
		{ slug: "brand-assets" },
		{ slug: "launch-deck" },
		{ slug: "pricing-model" },
		{ slug: "weekly-updates" },
	] satisfies Array<ProfileRepositoryActivity>,
	fileMix: [
		{
			label: "Docs",
			examples: "markdown, text",
			percentage: 42,
			color: "#b9aa8f",
		},
		{
			label: "Code",
			examples: "ts, rust",
			percentage: 18,
			color: "#cbbb9e",
		},
		{
			label: "Sheets",
			examples: "csv, tables",
			percentage: 17,
			color: "#dccdb1",
		},
		{
			label: "Decks",
			examples: "slides",
			percentage: 13,
			color: "#e8dcc4",
		},
		{
			label: "PDFs & other",
			examples: "pdf, images",
			percentage: 10,
			color: "#f0e7d6",
		},
	],
} as const;

export async function resolvePublicProfileByHandle(
	handle: string,
): Promise<PublicProfile | null> {
	const normalizedHandle = handle.trim().toLowerCase();
	let identity:
		| { namespaceId: string; namespaceHandle: string; createdAt: string }
		| undefined;

	if (isDemoModeEnabled) {
		if (normalizedHandle !== DEMO_PROFILE_HANDLE) return null;
		identity = {
			namespaceId: DEMO_PROFILE_NAMESPACE_ID,
			namespaceHandle: DEMO_PROFILE_HANDLE,
			createdAt: "2026-03-01T00:00:00.000Z",
		};
	} else {
		const client = getBrowserSupabaseClient();
		const { data, error } = await client.rpc(
			"resolve_public_profile_by_handle",
			{
				p_handle: normalizedHandle,
			},
		);
		if (error) throw error;
		const row = data?.[0];
		if (!row) return null;
		identity = {
			namespaceId: String(row.namespace_id),
			namespaceHandle: String(row.namespace_handle),
			createdAt: String(row.namespace_created_at),
		};
	}

	const document = isDemoModeEnabled
		? demoProfileDocumentWithOverride(window.location.origin)
		: await fetchProfileDocument(identity.namespaceId);
	if (!isJsContactCard(document)) return null;
	return profileFromDocument(identity, document);
}

async function fetchProfileDocument(namespaceId: string): Promise<unknown> {
	const response = await fetch(`/profile/${encodeURIComponent(namespaceId)}`, {
		headers: { Accept: "application/jscontact+json; version=2.0" },
		cache: "no-cache",
	});
	if (response.status === 404) return null;
	if (!response.ok) throw new Error("Unable to load this profile right now.");
	return response.json();
}

function profileFromDocument(
	identity: {
		namespaceId: string;
		namespaceHandle: string;
		createdAt: string;
	},
	document: Record<string, unknown>,
): PublicProfile {
	const title = firstRecordValue(document.titles);
	const organizationId = stringValue(title?.organizationId);
	const organizationEntries = recordEntries(document.organizations);
	const organization = title
		? organizationId
			? recordValue(document.organizations, organizationId)
			: null
		: (recordValue(document.organizations, "profile") ??
			(organizationEntries.length === 1 ? organizationEntries[0][1] : null));
	const avatar = preferredRecordValue(document.media, "avatar");

	return {
		namespaceId: identity.namespaceId,
		handle: identity.namespaceHandle,
		name:
			stringValue(recordValue(document.name)?.full) ?? identity.namespaceHandle,
		avatarUri:
			avatar?.kind === "photo" ? safePublicUri(avatar.uri, true) : null,
		bio: stringValue(firstRecordValue(document.notes)?.note),
		title: stringValue(title?.name),
		organization: stringValue(organization?.name),
		location: stringValue(firstRecordValue(document.addresses)?.full),
		links: recordEntries(document.links)
			.map(([, value]) => {
				const uri = safePublicUri(value.uri, false);
				if (!uri) return null;
				return { label: stringValue(value.label) ?? displayUri(uri), uri };
			})
			.filter((link): link is PublicProfileLink => link !== null),
		joinedAt: identity.createdAt,
		contactCardUri: `/profile/${encodeURIComponent(identity.namespaceId)}`,
	};
}

function isJsContactCard(value: unknown): value is Record<string, unknown> {
	return (
		isRecord(value) && value["@type"] === "Card" && value.version === "2.0"
	);
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

function preferredRecordValue(
	value: unknown,
	key: string,
): Record<string, unknown> | null {
	return recordValue(value, key) ?? firstRecordValue(value);
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safePublicUri(value: unknown, allowLocalhost: boolean): string | null {
	if (typeof value !== "string") return null;
	try {
		const uri = new URL(value);
		const localHttp =
			allowLocalhost &&
			uri.protocol === "http:" &&
			["localhost", "127.0.0.1", "::1"].includes(uri.hostname);
		return uri.protocol === "https:" || localHttp ? uri.href : null;
	} catch {
		return null;
	}
}

function displayUri(value: string): string {
	const uri = new URL(value);
	return `${uri.hostname.replace(/^www\./, "")}${uri.pathname === "/" ? "" : uri.pathname}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
