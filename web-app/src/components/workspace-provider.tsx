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
	DEMO_CREATED_WORKSPACE_ID,
	DEMO_ORGANIZATION_ID,
	DEMO_ORGANIZATION_NAME,
	DEMO_LIX_ID,
	DEMO_LIX_NAME,
} from "~/lib/demo-identity";
import { isDemoModeEnabled } from "~/lib/demo-client";
import type { LixraySupabaseClient } from "~/lib/supabase";
import { captureTelemetry } from "~/lib/telemetry";

export type OrganizationRole = "owner" | "member";

export interface Workspace {
	id: string;
	organizationId: string;
	name: string;
	slug: string;
	createdAt: string;
	updatedAt: string;
}

export interface Organization {
	id: string;
	name: string;
	handle: string;
	/** Null means direct workspace membership, not organization membership. */
	role: OrganizationRole | null;
	createdAt: string;
	updatedAt: string;
	workspaces: Array<Workspace>;
}

export interface ActiveWorkspace {
	organization: Organization;
	workspace: Workspace;
}

interface RefreshOptions {
	organizationId?: string;
	workspaceId?: string;
}

interface WorkspaceContextValue {
	isLoaded: boolean;
	error: string | null;
	organizations: Array<Organization>;
	selectedOrganization: Organization | null;
	activeWorkspace: ActiveWorkspace | null;
	refresh: (options?: RefreshOptions) => Promise<void>;
	selectOrganization: (organizationId: string) => void;
	selectWorkspace: (workspaceId: string) => void;
	createOrganization: (name: string) => Promise<void>;
	renameOrganization: (name: string) => Promise<void>;
	createWorkspace: (name: string, organizationId?: string) => Promise<void>;
	renameWorkspace: (workspaceId: string, name: string) => Promise<void>;
	deleteWorkspace: (workspaceId: string) => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
	if (isDemoModeEnabled) {
		return <DemoWorkspaceProvider>{children}</DemoWorkspaceProvider>;
	}
	return <SupabaseWorkspaceProvider>{children}</SupabaseWorkspaceProvider>;
}

function SupabaseWorkspaceProvider({ children }: { children: ReactNode }) {
	const { client, isLoaded: authLoaded, user } = useAuth();
	const userId = user?.id ?? null;
	const [isLoaded, setIsLoaded] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [organizations, setOrganizations] = useState<Array<Organization>>([]);
	const [selectedOrganizationId, setSelectedOrganizationId] = useState<
		string | null
	>(null);
	const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
		null,
	);
	const refresh = useCallback(
		async (options: RefreshOptions = {}) => {
			if (!client || !userId) {
				setOrganizations([]);
				setSelectedOrganizationId(null);
				setSelectedWorkspaceId(null);
				setError(null);
				setIsLoaded(true);
				return;
			}

			setError(null);
			try {
				const { error: provisioningError } = await client.rpc(
					"bootstrap_personal_namespace",
				);
				if (provisioningError) throw provisioningError;
				const nextOrganizations = await loadOrganizations(client);
				const storedOrganizationId = window.localStorage.getItem(
					organizationStorageKey(userId),
				);
				const requestedWorkspace = options.workspaceId
					? nextOrganizations
							.flatMap((organization) =>
								organization.workspaces.map((workspace) => ({
									organization,
									workspace,
								})),
							)
							.find(({ workspace }) => workspace.id === options.workspaceId)
					: null;
				const nextOrganization =
					requestedWorkspace?.organization ??
					nextOrganizations.find(
						(organization) =>
							organization.id ===
							(options.organizationId ?? storedOrganizationId),
					) ??
					nextOrganizations[0] ??
					null;

				const storedWorkspaceId = window.localStorage.getItem(
					workspaceStorageKey(userId),
				);
				const nextWorkspace =
					requestedWorkspace?.workspace ??
					nextOrganization?.workspaces.find(
						(workspace) =>
							workspace.id === (options.workspaceId ?? storedWorkspaceId),
					) ??
					nextOrganization?.workspaces[0] ??
					null;

				setOrganizations(nextOrganizations);
				setSelectedOrganizationId(nextOrganization?.id ?? null);
				setSelectedWorkspaceId(nextWorkspace?.id ?? null);
				persistSelection(
					userId,
					nextOrganization?.id ?? null,
					nextWorkspace?.id ?? null,
				);
			} catch (loadError) {
				setError(errorMessage(loadError));
			} finally {
				setIsLoaded(true);
			}
		},
		[client, userId],
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
	const selectedWorkspace =
		selectedOrganization?.workspaces.find(
			(workspace) => workspace.id === selectedWorkspaceId,
		) ?? null;
	const activeWorkspace = useMemo(
		() =>
			selectedOrganization && selectedWorkspace
				? { organization: selectedOrganization, workspace: selectedWorkspace }
				: null,
		[selectedOrganization, selectedWorkspace],
	);

	const selectOrganization = useCallback(
		(organizationId: string) => {
			if (!userId) return;
			const organization = organizations.find(
				(candidate) => candidate.id === organizationId,
			);
			if (!organization) return;
			const workspace = organization.workspaces[0] ?? null;
			setSelectedOrganizationId(organization.id);
			setSelectedWorkspaceId(workspace?.id ?? null);
			persistSelection(userId, organization.id, workspace?.id ?? null);
		},
		[organizations, userId],
	);

	const selectWorkspace = useCallback(
		(workspaceId: string) => {
			if (!userId) return;
			const organization = organizations.find((candidate) =>
				candidate.workspaces.some((workspace) => workspace.id === workspaceId),
			);
			const workspace = organization?.workspaces.find(
				(candidate) => candidate.id === workspaceId,
			);
			if (!organization || !workspace) return;
			setSelectedOrganizationId(organization.id);
			setSelectedWorkspaceId(workspace.id);
			persistSelection(userId, organization.id, workspace.id);
		},
		[organizations, userId],
	);

	const createOrganization = useCallback(
		async (name: string) => {
			if (!client) throw new Error("Authentication is still loading");
			const { data, error: createError } = await client.rpc(
				"create_namespace",
				{ p_name: normalizeName(name, "Organization") },
			);
			if (createError) throw createError;
			await refresh({ organizationId: String(data) });
			captureTelemetry("organization_created");
		},
		[client, refresh],
	);

	const renameOrganization = useCallback(
		async (name: string) => {
			if (!client || !selectedOrganization) {
				throw new Error("No organization is selected");
			}
			if (selectedOrganization.role !== "owner") {
				throw new Error("Only organization owners can rename an organization");
			}
			const { error: renameError } = await client.rpc("rename_namespace", {
				p_namespace_id: selectedOrganization.id,
				p_name: normalizeName(name, "Organization"),
			});
			if (renameError) throw renameError;
			await refresh({
				organizationId: selectedOrganization.id,
				workspaceId: selectedWorkspaceId ?? undefined,
			});
			captureTelemetry("organization_renamed");
		},
		[client, refresh, selectedOrganization, selectedWorkspaceId],
	);

	const createWorkspace = useCallback(
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
			const workspaceId = crypto.randomUUID();
			const { error: createError } = await client.from("lixes").insert({
				id: workspaceId,
				namespace_id: targetOrganization.id,
				name: normalizedName,
				slug: workspaceSlug(normalizedName),
			});
			if (createError) throw createError;
			await refresh({
				organizationId: targetOrganization.id,
				workspaceId,
			});
			captureTelemetry("workspace_created");
		},
		[client, organizations, refresh, selectedOrganization],
	);

	const renameWorkspace = useCallback(
		async (workspaceId: string, name: string) => {
			if (!client) throw new Error("Authentication is still loading");
			const organization = organizations.find((candidate) =>
				candidate.workspaces.some((workspace) => workspace.id === workspaceId),
			);
			if (!organization) throw new Error("Repository not found");
			if (organization.role === null) {
				throw new Error(
					"Repository membership does not grant organization access",
				);
			}
			const { error: renameError } = await client
				.from("lixes")
				.update({ name: normalizeName(name, "Repository") })
				.eq("id", workspaceId);
			if (renameError) throw renameError;
			await refresh({
				organizationId: organization.id,
				workspaceId,
			});
			captureTelemetry("workspace_renamed");
		},
		[client, organizations, refresh],
	);

	const deleteWorkspace = useCallback(
		async (workspaceId: string) => {
			if (!client) throw new Error("Authentication is still loading");
			const organization = organizations.find((candidate) =>
				candidate.workspaces.some((workspace) => workspace.id === workspaceId),
			);
			if (!organization) throw new Error("Repository not found");
			if (organization.role === null) {
				throw new Error(
					"Repository membership does not grant organization access",
				);
			}
			const { error: deleteError } = await client.rpc("delete_lix", {
				p_lix_id: workspaceId,
			});
			if (deleteError) throw deleteError;
			await refresh();
			captureTelemetry("workspace_deleted");
		},
		[client, organizations, refresh],
	);

	const value = useMemo<WorkspaceContextValue>(
		() => ({
			isLoaded,
			error,
			organizations,
			selectedOrganization,
			activeWorkspace,
			refresh,
			selectOrganization,
			selectWorkspace,
			createOrganization,
			renameOrganization,
			createWorkspace,
			renameWorkspace,
			deleteWorkspace,
		}),
		[
			activeWorkspace,
			createOrganization,
			createWorkspace,
			deleteWorkspace,
			error,
			isLoaded,
			organizations,
			refresh,
			renameOrganization,
			renameWorkspace,
			selectOrganization,
			selectedOrganization,
			selectWorkspace,
		],
	);

	return (
		<WorkspaceContext.Provider value={value}>
			{children}
		</WorkspaceContext.Provider>
	);
}

async function loadOrganizations(
	client: LixraySupabaseClient,
): Promise<Array<Organization>> {
	const { data, error } = await client.rpc("list_accessible_lixes");
	if (error) throw error;

	const organizations = new Map<string, Organization>();
	for (const row of data ?? []) {
		const organizationId = String(row.namespace_id);
		let organization = organizations.get(organizationId);
		if (!organization) {
			organization = {
				id: organizationId,
				name: String(row.namespace_name),
				handle: String(row.namespace_handle),
				role: row.namespace_role,
				createdAt: String(row.namespace_created_at),
				updatedAt: String(row.namespace_updated_at),
				workspaces: [],
			};
			organizations.set(organizationId, organization);
		}
		if (row.lix_id) {
			organization.workspaces.push({
				id: String(row.lix_id),
				organizationId,
				name: String(row.lix_name),
				slug: String(row.lix_slug),
				createdAt: String(row.lix_created_at),
				updatedAt: String(row.lix_updated_at),
			});
		}
	}

	return [...organizations.values()]
		.map((organization) => ({
			...organization,
			workspaces: [...organization.workspaces].sort((left, right) =>
				left.createdAt.localeCompare(right.createdAt),
			),
		}))
		.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function DemoWorkspaceProvider({ children }: { children: ReactNode }) {
	const [organization, setOrganization] = useState<Organization>(() => ({
		id: DEMO_ORGANIZATION_ID,
		name: DEMO_ORGANIZATION_NAME,
		handle: DEMO_ORGANIZATION_NAME,
		role: "owner",
		createdAt: "2026-07-01T12:00:00.000Z",
		updatedAt: "2026-07-12T18:58:00.000Z",
		workspaces: [
			{
				id: DEMO_LIX_ID,
				organizationId: DEMO_ORGANIZATION_ID,
				name: DEMO_LIX_NAME,
				slug: DEMO_LIX_NAME,
				createdAt: "2026-07-01T12:00:00.000Z",
				updatedAt: "2026-07-12T18:58:00.000Z",
			},
		],
	}));
	const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(DEMO_LIX_ID);
	const selectedWorkspace =
		organization.workspaces.find(
			(workspace) => workspace.id === selectedWorkspaceId,
		) ?? organization.workspaces[0];
	const unsupported = () =>
		Promise.reject(
			new Error("Repository mutation is unavailable in demo mode"),
		);
	const createWorkspace = (name: string, organizationId?: string) => {
		if (organizationId && organizationId !== organization.id) {
			throw new Error("Create or select an organization first");
		}
		const normalizedName = normalizeName(name, "Repository");
		const now = new Date().toISOString();
		const workspace: Workspace = {
			id: DEMO_CREATED_WORKSPACE_ID,
			organizationId: organization.id,
			name: normalizedName,
			slug: workspaceSlug(normalizedName),
			createdAt: now,
			updatedAt: now,
		};
		setOrganization((current) => ({
			...current,
			updatedAt: now,
			workspaces: [
				...current.workspaces.filter(
					(candidate) => candidate.id !== DEMO_CREATED_WORKSPACE_ID,
				),
				workspace,
			],
		}));
		setSelectedWorkspaceId(workspace.id);
		return Promise.resolve();
	};
	const value: WorkspaceContextValue = {
		isLoaded: true,
		error: null,
		organizations: [organization],
		selectedOrganization: organization,
		activeWorkspace: selectedWorkspace
			? { organization, workspace: selectedWorkspace }
			: null,
		refresh: () => Promise.resolve(),
		selectOrganization: () => undefined,
		selectWorkspace: setSelectedWorkspaceId,
		createOrganization: unsupported,
		renameOrganization: unsupported,
		createWorkspace,
		renameWorkspace: unsupported,
		deleteWorkspace: unsupported,
	};
	return (
		<WorkspaceContext.Provider value={value}>
			{children}
		</WorkspaceContext.Provider>
	);
}

function workspaceSlug(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 100) || "repository"
	);
}

export function useWorkspace() {
	const value = useContext(WorkspaceContext);
	if (!value) {
		throw new Error("useWorkspace must be used inside WorkspaceProvider");
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
	userId: string,
	organizationId: string | null,
	workspaceId: string | null,
) {
	setOrRemove(organizationStorageKey(userId), organizationId);
	setOrRemove(workspaceStorageKey(userId), workspaceId);
}

function setOrRemove(key: string, value: string | null) {
	if (value) window.localStorage.setItem(key, value);
	else window.localStorage.removeItem(key);
}

function organizationStorageKey(userId: string) {
	return `lixray.active-organization.${userId}`;
}

function workspaceStorageKey(userId: string) {
	return `lixray.active-workspace.${userId}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Unable to load repositories";
}
