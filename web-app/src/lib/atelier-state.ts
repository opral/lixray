import {
	coerceAtelierSessionUiState,
	coerceAtelierUserPreferences,
	createMemoryPreferencesStore,
	createMemoryReviewStatusStore,
	type AtelierBranchSession,
	type AtelierPreferencesStore,
	type AtelierReviewStatusStore,
	type AtelierReviewResolution,
	type AtelierSessionStateStore,
	type AtelierSessionUiState,
	type AtelierUserPreferencesV1,
} from "@opral/atelier/state-adapters";
import type { BrowserLix } from "./mock-remote-lix";
import type { LixraySupabaseClient } from "./supabase";

const SESSION_STATE_VERSION = 1;
const BRANCH_STATE_VERSION = 1;

export function createWorkspaceSessionStateStore(args: {
	readonly userId: string;
	readonly workspaceId: string;
	readonly storage?: Storage;
}): AtelierSessionStateStore {
	const storage = args.storage ?? window.sessionStorage;
	const key = namespacedSessionKey("shell", SESSION_STATE_VERSION, args);
	const value = readSessionJson(storage, key);
	let snapshot: AtelierSessionUiState | null = value
		? coerceAtelierSessionUiState(value)
		: null;
	const listeners = new Set<() => void>();
	return {
		getSnapshot: () => snapshot,
		setSnapshot: (nextValue: AtelierSessionUiState) => {
			const next = coerceAtelierSessionUiState(nextValue);
			if (JSON.stringify(snapshot) === JSON.stringify(next)) return;
			snapshot = next;
			storage.setItem(key, JSON.stringify(next));
			for (const listener of [...listeners]) listener();
		},
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

export function readWorkspaceSessionBranch(args: {
	readonly userId: string;
	readonly workspaceId: string;
	readonly storage?: Storage;
}): string | null {
	const storage = args.storage ?? window.sessionStorage;
	const key = namespacedSessionKey("branch", BRANCH_STATE_VERSION, args);
	const branchId = storage.getItem(key);
	return branchId && branchId.length > 0 ? branchId : null;
}

export function createWorkspaceBranchSession(args: {
	readonly lix: BrowserLix;
	readonly userId: string;
	readonly workspaceId: string;
	readonly onSwitch: (branchId: string) => Promise<void> | void;
	readonly storage?: Storage;
}): AtelierBranchSession {
	const storage = args.storage ?? window.sessionStorage;
	const key = namespacedSessionKey("branch", BRANCH_STATE_VERSION, args);
	const persist = () => {
		storage.setItem(key, args.lix.activeBranchSnapshot());
	};
	persist();
	return {
		getSnapshot: args.lix.activeBranchSnapshot.bind(args.lix),
		subscribe: args.lix.subscribeActiveBranch.bind(args.lix),
		switchBranch: async (branchId: string) => {
			const receipt = await args.lix.switchBranch({ branchId });
			persist();
			await args.onSwitch(receipt.branchId);
		},
	};
}

export function createWorkspacePreferencesStore(args: {
	readonly client: LixraySupabaseClient | null;
	readonly userId: string;
	readonly workspaceId: string;
}): AtelierPreferencesStore {
	const client = args.client;
	if (!client) return createMemoryPreferencesStore();
	let pendingSave: Promise<void> = Promise.resolve();
	return {
		load: async () => {
			const { data, error } = await client
				.from("user_workspace_preferences")
				.select("atelier_layout")
				.eq("user_id", args.userId)
				.eq("workspace_id", args.workspaceId)
				.maybeSingle();
			if (error) throw error;
			return data?.atelier_layout
				? coerceAtelierUserPreferences(data.atelier_layout)
				: null;
		},
		save: (value: AtelierUserPreferencesV1) => {
			const preferences = coerceAtelierUserPreferences(value);
			const save = pendingSave
				.catch(() => undefined)
				.then(async () => {
					const { error } = await client
						.from("user_workspace_preferences")
						.upsert(
							{
								user_id: args.userId,
								workspace_id: args.workspaceId,
								atelier_layout: preferences,
								updated_at: new Date().toISOString(),
							},
							{ onConflict: "user_id,workspace_id" },
						);
					if (error) throw error;
				});
			pendingSave = save;
			return save;
		},
	};
}

export function createWorkspaceReviewStatusStore(args: {
	readonly client: LixraySupabaseClient | null;
	readonly userId: string;
	readonly workspaceId: string;
}): AtelierReviewStatusStore {
	const client = args.client;
	if (!client) return createMemoryReviewStatusStore();
	return {
		loadResolvedReviewIds: async (branchId: string) => {
			const { data, error } = await client
				.from("user_workspace_review_resolutions")
				.select("review_id")
				.eq("user_id", args.userId)
				.eq("workspace_id", args.workspaceId)
				.eq("branch_id", branchId);
			if (error) throw error;
			return data.map((row) => row.review_id);
		},
		resolve: async (review: AtelierReviewResolution) => {
			const { error } = await client
				.from("user_workspace_review_resolutions")
				.upsert(
					{
						user_id: args.userId,
						workspace_id: args.workspaceId,
						branch_id: review.branchId,
						review_id: review.reviewId,
						file_id: review.fileId,
						outcome: review.outcome,
						resolved_at: new Date().toISOString(),
					},
					{
						onConflict: "user_id,workspace_id,branch_id,review_id,file_id",
					},
				);
			if (error) throw error;
		},
	};
}

function namespacedSessionKey(
	family: "shell" | "branch",
	version: number,
	args: { readonly userId: string; readonly workspaceId: string },
): string {
	return `lixray.atelier.${family}.v${version}:${args.userId}:${args.workspaceId}`;
}

function readSessionJson(storage: Storage, key: string): unknown {
	const encoded = storage.getItem(key);
	if (!encoded) return null;
	try {
		return JSON.parse(encoded) as unknown;
	} catch {
		storage.removeItem(key);
		return null;
	}
}
