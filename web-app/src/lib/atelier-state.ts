import {
	coerceAtelierSessionUiState,
	coerceAtelierUserPreferences,
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
const PREFERENCES_STATE_VERSION = 1;
const REVIEW_STATE_VERSION = 1;

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

export function createWorkspaceBranchSession(args: {
	readonly lix: BrowserLix;
	readonly onSwitch: (
		branchId: string,
		context?: { readonly failedBranchId?: string },
	) => Promise<void> | void;
}): AtelierBranchSession {
	let latestSelection = 0;
	let pendingSelection = Promise.resolve();
	const select = <T>(
		operation: () => Promise<T>,
		branchId: (value: T) => string,
		failedBranchId?: string,
	): Promise<T> => {
		const selection = ++latestSelection;
		const result = pendingSelection.then(async () => {
			let value: T;
			try {
				value = await operation();
			} catch (error) {
				if (selection === latestSelection) {
					try {
						await args.onSwitch(
							args.lix.activeBranchSnapshot(),
							failedBranchId ? { failedBranchId } : undefined,
						);
					} catch {
						// Preserve the branch operation error. A later selection can retry
						// navigation without obscuring why this selection failed.
					}
				}
				throw error;
			}
			if (selection === latestSelection) {
				await args.onSwitch(branchId(value));
			}
			return value;
		});
		pendingSelection = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};
	return {
		getSnapshot: args.lix.activeBranchSnapshot.bind(args.lix),
		subscribe: args.lix.subscribeActiveBranch.bind(args.lix),
		createBranch: async (name: string) => {
			const branch = await select(
				() => args.lix.createBranch({ name }),
				(receipt) => receipt.id,
			);
			return branch.id;
		},
		switchBranch: async (branchId: string) => {
			await select(
				() =>
					args.lix.activeBranchSnapshot() === branchId
						? Promise.resolve({ branchId })
						: args.lix.switchBranch({ branchId }),
				(receipt) => receipt.branchId,
				branchId,
			);
		},
	};
}

export function createWorkspacePreferencesStore(args: {
	readonly client: LixraySupabaseClient | null;
	readonly userId: string;
	readonly workspaceId: string;
	readonly storage?: Storage;
}): AtelierPreferencesStore {
	const client = args.client;
	if (!client) {
		const storage = args.storage ?? window.sessionStorage;
		const key = namespacedSessionKey(
			"preferences",
			PREFERENCES_STATE_VERSION,
			args,
		);
		return {
			load: () => {
				const value = readSessionJson(storage, key);
				return Promise.resolve(
					value ? coerceAtelierUserPreferences(value) : null,
				);
			},
			save: (value: AtelierUserPreferencesV1) => {
				storage.setItem(
					key,
					JSON.stringify(coerceAtelierUserPreferences(value)),
				);
				return Promise.resolve();
			},
		};
	}
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
		save: async (value: AtelierUserPreferencesV1) => {
			const preferences = coerceAtelierUserPreferences(value);
			const { error } = await client.from("user_workspace_preferences").upsert(
				{
					user_id: args.userId,
					workspace_id: args.workspaceId,
					atelier_layout: preferences,
					updated_at: new Date().toISOString(),
				},
				{ onConflict: "user_id,workspace_id" },
			);
			if (error) throw error;
		},
	};
}

export function createWorkspaceReviewStatusStore(args: {
	readonly client: LixraySupabaseClient | null;
	readonly userId: string;
	readonly workspaceId: string;
	readonly storage?: Storage;
	readonly durableStorage?: Storage;
}): AtelierReviewStatusStore {
	const client = args.client;
	const storage =
		args.storage ??
		(client
			? (args.durableStorage ?? window.localStorage)
			: window.sessionStorage);
	const key = namespacedSessionKey("reviews", REVIEW_STATE_VERSION, args);
	const localReviewIds = (branchId: string) =>
		readReviewState(storage, key)
			.resolutions.filter((review) => review.branchId === branchId)
			.map((review) => review.reviewId);
	const persistRemote = async (review: AtelierReviewResolution) => {
		if (!client) return;
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
	};
	const flushPending = async () => {
		if (!client) return;
		const state = readReviewState(storage, key);
		for (const pendingKey of [...state.pending]) {
			const review = state.resolutions.find(
				(candidate) => reviewResolutionKey(candidate) === pendingKey,
			);
			if (!review) {
				state.pending = state.pending.filter((value) => value !== pendingKey);
				writeReviewState(storage, key, state);
				continue;
			}
			try {
				await persistRemote(review);
				const latest = readReviewState(storage, key);
				latest.pending = latest.pending.filter((value) => value !== pendingKey);
				writeReviewState(storage, key, latest);
			} catch {
				// The local acknowledgement is authoritative for this account in this
				// browser. Keep the idempotent upsert in the durable outbox for a later
				// load/retry.
			}
		}
	};
	return {
		loadResolvedReviewIds: async (branchId: string) => {
			await flushPending();
			const localIds = localReviewIds(branchId);
			if (!client) return [...new Set(localIds)];
			const { data, error } = await client
				.from("user_workspace_review_resolutions")
				.select("review_id")
				.eq("user_id", args.userId)
				.eq("workspace_id", args.workspaceId)
				.eq("branch_id", branchId);
			if (error) {
				if (localIds.length > 0) return [...new Set(localIds)];
				throw error;
			}
			return [...new Set([...localIds, ...data.map((row) => row.review_id)])];
		},
		resolve: async (review: AtelierReviewResolution) => {
			const state = readReviewState(storage, key);
			const reviewKey = reviewResolutionKey(review);
			state.resolutions = [
				...state.resolutions.filter(
					(candidate) => reviewResolutionKey(candidate) !== reviewKey,
				),
				review,
			];
			state.pending = [...new Set([...state.pending, reviewKey])];
			writeReviewState(storage, key, state);
			await flushPending();
		},
	};
}

type StoredReviewState = {
	resolutions: AtelierReviewResolution[];
	pending: string[];
};

function readReviewState(storage: Storage, key: string): StoredReviewState {
	const value = readSessionJson(storage, key);
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { resolutions: [], pending: [] };
	}
	const candidate = value as { resolutions?: unknown; pending?: unknown };
	return {
		resolutions: Array.isArray(candidate.resolutions)
			? candidate.resolutions.filter(isReviewResolution)
			: [],
		pending: Array.isArray(candidate.pending)
			? candidate.pending.filter(
					(pendingKey): pendingKey is string => typeof pendingKey === "string",
				)
			: [],
	};
}

function writeReviewState(
	storage: Storage,
	key: string,
	state: StoredReviewState,
): void {
	storage.setItem(key, JSON.stringify(state));
}

function isReviewResolution(value: unknown): value is AtelierReviewResolution {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const review = value as Partial<AtelierReviewResolution>;
	return (
		typeof review.branchId === "string" &&
		typeof review.reviewId === "string" &&
		typeof review.fileId === "string" &&
		(review.outcome === "accepted" ||
			review.outcome === "rejected" ||
			review.outcome === "resolved")
	);
}

function reviewResolutionKey(review: AtelierReviewResolution): string {
	return JSON.stringify([review.branchId, review.reviewId, review.fileId]);
}

function namespacedSessionKey(
	family: "shell" | "preferences" | "reviews",
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
