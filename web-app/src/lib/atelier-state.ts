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
import type { RepositoryLixSession } from "./repository-lix-session";

// 2: the Library became the left panel, open by default. Layouts saved
// before it kept the left area collapsed; they start fresh once.
// 3: the Library tab is no longer the pinned home; tabs saved pinned would
// stay unclosable.
const SESSION_STATE_VERSION = 3;
const PREFERENCES_STATE_VERSION = 2;
const REVIEW_STATE_VERSION = 1;

export function createRepositorySessionStateStore(args: {
	readonly accountId: string;
	readonly repositoryId: string;
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
	const key = namespacedAtelierStateKey("shell", SESSION_STATE_VERSION, args);
	const storage = args.storage ?? window.sessionStorage;
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
	readonly accountId: string;
	readonly repositoryId: string;
	readonly storage?: Storage;
}): AtelierPreferencesStore {
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
			storage.setItem(key, JSON.stringify(coerceAtelierUserPreferences(value)));
			return Promise.resolve();
		},
	};
}

export function createRepositoryReviewStatusStore(args: {
	readonly accountId: string;
	readonly repositoryId: string;
	readonly storage?: Storage;
}): AtelierReviewStatusStore {
	const storage = args.storage ?? window.sessionStorage;
	const key = namespacedAtelierStateKey("reviews", REVIEW_STATE_VERSION, args);
	const localReviewIds = (branchId: string) =>
		readReviewState(storage, key)
			.resolutions.filter((review) => review.branchId === branchId)
			.map((review) => review.reviewId);
	return {
		loadResolvedReviewIds: (branchId: string) =>
			Promise.resolve([...new Set(localReviewIds(branchId))]),
		resolve: (review: AtelierReviewResolution) => {
			const state = readReviewState(storage, key);
			const reviewKey = reviewResolutionKey(review);
			state.resolutions = [
				...state.resolutions.filter(
					(candidate) => reviewResolutionKey(candidate) !== reviewKey,
				),
				review,
			];
			writeReviewState(storage, key, state);
			return Promise.resolve();
		},
	};
}

type StoredReviewState = {
	resolutions: AtelierReviewResolution[];
};

function readReviewState(storage: Storage, key: string): StoredReviewState {
	const value = readStoredJson(storage, key);
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { resolutions: [] };
	}
	const candidate = value as { resolutions?: unknown };
	return {
		resolutions: Array.isArray(candidate.resolutions)
			? candidate.resolutions.filter(isReviewResolution)
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
	args: { readonly accountId: string; readonly repositoryId: string },
): string {
	return `lixray.atelier.${family}.v${version}:${args.accountId}:${args.repositoryId}`;
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
