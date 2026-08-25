export const REPOSITORY_OPEN_MARKS = {
	start: "lixray:repository-open:start",
	replicaIdentified: "lixray:repository-open:replica-identified",
	lixOpened: "lixray:repository-open:lix-opened",
	branchReady: "lixray:repository-open:branch-ready",
	sessionReady: "lixray:repository-open:session-ready",
	atelierReady: "lixray:repository-open:atelier-ready",
	treeReady: "lixray:repository-open:tree-ready",
} as const;

export function resetRepositoryOpenPerformance(): void {
	if (typeof performance === "undefined") return;
	for (const mark of Object.values(REPOSITORY_OPEN_MARKS)) {
		performance.clearMarks(mark);
	}
	performance.mark(REPOSITORY_OPEN_MARKS.start);
}

export function markRepositoryOpenPerformance(
	mark: (typeof REPOSITORY_OPEN_MARKS)[keyof typeof REPOSITORY_OPEN_MARKS],
): void {
	if (typeof performance === "undefined") return;
	performance.clearMarks(mark);
	performance.mark(mark);
}
