import type { Lix, ReplicaRecoverySource } from "@lix-js/sdk";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ReplicaRecovery } from "../../src/components/replica-recovery";

const mode = new URLSearchParams(location.search).get("mode");
const source: ReplicaRecoverySource = {
	id: "legacy",
	sourceFormat: 77,
	repositoryId: "repo",
	accountId: "account",
	recoveryRequired: true,
};
let attempts = 0;
let resolveRecovery: (() => void) | undefined;

function Fixture() {
	const [otherAccount, setOtherAccount] = useState(false);
	const [branch, setBranch] = useState("");
	const lix = useMemo(
		() =>
			({
				async replicaRecoverySources() {
					if (otherAccount) return [];
					if (mode === "list-error" && attempts++ === 0)
						throw new Error("Device storage is busy");
					return [{ ...source, recoveryRequired: mode !== "clean" }];
				},
				async recoverReplica() {
					if (mode === "recover-error")
						throw new Error("Saved content is not available yet");
					if (mode === "delayed")
						await new Promise<void>((resolve) => {
							resolveRecovery = resolve;
						});
					return {
						branchIds: ["recovered-branch"],
						restoredFiles: 1,
						restoredRows: 2,
						unresolved: ["A local-only value remains on this device"],
					};
				},
				async exportReplicaRecovery() {
					return {
						version: 1,
						source,
						files: [],
						unresolved: ["Local-only value preserved"],
					};
				},
			}) as unknown as Lix,
		[otherAccount],
	);
	return (
		<>
			<p>Current repository remains usable</p>
			<button
				type="button"
				onClick={() => setOtherAccount((previous) => !previous)}
			>
				Switch account
			</button>
			<button type="button" onClick={() => resolveRecovery?.()}>
				Finish old recovery
			</button>
			<output>{branch}</output>
			<ReplicaRecovery lix={lix} onReviewBranch={setBranch} />
		</>
	);
}

createRoot(document.getElementById("root")!).render(<Fixture />);
