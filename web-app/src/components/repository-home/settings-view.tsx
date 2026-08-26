import { Copy } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { MemberAvatar } from "./people-view";
import { Button } from "~/components/ui/button";
import { formatCaughtError } from "~/lib/format";

export interface DirectRepositoryMember {
	accountId: string;
	name: string;
	email: string | null;
	avatarUrl: string | null;
	role: "admin" | "member";
}

/**
 * Closure-based API for the settings tab: the extension mounts in its own
 * React root outside the app's providers, so everything it needs arrives as
 * callbacks (same pattern as RepositoryTeamApi).
 */
export interface RepositorySettingsApi {
	info(): {
		namespaceHandle: string;
		repositorySlug: string;
		repositoryName: string;
		isAdmin: boolean;
		visibility: "private" | "public";
		currentAccountId: string | null;
	};
	rename(name: string): Promise<void>;
	listDirectMembers(): Promise<readonly DirectRepositoryMember[]>;
	removeDirectMember(accountId: string): Promise<void>;
	setMemberRole(accountId: string, role: "admin" | "member"): Promise<void>;
	setVisibility(visibility: "private" | "public"): Promise<void>;
	getInviteLink(): Promise<string>;
	/** Deletes and navigates away; the tab unmounts with the workspace. */
	deleteRepository(): Promise<void>;
}

/**
 * The Settings tab: repository management as a regular closable central tab
 * (flow A) — name, the unified "Who has access" list, and the danger zone.
 */
export function SettingsView({
	settingsApi,
}: {
	settingsApi: RepositorySettingsApi | null;
}) {
	if (!settingsApi) {
		return (
			<div className="grid h-full w-full place-content-center bg-bg-panel p-6 text-center text-[13px] text-text-secondary">
				Sign in with edit access to manage this repository.
			</div>
		);
	}
	return <SettingsContent settingsApi={settingsApi} />;
}

function SettingsContent({
	settingsApi,
}: {
	settingsApi: RepositorySettingsApi;
}) {
	const info = settingsApi.info();
	return (
		<div className="h-full w-full overflow-auto bg-bg-panel">
			<div className="mx-auto w-[min(640px,calc(100%-48px))] pt-10 pb-16">
				<h2 className="m-0 text-[16px] leading-tight font-bold tracking-[-0.01em]">
					Settings
				</h2>
				<p className="m-0 mt-0.5 mb-5 text-[12.5px] text-text-tertiary">
					lixray.com/@{info.namespaceHandle}/{info.repositorySlug}
				</p>
				<NamePanel settingsApi={settingsApi} />
				<AccessPanel settingsApi={settingsApi} />
				{info.isAdmin ? <DangerPanel settingsApi={settingsApi} /> : null}
			</div>
		</div>
	);
}

function NamePanel({ settingsApi }: { settingsApi: RepositorySettingsApi }) {
	const info = settingsApi.info();
	const [name, setName] = useState(info.repositoryName);
	const [savedName, setSavedName] = useState(info.repositoryName);
	const [busy, setBusy] = useState(false);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		try {
			await settingsApi.rename(name);
			setSavedName(name.trim());
			toast.success(`Renamed to “${name.trim()}”`);
		} catch (caught) {
			toast.error(formatCaughtError(caught));
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className="mb-3.5 rounded-xl border border-border-panel px-[18px] py-4">
			<h3 className="m-0 text-[13.5px] font-bold">Name</h3>
			<p className="m-0 mt-0.5 mb-3 text-[12px] text-text-tertiary">
				Renaming keeps the URL — the address stays{" "}
				<code className="rounded bg-bg-hover px-1.5 py-0.5 text-[11.5px]">
					@{info.namespaceHandle}/{info.repositorySlug}
				</code>
				.
			</p>
			<form className="flex gap-2" onSubmit={(event) => void submit(event)}>
				<input
					className="h-9 min-w-0 flex-1 rounded-lg border border-border-panel bg-bg-panel px-[11px] text-[13px] text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring-focus-visible focus-visible:ring-offset-1 disabled:opacity-60"
					maxLength={80}
					value={name}
					disabled={!info.isAdmin}
					onChange={(event) => setName(event.target.value)}
				/>
				<Button
					type="submit"
					variant="outline"
					size="sm"
					className="h-9"
					disabled={
						!info.isAdmin || busy || !name.trim() || name.trim() === savedName
					}
				>
					{busy ? "Saving…" : "Save"}
				</Button>
			</form>
			{!info.isAdmin ? (
				<p className="m-0 mt-2 text-[12px] text-text-quaternary">
					Only repository admins can rename this repository.
				</p>
			) : null}
		</section>
	);
}

function AccessPanel({ settingsApi }: { settingsApi: RepositorySettingsApi }) {
	const info = settingsApi.info();
	const [directMembers, setDirectMembers] = useState<
		readonly DirectRepositoryMember[] | null
	>(null);
	const [visibility, setVisibility] = useState(info.visibility);
	const [confirmingRemoval, setConfirmingRemoval] = useState<string | null>(
		null,
	);

	useEffect(() => {
		let cancelled = false;
		settingsApi
			.listDirectMembers()
			.then((members) => {
				if (!cancelled) setDirectMembers(members);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [settingsApi]);

	const copyInviteLink = async () => {
		try {
			await navigator.clipboard.writeText(await settingsApi.getInviteLink());
			toast.success("Invite link copied");
		} catch (caught) {
			toast.error(formatCaughtError(caught));
		}
	};

	const removeMember = async (member: DirectRepositoryMember) => {
		try {
			await settingsApi.removeDirectMember(member.accountId);
			setDirectMembers(
				(current) =>
					current?.filter((entry) => entry.accountId !== member.accountId) ??
					null,
			);
			toast.success(`Removed ${member.name || member.email || "account"}`);
		} catch (caught) {
			toast.error(formatCaughtError(caught));
		} finally {
			setConfirmingRemoval(null);
		}
	};

	const promoteMember = async (member: DirectRepositoryMember) => {
		try {
			await settingsApi.setMemberRole(member.accountId, "admin");
			setDirectMembers(
				(current) =>
					current?.map((entry) =>
						entry.accountId === member.accountId
							? { ...entry, role: "admin" }
							: entry,
					) ?? null,
			);
			toast.success(
				`${member.name || member.email || "Account"} is now an admin`,
			);
		} catch (caught) {
			toast.error(formatCaughtError(caught));
		}
	};

	const changeVisibility = async () => {
		const next = visibility === "private" ? "public" : "private";
		try {
			await settingsApi.setVisibility(next);
			setVisibility(next);
			toast.success(`Repository is now ${next}`);
		} catch (caught) {
			toast.error(formatCaughtError(caught));
		}
	};

	return (
		<section className="mb-3.5 rounded-xl border border-border-panel px-[18px] py-4">
			<div className="mb-3 flex items-center gap-3 border-b border-border-subtle pb-3">
				<div className="min-w-0 flex-1">
					<h3 className="m-0 text-[13.5px] font-bold">Repository visibility</h3>
					<p className="m-0 mt-0.5 text-[12px] text-text-tertiary">
						{visibility === "public"
							? "Anyone can read. Only members can edit."
							: "Only repository members can open this repository. Published files remain public."}
					</p>
				</div>
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={!info.isAdmin}
					onClick={() => void changeVisibility()}
				>
					{visibility === "public" ? "Make private" : "Make public"}
				</Button>
			</div>
			<div className="flex items-center gap-2">
				<h3 className="m-0 text-[13.5px] font-bold">Who has access</h3>
			</div>
			<p className="m-0 mt-1 mb-2 text-[12px] text-text-tertiary">
				Admins can promote members and remove member access.
			</p>
			{directMembers?.map((member) => {
				const isSelf = member.accountId === info.currentAccountId;
				return (
					<div
						key={member.accountId}
						className="flex items-center gap-2.5 border-t border-border-subtle py-2"
					>
						<MemberAvatar
							member={{
								name: member.name || member.email || "Account",
								avatarUrl: member.avatarUrl,
							}}
							className="size-6 text-[11px]"
						/>
						<span className="flex min-w-0 flex-col">
							<span className="truncate text-[13px] leading-tight font-semibold">
								{member.name || member.email || "Account"}
								{isSelf ? (
									<span className="ml-1.5 font-normal text-text-quaternary">
										you
									</span>
								) : null}
							</span>
							{member.email ? (
								<span className="truncate text-[11.5px] leading-tight text-text-tertiary">
									{member.email}
								</span>
							) : null}
						</span>
						<span className="ml-auto rounded-[7px] border border-border-panel px-2 py-1 text-[12px] text-text-secondary">
							{member.role === "admin" ? "Admin" : "Member"}
						</span>
						{info.isAdmin && member.role === "member" ? (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="h-7 text-text-tertiary"
								onClick={() => void promoteMember(member)}
							>
								Make admin
							</Button>
						) : null}
						{member.role === "member" && (info.isAdmin || isSelf) ? (
							confirmingRemoval === member.accountId ? (
								<Button
									type="button"
									variant="destructive"
									size="sm"
									className="h-7"
									onClick={() => void removeMember(member)}
								>
									Confirm
								</Button>
							) : (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="h-7 text-text-tertiary"
									onClick={() => setConfirmingRemoval(member.accountId)}
								>
									{isSelf ? "Leave" : "Remove"}
								</Button>
							)
						) : null}
					</div>
				);
			})}
			<div className="mt-3 flex items-center gap-3 rounded-lg border border-border-subtle bg-bg-hover px-3 py-2.5">
				<div className="min-w-0 flex-1">
					<p className="m-0 text-[12.5px] font-semibold text-text-primary">
						Invite members
					</p>
					<p className="m-0 mt-0.5 text-[11.5px] text-text-tertiary">
						Anyone with the invite link can join this repository as a member.
					</p>
				</div>
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="h-8 shrink-0 gap-1.5"
					onClick={() => void copyInviteLink()}
				>
					<Copy className="size-3" aria-hidden="true" />
					Copy invite link
				</Button>
			</div>
		</section>
	);
}

function DangerPanel({ settingsApi }: { settingsApi: RepositorySettingsApi }) {
	const info = settingsApi.info();
	const [confirmation, setConfirmation] = useState("");
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);

	const remove = async () => {
		setBusy(true);
		try {
			await settingsApi.deleteRepository();
			toast.success(`Deleted “${info.repositoryName}”`);
		} catch (caught) {
			toast.error(formatCaughtError(caught));
			setBusy(false);
		}
	};

	return (
		<section className="rounded-xl border border-error-200 px-[18px] py-4">
			<h3 className="m-0 text-[13.5px] font-bold text-error-700">
				Danger zone
			</h3>
			<p className="m-0 mt-0.5 mb-3 text-[12px] text-text-tertiary">
				Deleting removes the repository from every member’s directory and keeps
				its name reserved.
			</p>
			{open ? (
				<div className="flex flex-wrap items-center gap-2">
					<input
						className="h-9 min-w-0 flex-1 rounded-lg border border-border-panel bg-bg-panel px-[11px] text-[13px] text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring-focus-visible focus-visible:ring-offset-1"
						autoFocus
						placeholder={`Type “${info.repositoryName}” to confirm`}
						value={confirmation}
						onChange={(event) => setConfirmation(event.target.value)}
					/>
					<Button
						type="button"
						variant="destructive"
						size="sm"
						className="h-9"
						disabled={busy || confirmation !== info.repositoryName}
						onClick={() => void remove()}
					>
						{busy ? "Deleting…" : "Delete repository"}
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-9 text-text-tertiary"
						onClick={() => {
							setOpen(false);
							setConfirmation("");
						}}
					>
						Cancel
					</Button>
				</div>
			) : (
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="h-9 border-error-200 text-error-700 hover:bg-error-50"
					onClick={() => setOpen(true)}
				>
					Delete repository…
				</Button>
			)}
		</section>
	);
}
