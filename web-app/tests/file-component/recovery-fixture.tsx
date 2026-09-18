import type { Lix, ReplicaRecoverySource } from "@lix-js/sdk";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { RepositoryOpenFailure } from "../../src/components/repository-open-failure";
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

function OpenFailureFixture() {
	const [retrying, setRetrying] = useState(false);
	return retrying ? (
		<p role="status">Opening repository</p>
	) : (
		<RepositoryOpenFailure
			message="Unrelated opening error"
			storageBusy={mode === "storage-busy"}
			onRetry={() => setRetrying(true)}
		/>
	);
}

function Fixture() {
	const [otherAccount, setOtherAccount] = useState(false);
	const lix = useMemo(
		() =>
			({
				async replicaRecoverySources() {
					if (otherAccount) return [];
					if (mode === "list-error" && attempts++ === 0)
						throw new Error("Device storage is busy");
					return [{ ...source, recoveryRequired: mode !== "clean" }];
				},
				async exportReplicaRecovery() {
					if (mode === "export-error")
						throw new Error("Saved content is not available yet");
					if (mode === "delayed")
						await new Promise<void>((resolve) => {
							resolveRecovery = resolve;
						});
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
				Finish old download
			</button>
			<ReplicaRecovery lix={lix} />
		</>
	);
}

createRoot(document.getElementById("root")!).render(
	mode === "storage-busy" || mode === "open-error" ? (
		<OpenFailureFixture />
	) : (
		<Fixture />
	),
);
