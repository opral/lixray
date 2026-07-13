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
	E2E_CREATED_WORKSPACE_ID,
	E2E_ORGANIZATION_ID,
	E2E_ORGANIZATION_NAME,
	E2E_WORKSPACE_ID,
	E2E_WORKSPACE_NAME,
} from "~/lib/e2e-auth";
import { isE2eAuthEnabled } from "~/lib/e2e-client";
import type { LixraySupabaseClient } from "~/lib/supabase";

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
	role: OrganizationRole;
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
	if (isE2eAuthEnabled) {
		return <E2eWorkspaceProvider>{children}</E2eWorkspaceProvider>;
	}
	return <SupabaseWorkspaceProvider>{children}</SupabaseWorkspaceProvider>;
}

function SupabaseWorkspaceProvider({ children }: { children: ReactNode }) {
	const { client, isLoaded: authLoaded, user } = useAuth();
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
			if (!client || !user) {
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
					"ensure_personal_workspace",
				);
				if (provisioningError) throw provisioningError;
				const nextOrganizations = await loadOrganizations(client, user.id);
				const storedOrganizationId = window.localStorage.getItem(
					organizationStorageKey(user.id),
				);
				const nextOrganization =
					nextOrganizations.find(
						(organization) =>
							organization.id ===
							(options.organizationId ?? storedOrganizationId),
					) ??
					nextOrganizations[0] ??
					null;

				const storedWorkspaceId = window.localStorage.getItem(
					workspaceStorageKey(user.id),
				);
				const nextWorkspace =
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
					user.id,
					nextOrganization?.id ?? null,
					nextWorkspace?.id ?? null,
				);
			} catch (loadError) {
				setError(errorMessage(loadError));
			} finally {
				setIsLoaded(true);
			}
		},
		[client, user],
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
			if (!user) return;
			const organization = organizations.find(
				(candidate) => candidate.id === organizationId,
			);
			if (!organization) return;
			const workspace = organization.workspaces[0] ?? null;
			setSelectedOrganizationId(organization.id);
			setSelectedWorkspaceId(workspace?.id ?? null);
			persistSelection(user.id, organization.id, workspace?.id ?? null);
		},
		[organizations, user],
	);

	const selectWorkspace = useCallback(
		(workspaceId: string) => {
			if (!user) return;
			const organization = organizations.find((candidate) =>
				candidate.workspaces.some((workspace) => workspace.id === workspaceId),
			);
			const workspace = organization?.workspaces.find(
				(candidate) => candidate.id === workspaceId,
			);
			if (!organization || !workspace) return;
			setSelectedOrganizationId(organization.id);
			setSelectedWorkspaceId(workspace.id);
			persistSelection(user.id, organization.id, workspace.id);
		},
		[organizations, user],
	);

	const createOrganization = useCallback(
		async (name: string) => {
			if (!client) throw new Error("Authentication is still loading");
			const { data, error: createError } = await client.rpc(
				"create_organization",
				{ p_name: normalizeName(name, "Organization") },
			);
			if (createError) throw createError;
			await refresh({ organizationId: String(data) });
		},
		[client, refresh],
	);

	const renameOrganization = useCallback(
		async (name: string) => {
			if (!client || !selectedOrganization) {
				throw new Error("No organization is selected");
			}
			const { error: renameError } = await client.rpc("rename_organization", {
				p_organization_id: selectedOrganization.id,
				p_name: normalizeName(name, "Organization"),
			});
			if (renameError) throw renameError;
			await refresh({
				organizationId: selectedOrganization.id,
				workspaceId: selectedWorkspaceId ?? undefined,
			});
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
			const { data, error: createError } = await client
				.from("workspaces")
				.insert({
					organization_id: targetOrganization.id,
					name: normalizeName(name, "Workspace"),
				})
				.select("id")
				.single();
			if (createError) throw createError;
			await refresh({
				organizationId: targetOrganization.id,
				workspaceId: String(data.id),
			});
		},
		[client, organizations, refresh, selectedOrganization],
	);

	const renameWorkspace = useCallback(
		async (workspaceId: string, name: string) => {
			if (!client) throw new Error("Authentication is still loading");
			const organization = organizations.find((candidate) =>
				candidate.workspaces.some((workspace) => workspace.id === workspaceId),
			);
			if (!organization) throw new Error("Workspace not found");
			const { error: renameError } = await client
				.from("workspaces")
				.update({ name: normalizeName(name, "Workspace") })
				.eq("id", workspaceId);
			if (renameError) throw renameError;
			await refresh({
				organizationId: organization.id,
				workspaceId,
			});
		},
		[client, organizations, refresh],
	);

	const deleteWorkspace = useCallback(
		async (workspaceId: string) => {
			if (!client) throw new Error("Authentication is still loading");
			const { error: deleteError } = await client.rpc("delete_workspace", {
				p_workspace_id: workspaceId,
			});
			if (deleteError) throw deleteError;
			await refresh();
		},
		[client, refresh],
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
	userId: string,
): Promise<Array<Organization>> {
	const { data: membershipRows, error: membershipError } = await client
		.from("organization_members")
		.select("organization_id, role")
		.eq("user_id", userId);
	if (membershipError) throw membershipError;
	if (!membershipRows || membershipRows.length === 0) return [];

	const membershipByOrganization = new Map(
		membershipRows.map((row) => [row.organization_id, row.role]),
	);
	const organizationIds = membershipRows.map((row) => row.organization_id);
	const { data: organizationRows, error: organizationError } = await client
		.from("organizations")
		.select("id, name, handle, created_at, updated_at")
		.in("id", organizationIds);
	if (organizationError) throw organizationError;

	const baseOrganizations = (organizationRows ?? []).map((row) => ({
		id: row.id,
		name: row.name,
		handle: row.handle,
		role: membershipByOrganization.get(row.id) ?? "member",
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		workspaces: [] as Array<Workspace>,
	}));

	const { data: workspaceRows, error: workspaceError } = await client
		.from("workspaces")
		.select("id, organization_id, name, slug, created_at, updated_at")
		.in("organization_id", organizationIds)
		.is("deleted_at", null)
		.order("created_at", { ascending: true });
	if (workspaceError) throw workspaceError;

	const workspaceByOrganization = new Map<string, Array<Workspace>>();
	for (const row of workspaceRows ?? []) {
		const organizationId = String(row.organization_id);
		const list = workspaceByOrganization.get(organizationId) ?? [];
		list.push({
			id: String(row.id),
			organizationId,
			name: String(row.name),
			slug: String(row.slug),
			createdAt: String(row.created_at),
			updatedAt: String(row.updated_at),
		});
		workspaceByOrganization.set(organizationId, list);
	}

	return baseOrganizations
		.map((organization) => ({
			...organization,
			workspaces: workspaceByOrganization.get(organization.id) ?? [],
		}))
		.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function E2eWorkspaceProvider({ children }: { children: ReactNode }) {
	const [organization, setOrganization] = useState<Organization>(() => ({
		id: E2E_ORGANIZATION_ID,
		name: E2E_ORGANIZATION_NAME,
		handle: E2E_ORGANIZATION_NAME,
		role: "owner",
		createdAt: "2026-07-01T12:00:00.000Z",
		updatedAt: "2026-07-12T18:58:00.000Z",
		workspaces: [
			{
				id: E2E_WORKSPACE_ID,
				organizationId: E2E_ORGANIZATION_ID,
				name: E2E_WORKSPACE_NAME,
				slug: E2E_WORKSPACE_NAME,
				createdAt: "2026-07-01T12:00:00.000Z",
				updatedAt: "2026-07-12T18:58:00.000Z",
			},
		],
	}));
	const [selectedWorkspaceId, setSelectedWorkspaceId] =
		useState(E2E_WORKSPACE_ID);
	const selectedWorkspace =
		organization.workspaces.find(
			(workspace) => workspace.id === selectedWorkspaceId,
		) ?? organization.workspaces[0];
	const unsupported = () =>
		Promise.reject(
			new Error("Workspace mutation is unavailable in E2E auth mode"),
		);
	const createWorkspace = (name: string, organizationId?: string) => {
		if (organizationId && organizationId !== organization.id) {
			throw new Error("Create or select an organization first");
		}
		const normalizedName = normalizeName(name, "Workspace");
		const now = new Date().toISOString();
		const workspace: Workspace = {
			id: E2E_CREATED_WORKSPACE_ID,
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
					(candidate) => candidate.id !== E2E_CREATED_WORKSPACE_ID,
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
			.slice(0, 100) || "workspace"
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
	return error instanceof Error ? error.message : "Unable to load workspaces";
}
