import { REPOSITORY_CLIENT_UPDATE_MESSAGE } from "../../src/lib/repository-open-error";
import { DeviceReplicaRecovery } from "../../src/components/device-replica-recovery";
import { BROWSER_REPLICA_STORAGE_KEY_PREFIX } from "../../src/lib/repository-opfs-cache";
import { opfsBackupName } from "../../src/lib/repository-device-backup";
import type { Lix, ReplicaRecoverySource } from "@lix-js/sdk";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { RepositoryOpenFailure } from "../../src/components/repository-open-failure";
import { ReplicaRecovery } from "../../src/components/replica-recovery";

const mode = new URLSearchParams(location.search).get("mode");
if (mode === "client-update")
	sessionStorage.setItem(
		"fixture-loads",
		String(Number(sessionStorage.getItem("fixture-loads") ?? "0") + 1),
	);
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
			message={
				mode === "client-update"
					? REPOSITORY_CLIENT_UPDATE_MESSAGE
					: "Unrelated opening error"
			}
			storageBusy={mode === "storage-busy"}
			resetInProgress={mode === "reset-busy"}
			reloadRequired={mode === "client-update"}
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

function ResetFixture() {
	const [calls, setCalls] = useState(0);
	if (sessionStorage.getItem("reset-complete") === "yes")
		return <p>Fresh replica opening</p>;
	return (
		<>
			<p>Reset requests: {calls}</p>
			<DeviceReplicaRecovery
				repositoryId="reset-fixture"
				authIdentity="account"
				openingFailed
				onReset={async () => {
					setCalls((value) => value + 1);
					if (mode === "device-reset-error")
						throw new Error("Reset refused: another tab owns the repository");
					sessionStorage.setItem("reset-complete", "yes");
					return "fresh-copy";
				}}
			/>
		</>
	);
}
if (mode?.startsWith("device-reset")) {
	localStorage.setItem(
		`${BROWSER_REPLICA_STORAGE_KEY_PREFIX}${encodeURIComponent("account:reset-fixture")}`,
		"fixture",
	);
	const root = await navigator.storage.getDirectory();
	const lix = await root.getDirectoryHandle("lix", { create: true });
	const pool = await lix.getDirectoryHandle("sqlite-sahpool", { create: true });
	const store = await pool.getDirectoryHandle(
		opfsBackupName("lixray:local-first-v1:reset-fixture:account:fixture"),
		{ create: true },
	);
	const file = await store.getFileHandle("saved-data", { create: true });
	const writer = await file.createWritable();
	await writer.write("unpublished fixture work");
	await writer.close();
}
createRoot(document.getElementById("root")!).render(
	mode?.startsWith("device-reset") ? (
		<ResetFixture />
	) : ["storage-busy", "open-error", "client-update", "reset-busy"].includes(
			mode ?? "",
	  ) ? (
		<OpenFailureFixture />
	) : (
		<Fixture />
	),
);
