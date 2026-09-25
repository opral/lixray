import type { Lix } from "@lix-js/sdk";

/** A diagnostic handle can be reopened after a failed handshake or export. */
export function createRepositoryDebugRemote(
	open: () => Promise<Lix>,
	activeBranchId: () => string,
) {
	let current: Promise<Lix> | null = null;
	let closed = false;

	const acquire = (): Promise<Lix> => {
		if (closed) return Promise.reject(new Error("Debug session is closed"));
		if (current) return current;
		const opening = open();
		current = opening;
		void opening.catch(() => {
			if (current === opening) current = null;
		});
		return opening;
	};

	const discard = async (remote: Lix) => {
		if (current && (await current) === remote) current = null;
		await remote.close().catch(() => undefined);
	};

	return {
		async selectedBranch(): Promise<Lix> {
			const remote = await acquire();
			try {
				const branchId = activeBranchId();
				if ((await remote.activeBranchId()) !== branchId) {
					await remote.switchBranch({ branchId });
				}
				return remote;
			} catch (error) {
				await discard(remote);
				throw error;
			}
		},
		async snapshot(): Promise<Blob> {
			const remote = await acquire();
			try {
				// A snapshot contains every branch. Its export must not depend on
				// switching a diagnostic SQL session to the selected branch.
				return await new Response(remote.exportSnapshot(), {
					headers: { "Content-Type": "application/vnd.lix.snapshot" },
				}).blob();
			} catch (error) {
				await discard(remote);
				throw error;
			}
		},
		async close(): Promise<void> {
			closed = true;
			const opening = current;
			current = null;
			if (opening) {
				await opening.then((remote) => remote.close()).catch(() => undefined);
			}
		},
	};
}
