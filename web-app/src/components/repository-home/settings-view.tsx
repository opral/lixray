import { Check, Copy, Globe2, LockKeyhole } from "lucide-react";
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
		repositoryId: string;
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
			<div
				className="grid h-full w-full place-content-center bg-panel p-6 text-center text-[13px] text-fg-muted"
				data-testid="repository-settings-view"
			>
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
		<div
			className="h-full w-full overflow-auto bg-panel"
			data-testid="repository-settings-view"
		>
			<div className="mx-auto w-[min(640px,calc(100%-48px))] pt-10 pb-16">
				<h2 className="m-0 text-[16px] leading-tight font-bold tracking-[-0.01em]">
					Settings
				</h2>
				<p className="m-0 mt-1 mb-5 text-[12.5px] text-fg-subtle">
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
		if (!info.isAdmin || busy || !name.trim() || name.trim() === savedName)
			return;
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
		<section className="mb-3.5 rounded-[12px] border border-border px-[18px] py-4">
			<h3 className="m-0 text-[13.5px] font-bold">
				<label htmlFor="repository-name">Name</label>
			</h3>
			<p className="m-0 mt-0.5 mb-3 text-[12px] text-fg-subtle">
				Renaming keeps the URL — the address stays{" "}
				<code className="text-[11.5px]">
					@{info.namespaceHandle}/{info.repositorySlug}
				</code>
				.
			</p>
			<form className="flex gap-2" onSubmit={(event) => void submit(event)}>
				<input
					id="repository-name"
					className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-panel px-[11px] text-[13px] text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-60"
					maxLength={80}
					value={name}
					disabled={!info.isAdmin}
					onChange={(event) => setName(event.target.value)}
				/>
				{info.isAdmin && (name.trim() !== savedName || busy) ? (
					<Button
						type="submit"
						size="sm"
						className="h-9"
						disabled={busy || !name.trim()}
					>
						{busy ? "Saving…" : "Save"}
					</Button>
				) : null}
			</form>
			{!info.isAdmin ? (
				<p className="m-0 mt-2 text-[12px] text-fg-faint">
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
	const [visibilityBusy, setVisibilityBusy] = useState(false);
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

	const changeVisibility = async (next: "private" | "public") => {
		if (!info.isAdmin || visibilityBusy || next === visibility) return;
		setVisibilityBusy(true);
		try {
			await settingsApi.setVisibility(next);
			setVisibility(next);
			toast.success(`Repository is now ${next}`);
		} catch (caught) {
			toast.error(formatCaughtError(caught));
		} finally {
			setVisibilityBusy(false);
		}
	};

	return (
		<>
			<section className="mb-3.5 rounded-[12px] border border-border px-[18px] py-4">
				<div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2">
					<div className="min-w-0 flex-1 basis-[180px]">
						<h3 className="m-0 text-[13.5px] font-bold">
							Repository visibility
						</h3>
					</div>
					<div
						role="group"
						aria-label="Repository visibility"
						aria-busy={visibilityBusy}
						className="grid w-[184px] shrink-0 grid-cols-2 gap-0.5 rounded-lg bg-bg-hover p-0.5"
					>
						{(["private", "public"] as const).map((value) => {
							const selected = visibility === value;
							const Icon = value === "private" ? LockKeyhole : Globe2;
							return (
								<button
									key={value}
									type="button"
									aria-pressed={selected}
									disabled={!info.isAdmin || visibilityBusy}
									onClick={() => void changeVisibility(value)}
									className={`inline-flex h-7 min-w-0 items-center justify-center gap-1 rounded-md px-1.5 text-[11.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default ${selected ? "bg-panel text-fg shadow-sm" : "text-fg-subtle hover:text-fg"}`}
								>
									<Icon className="size-3.5" aria-hidden="true" />
									{value === "private" ? "Private" : "Public"}
									<Check
										className={`size-3 shrink-0 ${selected ? "" : "invisible"}`}
										aria-hidden="true"
									/>
								</button>
							);
						})}
					</div>
				</div>
				<p className="m-0 mt-2 text-[12px] leading-relaxed text-fg-subtle">
					{visibility === "public"
						? "Anyone can read. Only members can edit."
						: "Only repository members can open this repository. Published files remain public."}
				</p>
			</section>
			<section className="mb-3.5 rounded-[12px] border border-border px-[18px] py-4">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<h3 className="m-0 text-[13.5px] font-bold">Members</h3>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="-mr-2 h-7 gap-1.5 px-2 text-xs text-fg-muted"
						title="Anyone with the invite link can join this repository as a member."
						onClick={() => void copyInviteLink()}
					>
						<Copy className="size-3" aria-hidden="true" />
						Copy invite link
					</Button>
				</div>
				<p className="m-0 mt-1 mb-2 text-[12px] text-fg-subtle">
					Admins can promote members and remove member access.
				</p>
				{directMembers?.map((member) => {
					const isSelf = member.accountId === info.currentAccountId;
					return (
						<div
							key={member.accountId}
							className="flex items-center gap-3 border-t border-border-subtle pt-3 pb-1"
						>
							<MemberAvatar
								member={{
									name: member.name || member.email || "Account",
									avatarUrl: member.avatarUrl,
								}}
								className="size-8 shrink-0 text-xs"
							/>
							<span className="flex min-w-0 flex-1 flex-col gap-0.5">
								<span className="truncate text-[13px] leading-tight font-semibold">
									{member.name || member.email || "Account"}
									{isSelf ? (
										<span className="ml-1.5 font-normal text-fg-faint">
											you
										</span>
									) : null}
								</span>
								{member.email ? (
									<span className="truncate text-[11.5px] leading-tight text-fg-subtle">
										{member.email}
									</span>
								) : null}
							</span>
							<span className="ml-auto shrink-0 text-[12px] text-fg-subtle">
								{member.role === "admin" ? "Admin" : "Member"}
							</span>
							{info.isAdmin && member.role === "member" ? (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="h-7 text-fg-subtle"
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
										className="h-7 text-fg-subtle"
										onClick={() => setConfirmingRemoval(member.accountId)}
									>
										{isSelf ? "Leave" : "Remove"}
									</Button>
								)
							) : null}
						</div>
					);
				})}
			</section>
		</>
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
		<section className="rounded-[12px] border border-danger-subtle px-[18px] py-4">
			<h3 className="m-0 text-[13.5px] font-bold text-fg">Danger zone</h3>
			<p className="m-0 mt-0.5 mb-3 text-[12px] text-fg-subtle">
				Deleting removes the repository from every member’s directory and keeps
				its name reserved.
			</p>
			{open ? (
				<div className="flex flex-wrap items-center gap-2">
					<input
						className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-panel px-[11px] text-[13px] text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
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
						className="h-9 text-fg-subtle"
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
					variant="ghost"
					size="sm"
					className="-ml-3 h-9 text-xs text-danger-border hover:bg-danger-subtle hover:text-diff-removed"
					onClick={() => setOpen(true)}
				>
					Delete repository…
				</Button>
			)}
		</section>
	);
}
