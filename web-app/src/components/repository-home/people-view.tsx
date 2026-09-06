import { Check, Copy, MoreHorizontal, UserRoundMinus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { cn } from "~/lib/utils";

export type TeamMember = {
	readonly accountId: string;
	readonly name: string;
	readonly email: string | null;
	readonly avatarUrl: string | null;
	readonly role: "admin" | "member";
	readonly isSelf: boolean;
};

/**
 * The host's bridge between the People surfaces (mounted in their own React
 * roots inside Atelier tabs) and the Supabase-backed team model. Methods so a
 * stable facade can delegate to the latest client without remounting.
 */
export type RepositoryTeamApi = {
	namespaceHandle(): string;
	canManageMembers(): boolean;
	listMembers(): Promise<readonly TeamMember[]>;
	/** The full invite URL, minted on first read. */
	inviteUrl(): Promise<string>;
	/** Rotates the token; the previous link stops working. */
	resetInviteUrl(): Promise<string>;
	removeMember(accountId: string): Promise<void>;
};

const AVATAR_TONES = [
	"bg-amber-200 text-amber-900",
	"bg-emerald-200 text-emerald-900",
	"bg-violet-200 text-violet-900",
	"bg-sky-200 text-sky-900",
	"bg-rose-200 text-rose-900",
] as const;

function avatarTone(seed: string): string {
	let hash = 0;
	for (const char of seed) hash = (hash * 31 + char.codePointAt(0)!) % 997;
	return AVATAR_TONES[hash % AVATAR_TONES.length];
}

export function MemberAvatar({
	member,
	className,
}: {
	member: Pick<TeamMember, "name" | "avatarUrl">;
	className?: string;
}) {
	const shared = cn(
		"flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full",
		className,
	);
	if (member.avatarUrl) {
		return (
			<span className={shared}>
				<img
					src={member.avatarUrl}
					alt=""
					referrerPolicy="no-referrer"
					className="size-full object-cover"
				/>
			</span>
		);
	}
	return (
		<span
			className={cn(
				shared,
				"text-[13px] font-semibold uppercase",
				avatarTone(member.name),
			)}
		>
			{member.name.trim().charAt(0) || "?"}
		</span>
	);
}

/**
 * The People tab (3c): the repository roster. The invite
 * link reuses the dashed-container vocabulary from Home's agent-connect row;
 * the roster reuses the file-list row. Copy invite link is the page's only
 * primary action.
 */
export function PeopleView({ teamApi }: { teamApi: RepositoryTeamApi | null }) {
	const [members, setMembers] = useState<readonly TeamMember[] | null>(null);
	const [inviteUrl, setInviteUrl] = useState<string | null>(null);
	const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
		"idle",
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const namespaceHandle = teamApi?.namespaceHandle() ?? "";

	const refreshMembers = useCallback(() => {
		if (!teamApi) return;
		teamApi
			.listMembers()
			.then(setMembers)
			.catch((caught: unknown) => {
				console.error("repository-people: unable to list members", caught);
				setError("Unable to load the team. Try again.");
			});
	}, [teamApi]);

	useEffect(() => {
		if (!teamApi) return;
		refreshMembers();
		teamApi
			.inviteUrl()
			.then(setInviteUrl)
			.catch((caught: unknown) => {
				console.error("repository-people: unable to load invite link", caught);
				setError("Unable to load the invite link. Try again.");
			});
	}, [refreshMembers, teamApi]);

	useEffect(() => {
		setCopyState("idle");
	}, [inviteUrl]);

	if (!teamApi) {
		return (
			<div
				className="grid h-full w-full place-content-center bg-bg-panel p-6 text-center text-[13px] text-text-secondary"
				data-testid="repository-people-view"
			>
				Sign in with edit access to see who's here.
			</div>
		);
	}

	const selectLinkText = (element: HTMLElement) => {
		const selection = window.getSelection();
		if (!selection) return;
		const range = document.createRange();
		range.selectNodeContents(element);
		selection.removeAllRanges();
		selection.addRange(range);
	};

	const copyInviteLink = async () => {
		if (!inviteUrl) return;
		try {
			if (!navigator.clipboard?.writeText) {
				throw new Error("Clipboard access is unavailable.");
			}
			await navigator.clipboard.writeText(inviteUrl);
			setCopyState("copied");
		} catch {
			setCopyState("error");
		}
	};

	const resetInviteLink = async () => {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			setInviteUrl(await teamApi.resetInviteUrl());
		} catch (caught) {
			console.error("repository-people: unable to reset invite link", caught);
			setError("Unable to reset the invite link. Try again.");
		} finally {
			setBusy(false);
		}
	};

	const removeMember = async (member: TeamMember) => {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			await teamApi.removeMember(member.accountId);
			refreshMembers();
		} catch (caught) {
			console.error("repository-people: unable to remove member", caught);
			setError("Unable to remove this member. Try again.");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div
			className="relative flex h-full min-h-0 flex-col overflow-y-auto bg-bg-panel font-sans text-text-primary"
			data-testid="repository-people-view"
		>
			<div className="mx-auto flex w-[min(760px,calc(100%-48px))] flex-col pt-10 pb-10">
				<div className="flex items-baseline gap-3 pb-5">
					<h1 className="text-[22px] font-bold">People</h1>
					{members ? (
						<span className="text-[13px] text-text-tertiary">
							{members.length} {members.length === 1 ? "member" : "members"} of{" "}
							{namespaceHandle}
						</span>
					) : null}
				</div>
				{error ? (
					<p
						role="alert"
						className="mb-3 rounded-lg bg-error-700/10 px-3 py-2 text-[13px] text-error-700"
					>
						{error}
					</p>
				) : null}
				<div className="flex min-w-0 items-stretch gap-2">
					<div
						className="flex h-9 min-w-0 grow cursor-text select-all items-center overflow-hidden rounded-lg border border-border-panel bg-bg-panel px-3 font-mono text-[11px] text-text-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring-focus-visible"
						tabIndex={0}
						role="textbox"
						aria-readonly="true"
						aria-label={
							inviteUrl ? `Invite link: ${inviteUrl}` : "Creating invite link"
						}
						title={inviteUrl ?? undefined}
						onClick={(event) => selectLinkText(event.currentTarget)}
						onKeyDown={(event) => {
							if (event.key === "Enter" || event.key === " ") {
								event.preventDefault();
								selectLinkText(event.currentTarget);
							}
						}}
					>
						{inviteUrl ? (
							<InviteLinkText url={inviteUrl} />
						) : (
							<span className="truncate">Creating invite link…</span>
						)}
					</div>
					<Button
						type="button"
						variant="featured"
						className="shrink-0 font-semibold"
						disabled={!inviteUrl}
						onClick={() => void copyInviteLink()}
					>
						{copyState === "copied" ? (
							<Check aria-hidden="true" />
						) : (
							<Copy aria-hidden="true" />
						)}
						{copyState === "copied" ? "Copied" : "Copy invite link"}
					</Button>
					<Button
						type="button"
						variant="outline"
						className="shrink-0"
						disabled={!inviteUrl || busy}
						onClick={() => void resetInviteLink()}
					>
						Reset
					</Button>
				</div>
				<p className="mt-2 text-xs leading-5 text-text-tertiary">
					{copyState === "error" ? (
						<span className="text-error-700" role="alert">
							Couldn’t copy the link. Select it above and copy it manually.
						</span>
					) : (
						<>
							Anyone who opens the link joins this repository as a member with
							edit access. Repository:{" "}
							<b className="font-semibold text-text-secondary">
								{namespaceHandle}
							</b>
						</>
					)}
				</p>
				<div className="mt-6 flex flex-col gap-px" data-testid="people-roster">
					{(members ?? []).map((member) => (
						<div
							key={member.accountId}
							className="group flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-bg-hover"
						>
							<MemberAvatar member={member} />
							<div className="min-w-0 flex-1">
								<p className="truncate text-[13px] font-semibold">
									{member.name}
									{member.isSelf ? (
										<span className="font-normal text-text-tertiary">
											{" "}
											· you
										</span>
									) : null}
								</p>
								<p className="truncate text-xs text-text-tertiary">
									{member.email ? <>{member.email} · </> : null}
									{member.role === "admin" ? "Admin" : "Member"}
								</p>
							</div>
							{/* Self-service leaving lives in Settings; this menu is for
							    repository admins managing other members. */}
							{member.isSelf ||
							member.role === "admin" ||
							!teamApi.canManageMembers() ? null : (
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<Button
											type="button"
											variant="ghost"
											size="icon-sm"
											aria-label={`Actions for ${member.name}`}
											className="text-text-tertiary opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
										>
											<MoreHorizontal aria-hidden="true" />
										</Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent
										align="end"
										className="min-w-[190px] rounded-xl border-border-panel bg-bg-panel p-1.5 shadow-[0_18px_44px_rgba(28,25,23,0.16)]"
									>
										<DropdownMenuItem
											variant="destructive"
											disabled={busy}
											onSelect={() => void removeMember(member)}
										>
											<UserRoundMinus aria-hidden="true" />
											Remove from repository
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							)}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}

/** The `?invite=` capability is the part that makes the link special. */
function InviteLinkText({ url }: { url: string }) {
	const displayUrl = url.replace(/^https?:\/\//, "");
	const tokenStart = displayUrl.indexOf("?invite=");
	if (tokenStart === -1) {
		return <span className="block truncate">{displayUrl}</span>;
	}
	return (
		<span className="block truncate">
			{displayUrl.slice(0, tokenStart)}
			<span className="font-medium text-text-primary">
				{displayUrl.slice(tokenStart)}
			</span>
		</span>
	);
}
