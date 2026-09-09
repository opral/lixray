import { provisionRepository } from "~/lib/provision-repository";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import { useAuth } from "~/components/auth-provider";
import {
	DEMO_CREATED_REPOSITORY_ID,
	DEMO_ORGANIZATION_ID,
	DEMO_ORGANIZATION_NAME,
	DEMO_LIX_ID,
	DEMO_LIX_NAME,
	DEMO_SECONDARY_LIX_ID,
	DEMO_SECONDARY_LIX_NAME,
} from "~/lib/demo-identity";
import { isDemoModeEnabled } from "~/lib/demo-client";
import {
	normalizeRepositoryListError,
	RepositoryListError,
	repositoryListTelemetryProperties,
} from "~/lib/repository-list-error";
import {
	shouldCaptureRepositoryListException,
	shouldRefreshRepositoryList,
} from "~/lib/repository-list-refresh";
import type { LixraySupabaseClient } from "~/lib/supabase";
import {
	captureErrorLogImmediately,
	captureExceptionTelemetryAsync,
	captureTelemetry,
} from "~/lib/telemetry";
import { PRODUCT_EVENTS } from "~/lib/telemetry-events";

export type OrganizationRole = "owner" | "member";

export interface Repository {
	id: string;
	organizationId: string;
	name: string;
	slug: string;
	createdAt: string;
	updatedAt: string;
	role: "admin" | "member";
	visibility: "private" | "public";
}

export interface Organization {
	id: string;
	name: string;
	handle: string;
	/** True when this namespace is a user's primary (personal) namespace. */
	isPersonal: boolean;
	/** Null means direct repository membership, not organization membership. */
	role: OrganizationRole | null;
	createdAt: string;
	updatedAt: string;
	repositories: Array<Repository>;
}

export interface ActiveRepository {
	organization: Organization;
	repository: Repository;
}

interface RefreshOptions {
	organizationId?: string;
	repositoryId?: string;
}

interface RepositoryContextValue {
	isLoaded: boolean;
	error: string | null;
	organizations: Array<Organization>;
	selectedOrganization: Organization | null;
	activeRepository: ActiveRepository | null;
	refresh: (options?: RefreshOptions) => Promise<void>;
	selectOrganization: (organizationId: string) => void;
	selectRepository: (repositoryId: string) => void;
	/** Resolves with the new organization's id. */
	createOrganization: (name: string) => Promise<string>;
	renameOrganization: (organizationId: string, name: string) => Promise<void>;
	createRepository: (name: string, organizationId?: string) => Promise<void>;
	renameRepository: (repositoryId: string, name: string) => Promise<void>;
	deleteRepository: (repositoryId: string) => Promise<void>;
}

const RepositoryContext = createContext<RepositoryContextValue | null>(null);

export function RepositoryProvider({ children }: { children: ReactNode }) {
	if (isDemoModeEnabled) {
		return <DemoRepositoryProvider>{children}</DemoRepositoryProvider>;
	}
	return <SupabaseRepositoryProvider>{children}</SupabaseRepositoryProvider>;
}

function SupabaseRepositoryProvider({ children }: { children: ReactNode }) {
	const {
		accountId,
		client,
		isLoaded: authLoaded,
		validateSession,
	} = useAuth();
	const [isLoaded, setIsLoaded] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [organizations, setOrganizations] = useState<Array<Organization>>([]);
	const [selectedOrganizationId, setSelectedOrganizationId] = useState<
		string | null
	>(null);
	const [selectedRepositoryId, setSelectedRepositoryId] = useState<
		string | null
	>(null);
	const refresh = useCallback(
		async (options: RefreshOptions = {}) => {
			if (!client || !accountId) {
				setOrganizations([]);
				setSelectedOrganizationId(null);
				setSelectedRepositoryId(null);
				setError(null);
				setIsLoaded(true);
				return;
			}

			if (
				typeof window !== "undefined" &&
				!shouldRefreshRepositoryList(window.location.pathname)
			) {
				setError(null);
				setIsLoaded(true);
				return;
			}

			setError(null);
			try {
				const provisioningResponse = await client.rpc(
					"bootstrap_personal_namespace",
				);
				if (provisioningResponse.error) {
					throw new RepositoryListError(
						"bootstrap_personal_namespace",
						provisioningResponse,
					);
				}
				const nextOrganizations = await loadOrganizations(client);
				const storedOrganizationId = window.localStorage.getItem(
					organizationStorageKey(accountId),
				);
				const requestedRepository = options.repositoryId
					? nextOrganizations
							.flatMap((organization) =>
								organization.repositories.map((repository) => ({
									organization,
									repository,
								})),
							)
							.find(({ repository }) => repository.id === options.repositoryId)
					: null;
				const nextOrganization =
					requestedRepository?.organization ??
					nextOrganizations.find(
						(organization) =>
							organization.id ===
							(options.organizationId ?? storedOrganizationId),
					) ??
					nextOrganizations[0] ??
					null;

				const storedRepositoryId = window.localStorage.getItem(
					repositoryStorageKey(accountId),
				);
				const nextRepository =
					requestedRepository?.repository ??
					nextOrganization?.repositories.find(
						(repository) =>
							repository.id === (options.repositoryId ?? storedRepositoryId),
					) ??
					nextOrganization?.repositories[0] ??
					null;

				setOrganizations(nextOrganizations);
				setSelectedOrganizationId(nextOrganization?.id ?? null);
				setSelectedRepositoryId(nextRepository?.id ?? null);
				persistSelection(
					accountId,
					nextOrganization?.id ?? null,
					nextRepository?.id ?? null,
				);
			} catch (loadError) {
				const failure = normalizeRepositoryListError(loadError);
				const telemetryProperties = repositoryListTelemetryProperties(failure);
				setError(failure.message);
				const pathname =
					typeof window === "undefined" ? "" : window.location.pathname;
				if (
					shouldCaptureRepositoryListException(pathname, failure, loadError)
				) {
					await Promise.all([
						captureErrorLogImmediately(
							"Repository list failed",
							telemetryProperties,
						),
						captureExceptionTelemetryAsync(failure, telemetryProperties),
					]);
					await validateSession("repository_list_failed");
				}
			} finally {
				setIsLoaded(true);
			}
		},
		[accountId, client, validateSession],
	);

	useEffect(() => {
		if (!authLoaded) return;
		setIsLoaded(false);
		void refresh();
	}, [authLoaded, refresh]);

	const selectedOrganization =
		organizations.find(
			(organization) => organization.id === selectedOrganizationId,
		) ?? null;
	const selectedRepository =
		selectedOrganization?.repositories.find(
			(repository) => repository.id === selectedRepositoryId,
		) ?? null;
	const activeRepository = useMemo(
		() =>
			selectedOrganization && selectedRepository
				? { organization: selectedOrganization, repository: selectedRepository }
				: null,
		[selectedOrganization, selectedRepository],
	);

	const selectOrganization = useCallback(
		(organizationId: string) => {
			if (!accountId) return;
			const organization = organizations.find(
				(candidate) => candidate.id === organizationId,
			);
			if (!organization) return;
			const repository = organization.repositories[0] ?? null;
			setSelectedOrganizationId(organization.id);
			setSelectedRepositoryId(repository?.id ?? null);
			persistSelection(accountId, organization.id, repository?.id ?? null);
		},
		[accountId, organizations],
	);

	const selectRepository = useCallback(
		(repositoryId: string) => {
			if (!accountId) return;
			const organization = organizations.find((candidate) =>
				candidate.repositories.some(
					(repository) => repository.id === repositoryId,
				),
			);
			const repository = organization?.repositories.find(
				(candidate) => candidate.id === repositoryId,
			);
			if (!organization || !repository) return;
			setSelectedOrganizationId(organization.id);
			setSelectedRepositoryId(repository.id);
			persistSelection(accountId, organization.id, repository.id);
		},
		[accountId, organizations],
	);

	const createOrganization = useCallback(
		async (name: string) => {
			if (!client) throw new Error("Authentication is still loading");
			const { data, error: createError } = await client.rpc(
				"create_namespace",
				{ p_name: normalizeName(name, "Organization") },
			);
			if (createError) throw createError;
			const organizationId = String(data);
			await refresh({ organizationId });
			captureTelemetry(PRODUCT_EVENTS.organizationCreated);
			return organizationId;
		},
		[client, refresh],
	);

	const renameOrganization = useCallback(
		async (organizationId: string, name: string) => {
			if (!client) throw new Error("Authentication is still loading");
			const organization = organizations.find(
				(candidate) => candidate.id === organizationId,
			);
			if (!organization) throw new Error("Unknown organization");
			if (organization.role !== "owner") {
				throw new Error("Only organization owners can rename an organization");
			}
			const { error: renameError } = await client.rpc("rename_namespace", {
				p_namespace_id: organizationId,
				p_name: normalizeName(name, "Organization"),
			});
			if (renameError) throw renameError;
			await refresh({
				organizationId,
				repositoryId: selectedRepositoryId ?? undefined,
			});
			captureTelemetry(PRODUCT_EVENTS.organizationRenamed);
		},
		[client, organizations, refresh, selectedRepositoryId],
	);

	const createRepository = useCallback(
		async (name: string, organizationId?: string) => {
			const targetOrganization = organizations.find(
				(organization) =>
					organization.id === (organizationId ?? selectedOrganization?.id),
			);
			if (!client || !targetOrganization) {
				throw new Error("Create or select an organization first");
			}
			if (targetOrganization.role === null) {
				throw new Error(
					"Repository membership does not grant organization access",
				);
			}
			const normalizedName = normalizeName(name, "Repository");
			const repositoryId = crypto.randomUUID();
			const { error: createError } = await client.from("lixes").insert({
				id: repositoryId,
				namespace_id: targetOrganization.id,
				name: normalizedName,
				slug: repositorySlug(normalizedName),
			});
			if (createError) throw createError;
			const {
				data: { session },
			} = await client.auth.getSession();
			if (!session) throw new Error("Authentication required");
			await provisionRepository(repositoryId, session.access_token);
			await refresh({
				organizationId: targetOrganization.id,
				repositoryId,
			});
			captureTelemetry(PRODUCT_EVENTS.repositoryCreated);
		},
		[client, organizations, refresh, selectedOrganization],
	);

	const renameRepository = useCallback(
		async (repositoryId: string, name: string) => {
			if (!client) throw new Error("Authentication is still loading");
			const organization = organizations.find((candidate) =>
				candidate.repositories.some(
					(repository) => repository.id === repositoryId,
				),
			);
			const repository = organization?.repositories.find(
				(candidate) => candidate.id === repositoryId,
			);
			if (!organization || !repository) throw new Error("Repository not found");
			if (repository.role !== "admin") {
				throw new Error("Repository admin access required");
			}
			const { error: renameError } = await client
				.from("lixes")
				.update({ name: normalizeName(name, "Repository") })
				.eq("id", repositoryId);
			if (renameError) throw renameError;
			await refresh({
				organizationId: organization.id,
				repositoryId,
			});
			captureTelemetry(PRODUCT_EVENTS.repositoryRenamed);
		},
		[client, organizations, refresh],
	);

	const deleteRepository = useCallback(
		async (repositoryId: string) => {
			if (!client) throw new Error("Authentication is still loading");
			const organization = organizations.find((candidate) =>
				candidate.repositories.some(
					(repository) => repository.id === repositoryId,
				),
			);
			const repository = organization?.repositories.find(
				(candidate) => candidate.id === repositoryId,
			);
			if (!organization || !repository) throw new Error("Repository not found");
			if (repository.role !== "admin") {
				throw new Error("Repository admin access required");
			}
			const { error: deleteError } = await client.rpc("delete_lix", {
				p_lix_id: repositoryId,
			});
			if (deleteError) throw deleteError;
			await refresh();
			captureTelemetry(PRODUCT_EVENTS.repositoryDeleted);
		},
		[client, organizations, refresh],
	);

	const value = useMemo<RepositoryContextValue>(
		() => ({
			isLoaded,
			error,
			organizations,
			selectedOrganization,
			activeRepository,
			refresh,
			selectOrganization,
			selectRepository,
			createOrganization,
			renameOrganization,
			createRepository,
			renameRepository,
			deleteRepository,
		}),
		[
			activeRepository,
			createOrganization,
			createRepository,
			deleteRepository,
			error,
			isLoaded,
			organizations,
			refresh,
			renameOrganization,
			renameRepository,
			selectOrganization,
			selectedOrganization,
			selectRepository,
		],
	);

	return (
		<RepositoryContext.Provider value={value}>
			{children}
		</RepositoryContext.Provider>
	);
}

async function loadOrganizations(
	client: LixraySupabaseClient,
): Promise<Array<Organization>> {
	const response = await client.rpc("list_accessible_lixes");
	if (response.error) {
		throw new RepositoryListError("list_accessible_lixes", response);
	}

	const organizations = new Map<string, Organization>();
	for (const row of response.data ?? []) {
		const organizationId = String(row.namespace_id);
		let organization = organizations.get(organizationId);
		if (!organization) {
			organization = {
				id: organizationId,
				name: String(row.namespace_name),
				handle: String(row.namespace_handle),
				isPersonal: Boolean(row.namespace_is_personal),
				role: row.namespace_role,
				createdAt: String(row.namespace_created_at),
				updatedAt: String(row.namespace_updated_at),
				repositories: [],
			};
			organizations.set(organizationId, organization);
		}
		if (row.lix_id) {
			organization.repositories.push({
				id: String(row.lix_id),
				organizationId,
				name: String(row.lix_name),
				slug: String(row.lix_slug),
				createdAt: String(row.lix_created_at),
				updatedAt: String(row.lix_updated_at),
				role: row.lix_role,
				visibility: row.lix_visibility,
			});
		}
	}

	return [...organizations.values()]
		.map((organization) => ({
			...organization,
			repositories: [...organization.repositories].sort((left, right) =>
				left.createdAt.localeCompare(right.createdAt),
			),
		}))
		.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function DemoRepositoryProvider({ children }: { children: ReactNode }) {
	const [organization, setOrganization] = useState<Organization>(() => ({
		id: DEMO_ORGANIZATION_ID,
		name: DEMO_ORGANIZATION_NAME,
		handle: DEMO_ORGANIZATION_NAME,
		isPersonal: true,
		role: "owner",
		createdAt: "2026-07-01T12:00:00.000Z",
		updatedAt: "2026-07-12T18:58:00.000Z",
		repositories: [
			{
				id: DEMO_LIX_ID,
				organizationId: DEMO_ORGANIZATION_ID,
				name: DEMO_LIX_NAME,
				slug: DEMO_LIX_NAME,
				createdAt: "2026-07-01T12:00:00.000Z",
				updatedAt: "2026-07-12T18:58:00.000Z",
				role: "admin",
				visibility: "public",
			},
			{
				id: DEMO_SECONDARY_LIX_ID,
				organizationId: DEMO_ORGANIZATION_ID,
				name: DEMO_SECONDARY_LIX_NAME,
				slug: DEMO_SECONDARY_LIX_NAME,
				createdAt: "2026-07-02T12:00:00.000Z",
				updatedAt: "2026-07-12T18:58:00.000Z",
				role: "admin",
				visibility: "public",
			},
		],
	}));
	const [selectedRepositoryId, setSelectedRepositoryId] = useState(() => {
		if (typeof window === "undefined") return DEMO_LIX_ID;
		try {
			const stored = window.localStorage.getItem(
				"lixray:demo-active-repository:v1",
			);
			return stored === DEMO_SECONDARY_LIX_ID ? stored : DEMO_LIX_ID;
		} catch {
			return DEMO_LIX_ID;
		}
	});
	const selectRepository = (repositoryId: string) => {
		try {
			window.localStorage.setItem(
				"lixray:demo-active-repository:v1",
				repositoryId,
			);
		} catch {
			// Storage can be unavailable in restricted browser contexts. The
			// current page can still switch repositories normally.
		}
		setSelectedRepositoryId(repositoryId);
	};
	const selectedRepository =
		organization.repositories.find(
			(repository) => repository.id === selectedRepositoryId,
		) ?? organization.repositories[0];
	const unsupported = () =>
		Promise.reject(
			new Error("Repository mutation is unavailable in demo mode"),
		);
	const createRepository = (name: string, organizationId?: string) => {
		if (organizationId && organizationId !== organization.id) {
			throw new Error("Create or select an organization first");
		}
		const normalizedName = normalizeName(name, "Repository");
		const now = new Date().toISOString();
		const repository: Repository = {
			id: DEMO_CREATED_REPOSITORY_ID,
			organizationId: organization.id,
			name: normalizedName,
			slug: repositorySlug(normalizedName),
			createdAt: now,
			updatedAt: now,
			role: "admin",
			visibility: "private",
		};
		setOrganization((current) => ({
			...current,
			updatedAt: now,
			repositories: [
				...current.repositories.filter(
					(candidate) => candidate.id !== DEMO_CREATED_REPOSITORY_ID,
				),
				repository,
			],
		}));
		selectRepository(repository.id);
		return Promise.resolve();
	};
	const value: RepositoryContextValue = {
		isLoaded: true,
		error: null,
		organizations: [organization],
		selectedOrganization: organization,
		activeRepository: selectedRepository
			? { organization, repository: selectedRepository }
			: null,
		refresh: () => Promise.resolve(),
		selectOrganization: () => undefined,
		selectRepository,
		createOrganization: unsupported,
		renameOrganization: unsupported,
		createRepository,
		renameRepository: unsupported,
		deleteRepository: unsupported,
	};
	return (
		<RepositoryContext.Provider value={value}>
			{children}
		</RepositoryContext.Provider>
	);
}

export function repositorySlug(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 100) || "repository"
	);
}

export function useRepository() {
	const value = useContext(RepositoryContext);
	if (!value) {
		throw new Error("useRepository must be used inside RepositoryProvider");
	}
	return value;
}

function normalizeName(value: string, label: string): string {
	const normalized = value.trim();
	if (normalized.length < 1 || normalized.length > 80) {
		throw new Error(`${label} name must be between 1 and 80 characters`);
	}
	return normalized;
}

function persistSelection(
	accountId: string,
	organizationId: string | null,
	repositoryId: string | null,
) {
	setOrRemove(organizationStorageKey(accountId), organizationId);
	setOrRemove(repositoryStorageKey(accountId), repositoryId);
}

function setOrRemove(key: string, value: string | null) {
	if (value) window.localStorage.setItem(key, value);
	else window.localStorage.removeItem(key);
}

function organizationStorageKey(accountId: string) {
	return `lixray.active-organization.${accountId}`;
}

function repositoryStorageKey(accountId: string) {
	return `lixray.active-repository.${accountId}`;
}
