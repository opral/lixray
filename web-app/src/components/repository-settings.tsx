import { Link, useNavigate } from "@tanstack/react-router";
import { Copy } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "~/components/auth-provider";
import { DirectoryHeader } from "~/components/repository-directory";
import {
	repositoryInitials,
	repositoryPalette,
} from "~/components/repository-identity";
import { MemberAvatar } from "~/components/repository-home/people-view";
import {
	type ActiveRepository,
	useRepository,
} from "~/components/repository-provider";
import { Button } from "~/components/ui/button";
import { formatCaughtError } from "~/lib/format";
import { findRepositoryByRoute } from "~/lib/repository-url";
import { appendRepositoryShareToken } from "~/lib/repository-share-url";
import { isRepositoryShareToken } from "~/lib/repository-share-capability";

interface DirectMember {
	userId: string;
	name: string;
	email: string;
	avatarUrl: string | null;
}

/**
 * Repository settings (2a): rename, a unified "Who has access" list covering
 * both membership mechanisms (namespace membership and direct share-link
 * members), and deletion. Lives at /@{handle}/{slug}/settings — the reserved
 * repo-level settings verb.
 */
export function RepositorySettings({
	namespace,
	repositorySlug,
}: {
	namespace: string;
	repositorySlug: string;
}) {
	const { isLoaded: authLoaded, user } = useAuth();
	const repositoryState = useRepository();
	const match = findRepositoryByRoute(
		repositoryState.organizations,
		namespace,
		repositorySlug,
	);

	if (!authLoaded || !repositoryState.isLoaded) {
		return (
			<SettingsShell>
				<p className="text-text-tertiary">Loading settings…</p>
			</SettingsShell>
		);
	}
	if (!user || !match) {
		return (
			<SettingsShell>
				<div className="grid justify-items-start gap-3">
					<p className="m-0 text-[15px] font-bold">
						These settings aren’t available.
					</p>
					<p className="m-0 text-[13px] text-text-tertiary">
						You need access to @{namespace}/{repositorySlug} to see its
						settings.
					</p>
					<Button asChild variant="secondary">
						<Link to="/home">Back to repositories</Link>
					</Button>
				</div>
			</SettingsShell>
		);
	}

	const { organization, repository } = match;
	const paletteIndex = repositoryState.organizations
		.flatMap((candidate) => candidate.repositories)
		.findIndex((candidate) => candidate.id === repository.id);
	const palette = repositoryPalette(Math.max(paletteIndex, 0));

	return (
		<SettingsShell>
			<nav
				className="mb-4 text-[12.5px] text-text-tertiary"
				aria-label="Breadcrumb"
			>
				<Link to="/home" className="text-inherit no-underline hover:underline">
					Repositories
				</Link>{" "}
				/ @{organization.handle} /{" "}
				<span className="text-text-secondary">{repository.slug}</span> /
				Settings
			</nav>
			<div className="mb-5 flex items-center gap-3">
				<span
					className="inline-flex size-10 shrink-0 items-center justify-center rounded-[11px] text-[15px] font-bold tracking-[-0.01em]"
					style={{
						background: palette.background,
						boxShadow: `inset 0 0 0 1px ${palette.border}`,
						color: palette.color,
					}}
					aria-hidden="true"
				>
					{repositoryInitials(repository.name)}
				</span>
				<div className="min-w-0">
					<h1 className="m-0 truncate text-[17px] leading-tight font-bold tracking-[-0.01em]">
						{repository.name}
					</h1>
					<p className="m-0 text-[12.5px] text-text-tertiary">
						lixray.com/@{organization.handle}/{repository.slug}
					</p>
				</div>
			</div>

			<NamePanel match={match} />
			<AccessPanel match={match} />
			<DangerPanel match={match} />
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

function NamePanel({ match }: { match: ActiveRepository }) {
	const { renameRepository } = useRepository();
	const { organization, repository } = match;
	const isOwner = organization.role === "owner";
	const [name, setName] = useState(repository.name);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		setName(repository.name);
	}, [repository.id, repository.name]);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		try {
			await renameRepository(repository.id, name);
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
				Renaming keeps the URL — the address stays{" "}
				<code className="rounded bg-bg-hover px-1.5 py-0.5 text-[11.5px]">
					@{organization.handle}/{repository.slug}
				</code>
				.
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
						!isOwner || busy || !name.trim() || name.trim() === repository.name
					}
				>
					{busy ? "Saving…" : "Save"}
				</Button>
			</form>
			{!isOwner ? (
				<p className="m-0 mt-2 text-[12px] text-text-quaternary">
					Only owners of @{organization.handle} can rename this repository.
				</p>
			) : null}
		</section>
	);
}

function AccessPanel({ match }: { match: ActiveRepository }) {
	const { client, user } = useAuth();
	const { organization, repository } = match;
	const isOwner = organization.role === "owner";
	const [directMembers, setDirectMembers] =
		useState<Array<DirectMember> | null>(null);
	const [namespaceMemberCount, setNamespaceMemberCount] = useState<
		number | null
	>(null);
	const [confirmingRemoval, setConfirmingRemoval] = useState<string | null>(
		null,
	);

	useEffect(() => {
		if (!client) return;
		let cancelled = false;
		client
			.rpc("list_lix_members", { p_lix_id: repository.id })
			.then(({ data, error }) => {
				if (cancelled || error) return;
				setDirectMembers(
					(data ?? []).map((row) => ({
						userId: row.user_id,
						name: row.name,
						email: row.email,
						avatarUrl: row.avatar_url,
					})),
				);
			});
		if (organization.role !== null) {
			client
				.rpc("list_namespace_members", { p_namespace_id: organization.id })
				.then(({ data, error }) => {
					if (cancelled || error) return;
					setNamespaceMemberCount((data ?? []).length);
				});
		}
		return () => {
			cancelled = true;
		};
	}, [client, organization.id, organization.role, repository.id]);

	const copyEditLink = async () => {
		if (!client) return;
		try {
			const { data, error } = await client.rpc("create_lix_share_token", {
				p_lix_id: repository.id,
			});
			if (error) throw new Error(error.message);
			const token = data?.[0]?.token;
			if (!isRepositoryShareToken(token)) {
				throw new Error("The share service returned an invalid link.");
			}
			await navigator.clipboard.writeText(
				appendRepositoryShareToken(
					`${window.location.origin}/@${organization.handle}/${repository.slug}`,
					token,
				),
			);
			toast.success("Edit link copied");
		} catch (caught) {
			toast.error(formatCaughtError(caught));
		}
	};

	const removeMember = async (member: DirectMember) => {
		if (!client) return;
		try {
			const { error } = await client.rpc("remove_lix_member", {
				p_lix_id: repository.id,
				p_user_id: member.userId,
			});
			if (error) throw new Error(error.message);
			setDirectMembers(
				(current) =>
					current?.filter((entry) => entry.userId !== member.userId) ?? null,
			);
			toast.success(`Removed ${member.name || member.email}`);
		} catch (caught) {
			toast.error(formatCaughtError(caught));
		} finally {
			setConfirmingRemoval(null);
		}
	};

	return (
		<section className="mb-3.5 rounded-xl border border-border-panel bg-bg-panel px-[18px] py-4">
			<div className="flex items-center gap-2">
				<h3 className="m-0 text-[13.5px] font-bold">Who has access</h3>
				<span className="flex-1" />
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="h-8 gap-1.5"
					onClick={() => void copyEditLink()}
				>
					<Copy className="size-3" aria-hidden="true" />
					Copy edit link
				</Button>
			</div>
			<p className="m-0 mt-1 mb-2 text-[12px] text-text-tertiary">
				Anyone with the plain URL can read. The edit link lets people join as
				editors of this repository.
			</p>
			<div className="flex items-center gap-2.5 py-2">
				<span
					className="inline-flex size-6 shrink-0 items-center justify-center rounded-[7px] bg-bg-hover-canvas text-[10.5px] font-semibold text-text-secondary"
					aria-hidden="true"
				>
					{organization.handle.charAt(0).toUpperCase()}
				</span>
				<span className="flex min-w-0 flex-col">
					<Link
						to="/settings/@{$namespace}"
						params={{ namespace: organization.handle }}
						className="truncate text-[13px] leading-tight font-semibold text-text-primary no-underline hover:underline"
					>
						Everyone in @{organization.handle}
					</Link>
					<span className="truncate text-[11.5px] leading-tight text-text-tertiary">
						{namespaceMemberCount === null
							? "via account membership"
							: `${namespaceMemberCount} ${
									namespaceMemberCount === 1 ? "member" : "members"
								} · via account membership`}
					</span>
				</span>
				<span className="ml-auto rounded-[7px] border border-border-panel px-2 py-1 text-[12px] text-text-secondary">
					Full access
				</span>
			</div>
			{directMembers?.map((member) => {
				const isSelf = member.userId === user?.id;
				return (
					<div
						key={member.userId}
						className="flex items-center gap-2.5 border-t border-border-subtle py-2"
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
								{member.email} · joined via edit link
							</span>
						</span>
						<span className="ml-auto rounded-[7px] border border-border-panel px-2 py-1 text-[12px] text-text-secondary">
							Editor
						</span>
						{isOwner || isSelf ? (
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

function DangerPanel({ match }: { match: ActiveRepository }) {
	const { deleteRepository } = useRepository();
	const navigate = useNavigate();
	const { organization, repository } = match;
	const isOwner = organization.role === "owner";
	const [confirmation, setConfirmation] = useState("");
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);

	if (!isOwner) return null;

	const remove = async () => {
		setBusy(true);
		try {
			await deleteRepository(repository.id);
			toast.success(`Deleted “${repository.name}”`);
			void navigate({ to: "/home" });
		} catch (caught) {
			toast.error(formatCaughtError(caught));
			setBusy(false);
		}
	};

	return (
		<section className="rounded-xl border border-error-200 bg-bg-panel px-[18px] py-4">
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
						placeholder={`Type “${repository.name}” to confirm`}
						value={confirmation}
						onChange={(event) => setConfirmation(event.target.value)}
					/>
					<Button
						type="button"
						variant="destructive"
						size="sm"
						className="h-9"
						disabled={busy || confirmation !== repository.name}
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
