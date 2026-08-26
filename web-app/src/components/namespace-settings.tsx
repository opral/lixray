import { Link } from "@tanstack/react-router";
import { Copy, Plus } from "lucide-react";
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
import type { Json } from "~/lib/database.types";
import { isDemoModeEnabled } from "~/lib/demo-client";
import {
	DEMO_PROFILE_HANDLE,
	DEMO_PROFILE_NAME,
	DEMO_PROFILE_NAMESPACE_ID,
} from "~/lib/demo-identity";
import { formatCaughtError } from "~/lib/format";
import {
	demoProfileDocumentWithOverride,
	editableProfileFromDocument,
	type EditableProfile,
	PROFILE_UPDATED_EVENT,
	profileDocumentWithEdits,
	saveDemoProfileDocument,
} from "~/lib/profile-editor";
import { isTeamInviteToken } from "~/lib/team-invite";
import { appendRepositoryShareToken } from "~/lib/repository-share-url";

interface NamespaceMember {
	accountId: string;
	name: string;
	email: string | null;
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
	const organization =
		repositoryState.organizations.find(
			(candidate) => candidate.handle.toLowerCase() === handle.toLowerCase(),
		) ?? demoProfileOrganization(handle);

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
						!organization.isPersonal ? "rounded-[11px]" : "rounded-full"
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

			<ProfilePanel organization={organization} />
			{organization.id !== DEMO_PROFILE_NAMESPACE_ID ? (
				<GeneralPanel organization={organization} />
			) : null}
			{!organization.isPersonal && client ? (
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

function ProfilePanel({ organization }: { organization: Organization }) {
	const { client } = useAuth();
	const isOwner = organization.role === "owner";
	const [document, setDocument] = useState<Record<string, unknown> | null>(
		null,
	);
	const [version, setVersion] = useState<string | null>(null);
	const [values, setValues] = useState<EditableProfile | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		let cancelled = false;
		setDocument(null);
		setVersion(null);
		setValues(null);
		setError(null);
		void (async () => {
			try {
				let nextDocument: unknown;
				if (isDemoModeEnabled) {
					nextDocument = demoProfileDocumentWithOverride(
						window.location.origin,
					);
				} else {
					if (!client) throw new Error("Profile settings are still loading.");
					const { data, error: loadError } = await client
						.from("namespace_profiles")
						.select("document, updated_at")
						.eq("namespace_id", organization.id)
						.single();
					if (loadError) throw loadError;
					nextDocument = data.document;
					if (!cancelled) setVersion(data.updated_at);
				}
				const nextValues = editableProfileFromDocument(nextDocument);
				if (!cancelled) {
					setDocument(nextDocument as Record<string, unknown>);
					setValues(nextValues);
				}
			} catch (caught) {
				if (!cancelled) setError(formatCaughtError(caught));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [client, organization.id]);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!document || !values || !isOwner) return;
		setBusy(true);
		setError(null);
		try {
			const nextDocument = profileDocumentWithEdits(document, values, {
				allowLocalHttp: isDemoModeEnabled,
			});
			if (isDemoModeEnabled) {
				saveDemoProfileDocument(nextDocument);
			} else {
				if (!client) throw new Error("Profile settings are still loading.");
				if (!version) throw new Error("Reload the profile before saving.");
				const { data: saved, error: saveError } = await client
					.from("namespace_profiles")
					.update({ document: nextDocument as Json })
					.eq("namespace_id", organization.id)
					.eq("updated_at", version)
					.select("updated_at")
					.maybeSingle();
				if (saveError) throw saveError;
				if (!saved) {
					throw new Error(
						"This profile changed elsewhere. Reload the page and try again.",
					);
				}
				setVersion(saved.updated_at);
			}
			setDocument(nextDocument);
			setValues(editableProfileFromDocument(nextDocument));
			window.dispatchEvent(
				new CustomEvent(PROFILE_UPDATED_EVENT, {
					detail: { namespaceId: organization.id },
				}),
			);
			toast.success("Profile saved");
		} catch (caught) {
			const message = formatCaughtError(caught);
			setError(message);
			toast.error(message);
		} finally {
			setBusy(false);
		}
	};

	const update = <Key extends keyof EditableProfile>(
		key: Key,
		value: EditableProfile[Key],
	) => {
		setValues((current) => (current ? { ...current, [key]: value } : current));
	};

	return (
		<section className="mb-3.5 rounded-xl border border-border-panel bg-bg-panel px-[18px] py-4">
			<div className="flex items-start gap-3">
				<div className="min-w-0 flex-1">
					<h3 className="m-0 text-[13.5px] font-bold">Public profile</h3>
					<p className="m-0 mt-0.5 text-[12px] text-text-tertiary">
						The information shown at lixray.com/@{organization.handle}.
					</p>
				</div>
				<Button asChild variant="ghost" size="sm" className="h-8">
					<Link to="/@{$namespace}" params={{ namespace: organization.handle }}>
						View profile
					</Link>
				</Button>
			</div>

			{error && !values ? (
				<p className="m-0 mt-3 text-[12.5px] text-error-700">{error}</p>
			) : null}
			{!values && !error ? (
				<p className="m-0 mt-3 text-[12.5px] text-text-tertiary">
					Loading profile…
				</p>
			) : null}
			{values ? (
				<form
					className="mt-4 grid gap-3.5"
					onSubmit={(event) => void submit(event)}
				>
					<ProfileField label="Display name">
						<input
							className={profileInputClass}
							maxLength={80}
							value={values.name}
							disabled={!isOwner || busy}
							onChange={(event) => update("name", event.target.value)}
						/>
					</ProfileField>

					<ProfileField label="Bio">
						<textarea
							className={`${profileInputClass} min-h-20 resize-y py-2`}
							maxLength={280}
							value={values.bio}
							disabled={!isOwner || busy}
							onChange={(event) => update("bio", event.target.value)}
						/>
					</ProfileField>

					<div className="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1">
						<ProfileField label="Title">
							<input
								className={profileInputClass}
								maxLength={80}
								value={values.title}
								disabled={!isOwner || busy}
								onChange={(event) => update("title", event.target.value)}
							/>
						</ProfileField>
						<ProfileField label="Organization">
							<input
								className={profileInputClass}
								maxLength={80}
								value={values.organization}
								disabled={!isOwner || busy}
								onChange={(event) => update("organization", event.target.value)}
							/>
						</ProfileField>
					</div>

					<ProfileField label="Location">
						<input
							className={profileInputClass}
							maxLength={120}
							value={values.location}
							disabled={!isOwner || busy}
							onChange={(event) => update("location", event.target.value)}
						/>
					</ProfileField>

					<ProfileField label="Avatar URL" hint="HTTPS image URL">
						<input
							className={profileInputClass}
							type="url"
							value={values.avatarUri}
							disabled={!isOwner || busy}
							onChange={(event) => update("avatarUri", event.target.value)}
						/>
					</ProfileField>

					<div
						className="grid gap-2.5"
						role="group"
						aria-labelledby="profile-links-label"
					>
						<div className="flex items-center">
							<span
								id="profile-links-label"
								className="text-[12px] font-semibold text-text-secondary"
							>
								Links
							</span>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="ml-auto h-7 gap-1 px-2 text-[12px]"
								disabled={!isOwner || busy || values.links.length >= 6}
								onClick={() =>
									update("links", [
										...values.links,
										{
											key: `new-${crypto.randomUUID()}`,
											label: "",
											uri: "",
										},
									])
								}
							>
								<Plus className="size-3" aria-hidden="true" />
								Add link
							</Button>
						</div>
						{values.links.length === 0 ? (
							<p className="m-0 text-[12px] text-text-tertiary">
								No links yet.
							</p>
						) : null}
						{values.links.map((link, index) => (
							<div
								className="grid grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)_auto] gap-2 max-[560px]:grid-cols-1"
								key={link.key}
							>
								<input
									aria-label={`Link ${index + 1} label`}
									className={profileInputClass}
									maxLength={80}
									placeholder="Label"
									value={link.label}
									disabled={!isOwner || busy}
									onChange={(event) =>
										update(
											"links",
											values.links.map((candidate) =>
												candidate.key === link.key
													? { ...candidate, label: event.target.value }
													: candidate,
											),
										)
									}
								/>
								<input
									aria-label={`Link ${index + 1} URL`}
									className={profileInputClass}
									type="url"
									placeholder="https://example.com"
									value={link.uri}
									disabled={!isOwner || busy}
									onChange={(event) =>
										update(
											"links",
											values.links.map((candidate) =>
												candidate.key === link.key
													? { ...candidate, uri: event.target.value }
													: candidate,
											),
										)
									}
								/>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="h-9 px-2 text-[12px] text-text-tertiary"
									disabled={!isOwner || busy}
									onClick={() =>
										update(
											"links",
											values.links.filter(
												(candidate) => candidate.key !== link.key,
											),
										)
									}
								>
									Remove
								</Button>
							</div>
						))}
					</div>

					{error ? (
						<p className="m-0 text-[12.5px] text-error-700">{error}</p>
					) : null}
					<div className="flex items-center gap-2 border-t border-border-subtle pt-3.5">
						<Button
							type="submit"
							variant="featured"
							size="sm"
							disabled={!isOwner || busy || !values.name.trim()}
						>
							{busy ? "Saving…" : "Save profile"}
						</Button>
						{!isOwner ? (
							<span className="text-[12px] text-text-quaternary">
								Only namespace owners can edit this profile.
							</span>
						) : null}
					</div>
				</form>
			) : null}
		</section>
	);
}

function ProfileField({
	children,
	hint,
	label,
}: {
	children: React.ReactNode;
	hint?: string;
	label: string;
}) {
	return (
		<label className="grid gap-1.5 text-[12px] font-semibold text-text-secondary">
			<span>
				{label}
				{hint ? (
					<span className="ml-1.5 font-normal text-text-quaternary">
						{hint}
					</span>
				) : null}
			</span>
			{children}
		</label>
	);
}

const profileInputClass =
	"h-9 min-w-0 rounded-lg border border-border-panel bg-bg-panel px-[11px] text-[13px] font-normal text-text-primary outline-none placeholder:text-text-quaternary focus-visible:ring-2 focus-visible:ring-ring-focus-visible focus-visible:ring-offset-1 disabled:opacity-60";

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
	const { accountId, client } = useAuth();
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
						accountId: row.account_id,
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
				{ p_namespace_id: organization.id, p_account_id: member.accountId },
			);
			if (removeError) throw new Error(removeError.message);
			setMembers(
				(current) =>
					current?.filter((entry) => entry.accountId !== member.accountId) ??
					null,
			);
			toast.success(`Removed ${member.name || member.email || "account"}`);
			if (member.accountId === accountId) await refresh();
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
				const isSelf = member.accountId === accountId;
				const removable =
					(isOwner || isSelf) && !(member.role === "owner" && !isSelf);
				return (
					<div
						key={member.accountId}
						className="flex items-center gap-2.5 border-t border-border-subtle py-2 first-of-type:border-t-0"
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
						<span className="ml-auto rounded-[7px] border border-border-panel px-2 py-1 text-[12px] text-text-secondary capitalize">
							{member.role}
						</span>
						{removable ? (
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
		</section>
	);
}

function namespaceInitials(name: string): string {
	const parts = name.match(/[a-z0-9]+/gi) ?? [];
	if (parts.length === 0) return "N";
	if (parts.length === 1) return (parts[0] ?? "N").slice(0, 2).toUpperCase();
	return `${parts[0]?.charAt(0) ?? ""}${parts[1]?.charAt(0) ?? ""}`.toUpperCase();
}

function demoProfileOrganization(handle: string): Organization | undefined {
	if (
		!isDemoModeEnabled ||
		handle.trim().toLowerCase() !== DEMO_PROFILE_HANDLE
	) {
		return undefined;
	}
	return {
		id: DEMO_PROFILE_NAMESPACE_ID,
		name: DEMO_PROFILE_NAME,
		handle: DEMO_PROFILE_HANDLE,
		isPersonal: true,
		role: "owner",
		createdAt: "2026-03-01T00:00:00.000Z",
		updatedAt: "2026-08-21T00:00:00.000Z",
		repositories: [],
	};
}
