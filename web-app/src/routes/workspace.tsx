import { createFileRoute, Link } from "@tanstack/react-router";
import { DatabaseZap } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useAuth } from "~/components/auth-provider";
import {
	type OrganizationRole,
	useWorkspace,
} from "~/components/workspace-provider";

const workspaceEmptyClass =
	"grid min-h-[calc(100vh_-_80px)] place-items-center px-5 py-10";
const brandClass =
	"inline-flex items-center gap-2.5 font-[750] tracking-normal no-underline";
const brandMarkClass =
	"grid size-7 place-items-center rounded-[7px] bg-bg-action-secondary text-text-on-action-secondary";
const buttonClass =
	"inline-flex min-h-[38px] cursor-pointer items-center justify-center gap-2 rounded-[7px] border border-border-panel bg-bg-panel px-3.5 font-[680] text-text-secondary no-underline disabled:cursor-not-allowed disabled:opacity-[0.55]";
const primaryButtonClass = `${buttonClass} border-bg-action-primary bg-bg-action-primary text-text-on-action-primary`;
const panelClass =
	"rounded-[8px] border border-border-panel bg-bg-panel shadow-md";
const panelHeaderClass =
	"flex items-center justify-between gap-3 border-b border-border-subtle px-[18px] py-4";
const panelTitleClass = "m-0 text-[15px] font-[720] tracking-normal";
const panelBodyStackClass = "grid gap-3.5 p-[18px]";
const fieldClass =
	"grid gap-2 [&_label]:text-[13px] [&_label]:font-[680] [&_label]:text-text-secondary";
const inputClass =
	"h-[42px] w-full rounded-[7px] border border-border-panel bg-bg-panel px-3 text-text-primary outline-none focus:border-border-panel focus:outline-2 focus:outline-offset-1 focus:outline-ring-focus-visible";
const compactSelectClass =
	"h-[38px] max-w-[210px] rounded-[7px] border border-border-panel bg-bg-panel py-0 pr-[30px] pl-2.5 text-text-primary max-[800px]:w-full max-[800px]:max-w-none";
const settingsRowClass =
	"flex items-center justify-between gap-4 border-b border-border-subtle py-3 last:border-b-0 max-[800px]:flex-col max-[800px]:items-stretch";
const inlineActionsClass = "flex items-center gap-2.5 max-[800px]:w-full";
const inlineFormClass =
	"flex items-end gap-2.5 max-[800px]:flex-col max-[800px]:items-stretch";
const errorClass =
	"mt-3.5 whitespace-pre-wrap rounded-[8px] border border-error-200 bg-error-50 px-3.5 py-3 text-error-800";

export const Route = createFileRoute("/workspace")({
	component: WorkspacePage,
});

interface Member {
	userId: string;
	role: OrganizationRole;
	name: string;
	email: string;
}

interface Invitation {
	id: string;
	email: string;
	expiresAt: string;
}

function WorkspacePage() {
	const { client, isLoaded: authLoaded, user } = useAuth();
	const workspaceState = useWorkspace();
	const { selectedOrganization } = workspaceState;
	const [members, setMembers] = useState<Array<Member>>([]);
	const [invitations, setInvitations] = useState<Array<Invitation>>([]);
	const [loadingSettings, setLoadingSettings] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [inviteLink, setInviteLink] = useState<string | null>(null);

	const loadSettings = useCallback(async () => {
		if (!client || !selectedOrganization) {
			setMembers([]);
			setInvitations([]);
			return;
		}
		setLoadingSettings(true);
		setError(null);
		try {
			const { data: memberRows, error: memberError } = await client
				.from("organization_members")
				.select("user_id, role")
				.eq("organization_id", selectedOrganization.id)
				.order("created_at");
			if (memberError) throw memberError;

			const userIds = (memberRows ?? []).map((row) => String(row.user_id));
			const profileById = new Map<string, { name: string; email: string }>();
			if (userIds.length > 0) {
				const { data: profileRows, error: profileError } = await client
					.from("profiles")
					.select("id, name, email")
					.in("id", userIds);
				if (profileError) throw profileError;
				for (const profile of profileRows ?? []) {
					profileById.set(String(profile.id), {
						name: String(profile.name),
						email: String(profile.email),
					});
				}
			}
			setMembers(
				(memberRows ?? []).map((row) => {
					const userId = String(row.user_id);
					const profile = profileById.get(userId);
					return {
						userId,
						role: row.role,
						name: profile?.name ?? "Unknown member",
						email: profile?.email ?? "",
					};
				}),
			);

			if (selectedOrganization.role === "owner") {
				const { data: invitationRows, error: invitationError } = await client
					.from("organization_invitations")
					.select("id, email, expires_at")
					.eq("organization_id", selectedOrganization.id)
					.is("accepted_at", null)
					.is("revoked_at", null)
					.order("created_at", { ascending: false });
				if (invitationError) throw invitationError;
				setInvitations(
					(invitationRows ?? []).map((row) => ({
						id: String(row.id),
						email: String(row.email),
						expiresAt: String(row.expires_at),
					})),
				);
			} else {
				setInvitations([]);
			}
		} catch (loadError) {
			setError(errorMessage(loadError));
		} finally {
			setLoadingSettings(false);
		}
	}, [client, selectedOrganization]);

	useEffect(() => {
		void loadSettings();
	}, [loadSettings]);

	const runAction = async (action: () => Promise<void>, success: string) => {
		setError(null);
		setNotice(null);
		try {
			await action();
			setNotice(success);
			await loadSettings();
		} catch (actionError) {
			setError(errorMessage(actionError));
		}
	};

	if (!authLoaded || !workspaceState.isLoaded) {
		return <div className={workspaceEmptyClass}>Loading...</div>;
	}
	if (!user) return <SignedOutSettings />;

	return (
		<div className="min-h-screen">
			<header
				data-app-titlebar
				className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-border-panel bg-bg-panel/86 px-7 py-5 backdrop-blur-[16px] max-[800px]:flex-col max-[800px]:items-start max-[800px]:px-[18px] max-[800px]:py-4"
			>
				<Link to="/" className={brandClass}>
					<span className={brandMarkClass}>
						<DatabaseZap size={17} aria-hidden="true" />
					</span>
					<span>LixRay</span>
				</Link>
				<Link to="/" className={`${buttonClass} max-[800px]:w-full`}>
					Back to workspace
				</Link>
			</header>
			<main className="mx-auto grid w-[min(1180px,calc(100%_-_40px))] gap-[18px] pt-6 pb-12 max-[800px]:w-[min(1180px,calc(100%_-_24px))] max-[800px]:pt-[22px]">
				<section className="mb-[18px] max-w-[760px]">
					<p className="mb-2 text-[13px] font-[760] tracking-[0.08em] text-text-link uppercase">
						Workspace settings
					</p>
					<h1 className="m-0 text-2xl leading-[1.2] tracking-normal">
						Organizations, workspaces, and members
					</h1>
				</section>

				{error ? <div className={errorClass}>{error}</div> : null}
				{notice ? (
					<div className="rounded-[8px] border border-success-200 bg-success-50 px-3.5 py-3 text-success-800">
						{notice}
					</div>
				) : null}

				<OrganizationPanel workspaceState={workspaceState} />

				{selectedOrganization ? (
					<>
						<WorkspacePanel workspaceState={workspaceState} />
						<MemberPanel
							members={members}
							currentUserId={user.id}
							isOwner={selectedOrganization.role === "owner"}
							loading={loadingSettings}
							onRoleChange={(member, role) =>
								void runAction(async () => {
									if (!client) return;
									const { error: roleError } = await client.rpc(
										"set_organization_member_role",
										{
											p_organization_id: selectedOrganization.id,
											p_user_id: member.userId,
											p_role: role,
										},
									);
									if (roleError) throw roleError;
									await workspaceState.refresh({
										organizationId: selectedOrganization.id,
									});
								}, "Member role updated")
							}
							onRemove={(member) =>
								void runAction(async () => {
									if (!client) return;
									const { error: removeError } = await client.rpc(
										"remove_organization_member",
										{
											p_organization_id: selectedOrganization.id,
											p_user_id: member.userId,
										},
									);
									if (removeError) throw removeError;
								}, "Member removed")
							}
							onLeave={() =>
								void runAction(async () => {
									if (!client) return;
									const { error: leaveError } = await client.rpc(
										"leave_organization",
										{ p_organization_id: selectedOrganization.id },
									);
									if (leaveError) throw leaveError;
									await workspaceState.refresh();
								}, "You left the organization")
							}
						/>
						{selectedOrganization.role === "owner" ? (
							<InvitationPanel
								invitations={invitations}
								inviteLink={inviteLink}
								onInvite={(email) =>
									void runAction(async () => {
										if (!client) return;
										const { data, error: inviteError } = await client.rpc(
											"create_organization_invitation",
											{
												p_organization_id: selectedOrganization.id,
												p_email: email,
											},
										);
										if (inviteError) throw inviteError;
										const row = Array.isArray(data) ? data[0] : data;
										if (!row || typeof row.token !== "string") {
											throw new Error("Invitation token was not returned");
										}
										setInviteLink(
											`${window.location.origin}/invite/${row.token}`,
										);
									}, "Invitation link created")
								}
								onRevoke={(invitation) =>
									void runAction(async () => {
										if (!client) return;
										const { error: revokeError } = await client.rpc(
											"revoke_organization_invitation",
											{ p_invitation_id: invitation.id },
										);
										if (revokeError) throw revokeError;
									}, "Invitation revoked")
								}
							/>
						) : null}
					</>
				) : null}
			</main>
		</div>
	);
}

function OrganizationPanel({
	workspaceState,
}: {
	workspaceState: ReturnType<typeof useWorkspace>;
}) {
	const [newName, setNewName] = useState("");
	const [rename, setRename] = useState("");
	const [error, setError] = useState<string | null>(null);

	return (
		<section className={panelClass}>
			<div className={panelHeaderClass}>
				<h2 className={panelTitleClass}>Organizations</h2>
			</div>
			<div className={panelBodyStackClass}>
				<div className={fieldClass}>
					<label htmlFor="settings-organization">Selected organization</label>
					<select
						id="settings-organization"
						className={inputClass}
						value={workspaceState.selectedOrganization?.id ?? ""}
						onChange={(event) =>
							workspaceState.selectOrganization(event.target.value)
						}
					>
						<option value="" disabled>
							Select an organization
						</option>
						{workspaceState.organizations.map((organization) => (
							<option key={organization.id} value={organization.id}>
								{organization.name}
							</option>
						))}
					</select>
				</div>
				<InlineNameForm
					label="New organization"
					value={newName}
					onChange={setNewName}
					button="Create"
					onSubmit={async () => {
						setError(null);
						try {
							await workspaceState.createOrganization(newName);
							setNewName("");
						} catch (actionError) {
							setError(errorMessage(actionError));
						}
					}}
				/>
				{workspaceState.selectedOrganization?.role === "owner" ? (
					<InlineNameForm
						label="Rename selected organization"
						value={rename}
						onChange={setRename}
						button="Rename"
						onSubmit={async () => {
							setError(null);
							try {
								await workspaceState.renameOrganization(rename);
								setRename("");
							} catch (actionError) {
								setError(errorMessage(actionError));
							}
						}}
					/>
				) : null}
				{error ? <p className={errorClass}>{error}</p> : null}
			</div>
		</section>
	);
}

function WorkspacePanel({
	workspaceState,
}: {
	workspaceState: ReturnType<typeof useWorkspace>;
}) {
	const [newName, setNewName] = useState("");
	const [renames, setRenames] = useState<Record<string, string>>({});
	const [error, setError] = useState<string | null>(null);
	return (
		<section className={panelClass}>
			<div className={panelHeaderClass}>
				<h2 className={panelTitleClass}>Workspaces</h2>
			</div>
			<div className={panelBodyStackClass}>
				{workspaceState.selectedOrganization?.workspaces.map((workspace) => (
					<div className={settingsRowClass} key={workspace.id}>
						<div>
							<strong>{workspace.name}</strong>
							<div className="font-mono text-xs text-text-tertiary">
								{workspace.id}
							</div>
						</div>
						<div className={inlineActionsClass}>
							<input
								className={`${inputClass} w-[min(220px,100%)] max-[800px]:w-full max-[800px]:max-w-none`}
								aria-label={`Rename ${workspace.name}`}
								placeholder="New name"
								value={renames[workspace.id] ?? ""}
								onChange={(event) =>
									setRenames((current) => ({
										...current,
										[workspace.id]: event.target.value,
									}))
								}
							/>
							<button
								className={buttonClass}
								disabled={!renames[workspace.id]?.trim()}
								onClick={() =>
									void (async () => {
										setError(null);
										try {
											await workspaceState.renameWorkspace(
												workspace.id,
												renames[workspace.id] ?? "",
											);
											setRenames((current) => ({
												...current,
												[workspace.id]: "",
											}));
										} catch (actionError) {
											setError(errorMessage(actionError));
										}
									})()
								}
							>
								Rename
							</button>
						</div>
					</div>
				))}
				<InlineNameForm
					label="New workspace"
					value={newName}
					onChange={setNewName}
					button="Create"
					onSubmit={async () => {
						setError(null);
						try {
							await workspaceState.createWorkspace(newName);
							setNewName("");
						} catch (actionError) {
							setError(errorMessage(actionError));
						}
					}}
				/>
				{error ? <p className={errorClass}>{error}</p> : null}
			</div>
		</section>
	);
}

function MemberPanel({
	members,
	currentUserId,
	isOwner,
	loading,
	onRoleChange,
	onRemove,
	onLeave,
}: {
	members: Array<Member>;
	currentUserId: string;
	isOwner: boolean;
	loading: boolean;
	onRoleChange: (member: Member, role: OrganizationRole) => void;
	onRemove: (member: Member) => void;
	onLeave: () => void;
}) {
	return (
		<section className={panelClass}>
			<div className={panelHeaderClass}>
				<h2 className={panelTitleClass}>Members</h2>
				<button className={buttonClass} onClick={onLeave}>
					Leave organization
				</button>
			</div>
			<div className={panelBodyStackClass}>
				{loading ? (
					<p className="text-sm text-text-tertiary">Loading members...</p>
				) : (
					members.map((member) => (
						<div className={settingsRowClass} key={member.userId}>
							<div>
								<strong>
									{member.name}
									{member.userId === currentUserId ? " (you)" : ""}
								</strong>
								<div className="text-text-tertiary">{member.email}</div>
							</div>
							<div className={inlineActionsClass}>
								{isOwner ? (
									<select
										className={compactSelectClass}
										aria-label={`Role for ${member.name}`}
										value={member.role}
										onChange={(event) =>
											onRoleChange(
												member,
												event.target.value as OrganizationRole,
											)
										}
									>
										<option value="member">Member</option>
										<option value="owner">Owner</option>
									</select>
								) : (
									<span className="text-text-tertiary">{member.role}</span>
								)}
								{isOwner && member.userId !== currentUserId ? (
									<button
										className={buttonClass}
										onClick={() => onRemove(member)}
									>
										Remove
									</button>
								) : null}
							</div>
						</div>
					))
				)}
			</div>
		</section>
	);
}

function InvitationPanel({
	invitations,
	inviteLink,
	onInvite,
	onRevoke,
}: {
	invitations: Array<Invitation>;
	inviteLink: string | null;
	onInvite: (email: string) => void;
	onRevoke: (invitation: Invitation) => void;
}) {
	const [email, setEmail] = useState("");
	const submit = (event: FormEvent) => {
		event.preventDefault();
		onInvite(email);
	};
	return (
		<section className={panelClass}>
			<div className={panelHeaderClass}>
				<h2 className={panelTitleClass}>Invitations</h2>
			</div>
			<div className={panelBodyStackClass}>
				<form className={inlineFormClass} onSubmit={submit}>
					<div className={`${fieldClass} grow`}>
						<label htmlFor="invite-email">Google account email</label>
						<input
							id="invite-email"
							className={inputClass}
							type="email"
							value={email}
							onChange={(event) => setEmail(event.target.value)}
							required
						/>
					</div>
					<button className={`${primaryButtonClass} max-[800px]:w-full`}>
						Create invite link
					</button>
				</form>
				{inviteLink ? (
					<div className="flex items-center gap-2.5 max-[800px]:w-full">
						<input
							className={`${inputClass} font-mono text-xs`}
							readOnly
							value={inviteLink}
						/>
						<button
							className={buttonClass}
							onClick={() => void navigator.clipboard.writeText(inviteLink)}
						>
							Copy
						</button>
					</div>
				) : null}
				{invitations.map((invitation) => (
					<div className={settingsRowClass} key={invitation.id}>
						<div>
							<strong>{invitation.email}</strong>
							<div className="text-text-tertiary">
								Expires {new Date(invitation.expiresAt).toLocaleString()}
							</div>
						</div>
						<button
							className={`${buttonClass} max-[800px]:w-full`}
							onClick={() => onRevoke(invitation)}
						>
							Revoke
						</button>
					</div>
				))}
			</div>
		</section>
	);
}

function InlineNameForm({
	label,
	value,
	onChange,
	button,
	onSubmit,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	button: string;
	onSubmit: () => Promise<void>;
}) {
	const submit = (event: FormEvent) => {
		event.preventDefault();
		void onSubmit();
	};
	return (
		<form className={inlineFormClass} onSubmit={submit}>
			<div className={`${fieldClass} grow`}>
				<label>{label}</label>
				<input
					className={inputClass}
					value={value}
					maxLength={80}
					onChange={(event) => onChange(event.target.value)}
				/>
			</div>
			<button
				className={`${buttonClass} max-[800px]:w-full`}
				disabled={!value.trim()}
			>
				{button}
			</button>
		</form>
	);
}

function SignedOutSettings() {
	return (
		<div className={workspaceEmptyClass}>
			<div className="w-[min(620px,100%)] rounded-[8px] border border-border-panel bg-bg-panel p-7 shadow-md">
				<p className="mb-2 text-[13px] font-[760] tracking-[0.08em] text-text-link uppercase">
					Workspace settings
				</p>
				<h1 className="m-0 text-[clamp(30px,5vw,42px)] leading-[1.08] tracking-normal">
					Sign in to manage workspaces.
				</h1>
				<div className="mt-3 flex items-center justify-between gap-3 max-[800px]:flex-col max-[800px]:items-stretch">
					<Link
						className={`${primaryButtonClass} max-[800px]:w-full`}
						to="/sign-in"
					>
						Sign in
					</Link>
				</div>
			</div>
		</div>
	);
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : "The operation failed";
}
