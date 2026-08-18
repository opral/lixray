import { Link } from "@tanstack/react-router";
import { Copy } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "~/components/auth-provider";
import { DirectoryHeader } from "~/components/repository-directory";
import { MemberAvatar } from "~/components/repository-home/people-view";
import {
	type Organization,
	useRepository,
} from "~/components/repository-provider";
import { Button } from "~/components/ui/button";
import { formatCaughtError } from "~/lib/format";
import { isTeamInviteToken } from "~/lib/team-invite";
import { appendRepositoryShareToken } from "~/lib/repository-share-url";

interface NamespaceMember {
	userId: string;
	name: string;
	email: string;
	avatarUrl: string | null;
	role: "owner" | "member";
}

/**
 * Namespace settings (2a): General for every namespace, Members for
 * organizations. Roles render read-only — role changes have no RPC yet;
 * removal and invite links do.
 */
export function NamespaceSettings({ handle }: { handle: string }) {
	const { client, isLoaded: authLoaded, user } = useAuth();
	const repositoryState = useRepository();
	const organization = repositoryState.organizations.find(
		(candidate) => candidate.handle.toLowerCase() === handle.toLowerCase(),
	);

	if (!authLoaded || !repositoryState.isLoaded) {
		return (
			<SettingsShell>
				<p className="text-text-tertiary">Loading settings…</p>
			</SettingsShell>
		);
	}
	if (!user || !organization || organization.role === null) {
		return (
			<SettingsShell>
				<div className="grid justify-items-start gap-3">
					<p className="m-0 text-[15px] font-bold">
						These settings aren’t available.
					</p>
					<p className="m-0 text-[13px] text-text-tertiary">
						You need to be a member of @{handle} to see its settings.
					</p>
					<Button asChild variant="secondary">
						<Link to="/home">Back to repositories</Link>
					</Button>
				</div>
			</SettingsShell>
		);
	}

	return (
		<SettingsShell>
			<nav
				className="mb-4 text-[12.5px] text-text-tertiary"
				aria-label="Breadcrumb"
			>
				<Link to="/home" className="text-inherit no-underline hover:underline">
					Repositories
				</Link>{" "}
				/ <span className="text-text-secondary">@{organization.handle}</span> /
				Settings
			</nav>
			<div className="mb-5 flex items-center gap-3">
				<span
					className={`inline-flex size-10 shrink-0 items-center justify-center bg-bg-hover-canvas text-[15px] font-bold text-text-secondary ${
						organization.kind === "organization"
							? "rounded-[11px]"
							: "rounded-full"
					}`}
					aria-hidden="true"
				>
					{namespaceInitials(organization.name)}
				</span>
				<div className="min-w-0">
					<h1 className="m-0 truncate text-[17px] leading-tight font-bold tracking-[-0.01em]">
						{organization.name}
					</h1>
					<p className="m-0 text-[12.5px] text-text-tertiary">
						lixray.com/@{organization.handle}
					</p>
				</div>
			</div>

			<GeneralPanel organization={organization} />
			{organization.kind === "organization" && client ? (
				<>
					<MembersPanel organization={organization} />
					<div className="rounded-xl border border-dashed border-border-panel px-[18px] py-4 opacity-70">
						<h3 className="m-0 text-[13.5px] font-bold text-error-700">
							Danger zone
						</h3>
						<p className="m-0 mt-0.5 text-[12px] text-text-tertiary">
							Deleting an organization arrives with the supporting RPCs — kept
							out of this version.
						</p>
					</div>
				</>
			) : null}
		</SettingsShell>
	);
}

function SettingsShell({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex min-h-dvh flex-col bg-bg-app font-sans text-text-primary">
			<DirectoryHeader />
			<main className="flex min-h-0 flex-1 justify-center overflow-auto">
				<section className="w-[min(640px,calc(100%-32px))] pt-12 pb-[60px]">
					{children}
				</section>
			</main>
		</div>
	);
}

function GeneralPanel({ organization }: { organization: Organization }) {
	const { renameOrganization } = useRepository();
	const isOwner = organization.role === "owner";
	const [name, setName] = useState(organization.name);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		setName(organization.name);
	}, [organization.id, organization.name]);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		try {
			await renameOrganization(organization.id, name);
			toast.success(`Renamed to “${name.trim()}”`);
		} catch (caught) {
			toast.error(formatCaughtError(caught));
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className="mb-3.5 rounded-xl border border-border-panel bg-bg-panel px-[18px] py-4">
			<h3 className="m-0 text-[13.5px] font-bold">Name</h3>
			<p className="m-0 mt-0.5 mb-3 text-[12px] text-text-tertiary">
				Shown across LixRay. Renaming keeps the handle and all URLs.
			</p>
			<form className="flex gap-2" onSubmit={(event) => void submit(event)}>
				<input
					className="h-9 min-w-0 flex-1 rounded-lg border border-border-panel bg-bg-panel px-[11px] text-[13px] text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring-focus-visible focus-visible:ring-offset-1 disabled:opacity-60"
					maxLength={80}
					value={name}
					disabled={!isOwner}
					onChange={(event) => setName(event.target.value)}
				/>
				<Button
					type="submit"
					variant="outline"
					size="sm"
					className="h-9"
					disabled={
						!isOwner ||
						busy ||
						!name.trim() ||
						name.trim() === organization.name
					}
				>
					{busy ? "Saving…" : "Save"}
				</Button>
			</form>
			<p className="m-0 mt-2.5 text-[12px] text-text-tertiary">
				URL{"  "}
				<code className="rounded bg-bg-hover px-1.5 py-0.5 text-[11.5px]">
					lixray.com/@{organization.handle}
				</code>{" "}
				<span className="text-text-quaternary">
					· handles can’t be changed yet
				</span>
			</p>
			{!isOwner ? (
				<p className="m-0 mt-2 text-[12px] text-text-quaternary">
					Only owners can rename this organization.
				</p>
			) : null}
		</section>
	);
}

function MembersPanel({ organization }: { organization: Organization }) {
	const { client, user } = useAuth();
	const { refresh } = useRepository();
	const isOwner = organization.role === "owner";
	const [members, setMembers] = useState<Array<NamespaceMember> | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [confirmingRemoval, setConfirmingRemoval] = useState<string | null>(
		null,
	);
	const inviteTargetRepository = organization.repositories[0];

	useEffect(() => {
		if (!client) return;
		let cancelled = false;
		client
			.rpc("list_namespace_members", { p_namespace_id: organization.id })
			.then(({ data, error: listError }) => {
				if (cancelled) return;
				if (listError) {
					setError(listError.message);
					return;
				}
				setMembers(
					(data ?? []).map((row) => ({
						userId: row.user_id,
						name: row.name,
						email: row.email,
						avatarUrl: row.avatar_url,
						role: row.role,
					})),
				);
			});
		return () => {
			cancelled = true;
		};
	}, [client, organization.id]);

	const copyInviteLink = async () => {
		if (!client || !inviteTargetRepository) return;
		try {
			const { data, error: linkError } = await client.rpc(
				"get_namespace_invite_link",
				{ p_namespace_id: organization.id },
			);
			if (linkError) throw new Error(linkError.message);
			if (!isTeamInviteToken(data)) {
				throw new Error("The invite service returned an invalid link.");
			}
			await navigator.clipboard.writeText(
				appendRepositoryShareToken(
					`${window.location.origin}/@${organization.handle}/${inviteTargetRepository.slug}`,
					data,
				),
			);
			toast.success("Invite link copied");
		} catch (caught) {
			toast.error(formatCaughtError(caught));
		}
	};

	const resetInviteLink = async () => {
		if (!client) return;
		try {
			const { error: resetError } = await client.rpc(
				"reset_namespace_invite_link",
				{ p_namespace_id: organization.id },
			);
			if (resetError) throw new Error(resetError.message);
			toast.success("Invite link reset — previous links no longer work");
		} catch (caught) {
			toast.error(formatCaughtError(caught));
		}
	};

	const removeMember = async (member: NamespaceMember) => {
		if (!client) return;
		try {
			const { error: removeError } = await client.rpc(
				"remove_namespace_member",
				{ p_namespace_id: organization.id, p_user_id: member.userId },
			);
			if (removeError) throw new Error(removeError.message);
			setMembers(
				(current) =>
					current?.filter((entry) => entry.userId !== member.userId) ?? null,
			);
			toast.success(`Removed ${member.name || member.email}`);
			if (member.userId === user?.id) await refresh();
		} catch (caught) {
			toast.error(formatCaughtError(caught));
		} finally {
			setConfirmingRemoval(null);
		}
	};

	return (
		<section className="mb-3.5 rounded-xl border border-border-panel bg-bg-panel px-[18px] py-4">
			<div className="flex items-center gap-2">
				<h3 className="m-0 text-[13.5px] font-bold">
					Members
					{members ? (
						<span className="ml-1.5 font-medium text-text-tertiary">
							· {members.length}
						</span>
					) : null}
				</h3>
				<span className="flex-1" />
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="h-8 gap-1.5"
					disabled={!inviteTargetRepository}
					title={
						inviteTargetRepository
							? undefined
							: "Create the first repository to invite your team"
					}
					onClick={() => void copyInviteLink()}
				>
					<Copy className="size-3" aria-hidden="true" />
					Copy invite link
				</Button>
				{isOwner ? (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-8 text-text-tertiary"
						onClick={() => void resetInviteLink()}
					>
						Reset link
					</Button>
				) : null}
			</div>
			<p className="m-0 mt-1 mb-2 text-[12px] text-text-tertiary">
				Everyone here sees every repository in @{organization.handle}.
			</p>
			{error ? (
				<p className="m-0 py-2 text-[12.5px] text-error-700">{error}</p>
			) : null}
			{members === null && !error ? (
				<p className="m-0 py-2 text-[12.5px] text-text-tertiary">
					Loading members…
				</p>
			) : null}
			{members?.map((member) => {
				const isSelf = member.userId === user?.id;
				const removable =
					(isOwner || isSelf) && !(member.role === "owner" && !isSelf);
				return (
					<div
						key={member.userId}
						className="flex items-center gap-2.5 border-t border-border-subtle py-2 first-of-type:border-t-0"
					>
						<MemberAvatar
							member={{
								name: member.name || member.email,
								avatarUrl: member.avatarUrl,
							}}
							className="size-6 text-[11px]"
						/>
						<span className="flex min-w-0 flex-col">
							<span className="truncate text-[13px] leading-tight font-semibold">
								{member.name || member.email}
								{isSelf ? (
									<span className="ml-1.5 font-normal text-text-quaternary">
										you
									</span>
								) : null}
							</span>
							<span className="truncate text-[11.5px] leading-tight text-text-tertiary">
								{member.email}
							</span>
						</span>
						<span className="ml-auto rounded-[7px] border border-border-panel px-2 py-1 text-[12px] text-text-secondary capitalize">
							{member.role}
						</span>
						{removable ? (
							confirmingRemoval === member.userId ? (
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
									onClick={() => setConfirmingRemoval(member.userId)}
								>
									{isSelf ? "Leave" : "Remove"}
								</Button>
							)
						) : null}
					</div>
				);
			})}
		</section>
	);
}

function namespaceInitials(name: string): string {
	const parts = name.match(/[a-z0-9]+/gi) ?? [];
	if (parts.length === 0) return "N";
	if (parts.length === 1) return (parts[0] ?? "N").slice(0, 2).toUpperCase();
	return `${parts[0]?.charAt(0) ?? ""}${parts[1]?.charAt(0) ?? ""}`.toUpperCase();
}
