import {
	coerceAtelierSessionUiState,
	coerceAtelierUserPreferences,
	createLixPreferencesStore,
	createLixSessionStateStore,
	type AtelierClientState,
	type AtelierBranchSession,
	type AtelierPreferencesStore,
	type AtelierReviewStatusStore,
	type AtelierReviewResolution,
	type AtelierSessionStateStore,
	type AtelierSessionUiState,
	type AtelierUserPreferencesV1,
} from "@opral/atelier/state-adapters";
import type { LixraySupabaseClient } from "./supabase";
import type { RepositoryLixSession } from "./repository-lix-session";

const SESSION_STATE_VERSION = 1;
const PREFERENCES_STATE_VERSION = 1;
const REVIEW_STATE_VERSION = 1;

export function createRepositorySessionStateStore(args: {
	readonly userId: string;
	readonly repositoryId: string;
	readonly clientState?: AtelierClientState;
	readonly storage?: Storage;
	/**
	 * Adjusts the snapshot once at store creation, receiving the persisted
	 * state (null on a first visit) — e.g. the empty-repository
	 * getting-started seed. The result is not persisted until the shell's
	 * first own write.
	 */
	readonly initializeSnapshot?: (
		persisted: AtelierSessionUiState | null,
	) => AtelierSessionUiState | null;
}): AtelierSessionStateStore {
	if (args.clientState) {
		const store = createLixSessionStateStore(args.clientState);
		if (args.initializeSnapshot) {
			const initialized = args.initializeSnapshot(store.getSnapshot());
			if (initialized) store.setSnapshot(initialized);
		}
		return store;
	}
	const key = namespacedAtelierStateKey("shell", SESSION_STATE_VERSION, args);
	const storage = args.storage ?? window.localStorage;
	const value = readStoredJson(storage, key);
	const persisted: AtelierSessionUiState | null = value
		? coerceAtelierSessionUiState(value)
		: null;
	let snapshot: AtelierSessionUiState | null = args.initializeSnapshot
		? args.initializeSnapshot(persisted)
		: persisted;
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

/**
 * Atelier only observes the active branch; LixRay keeps the mutation
 * surface (create/switch) for its own routing and UI.
 */
export type RepositoryBranchSession = AtelierBranchSession & {
	createBranch(name: string): Promise<string>;
	switchBranch(branchId: string): Promise<void>;
};

export function createRepositoryBranchSession(args: {
	readonly session: RepositoryLixSession;
	readonly onSwitch: (
		branchId: string,
		context?: { readonly failedBranchId?: string },
	) => Promise<void> | void;
}): RepositoryBranchSession {
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
							args.session.activeBranchSnapshot(),
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
		getSnapshot: args.session.activeBranchSnapshot.bind(args.session),
		subscribe: args.session.subscribeActiveBranch.bind(args.session),
		createBranch: async (name: string) => {
			return select(
				() => args.session.createBranch(name),
				(branchId) => branchId,
			);
		},
		switchBranch: async (branchId: string) => {
			await select(
				() =>
					args.session.activeBranchSnapshot() === branchId
						? Promise.resolve(branchId)
						: args.session.switchBranch(branchId),
				(selectedBranchId) => selectedBranchId,
				branchId,
			);
		},
	};
}

export function createRepositoryPreferencesStore(args: {
	readonly client: LixraySupabaseClient | null;
	readonly userId: string;
	readonly repositoryId: string;
	readonly clientState?: AtelierClientState;
	readonly storage?: Storage;
}): AtelierPreferencesStore {
	if (args.clientState) {
		return createLixPreferencesStore(args.clientState);
	}
	const client = args.client;
	if (!client) {
		const storage = args.storage ?? window.sessionStorage;
		const key = namespacedAtelierStateKey(
			"preferences",
			PREFERENCES_STATE_VERSION,
			args,
		);
		return {
			load: () => {
				const value = readStoredJson(storage, key);
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
				.from("user_lix_preferences")
				.select("atelier_layout")
				.eq("user_id", args.userId)
				.eq("lix_id", args.repositoryId)
				.maybeSingle();
			if (error) throw error;
			return data?.atelier_layout
				? coerceAtelierUserPreferences(data.atelier_layout)
				: null;
		},
		save: async (value: AtelierUserPreferencesV1) => {
			const preferences = coerceAtelierUserPreferences(value);
			const { error } = await client.from("user_lix_preferences").upsert(
				{
					user_id: args.userId,
					lix_id: args.repositoryId,
					atelier_layout: preferences,
					updated_at: new Date().toISOString(),
				},
				{ onConflict: "user_id,lix_id" },
			);
			if (error) throw error;
		},
	};
}

export function createRepositoryReviewStatusStore(args: {
	readonly client: LixraySupabaseClient | null;
	readonly userId: string;
	readonly repositoryId: string;
	readonly storage?: Storage;
	readonly durableStorage?: Storage;
}): AtelierReviewStatusStore {
	const client = args.client;
	const storage =
		args.storage ??
		(client
			? (args.durableStorage ?? window.localStorage)
			: window.sessionStorage);
	const key = namespacedAtelierStateKey("reviews", REVIEW_STATE_VERSION, args);
	const localReviewIds = (branchId: string) =>
		readReviewState(storage, key)
			.resolutions.filter((review) => review.branchId === branchId)
			.map((review) => review.reviewId);
	const persistRemote = async (review: AtelierReviewResolution) => {
		if (!client) return;
		const { error } = await client.from("user_lix_review_resolutions").upsert(
			{
				user_id: args.userId,
				lix_id: args.repositoryId,
				branch_id: review.branchId,
				review_id: review.reviewId,
				file_id: review.fileId,
				outcome: review.outcome,
				resolved_at: new Date().toISOString(),
			},
			{
				onConflict: "user_id,lix_id,branch_id,review_id,file_id",
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
				.from("user_lix_review_resolutions")
				.select("review_id")
				.eq("user_id", args.userId)
				.eq("lix_id", args.repositoryId)
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
	const value = readStoredJson(storage, key);
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

function namespacedAtelierStateKey(
	family: "shell" | "preferences" | "reviews",
	version: number,
	args: { readonly userId: string; readonly repositoryId: string },
): string {
	return `lixray.atelier.${family}.v${version}:${args.userId}:${args.repositoryId}`;
}

function readStoredJson(storage: Storage, key: string): unknown {
	const encoded = storage.getItem(key);
	if (!encoded) return null;
	try {
		return JSON.parse(encoded) as unknown;
	} catch {
		storage.removeItem(key);
		return null;
	}
}
