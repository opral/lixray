import { createFileRoute, Link } from "@tanstack/react-router";
import { DatabaseZap } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useAuth } from "~/components/auth-provider";
import {
	type OrganizationRole,
	useWorkspace,
} from "~/components/workspace-provider";

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
		return <div className="workspace-empty">Loading...</div>;
	}
	if (!user) return <SignedOutSettings />;

	return (
		<div className="app-shell">
			<header className="topbar">
				<Link to="/" className="brand">
					<span className="brand-mark">
						<DatabaseZap size={17} aria-hidden="true" />
					</span>
					<span>Lixray</span>
				</Link>
				<Link to="/" className="button">
					Back to workspace
				</Link>
			</header>
			<main className="page settings-grid">
				<section className="page-heading">
					<p className="eyebrow">Workspace settings</p>
					<h1>Organizations, workspaces, and members</h1>
				</section>

				{error ? <div className="error-box">{error}</div> : null}
				{notice ? <div className="notice-box">{notice}</div> : null}

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
		<section className="panel">
			<div className="panel-header">
				<h2 className="panel-title">Organizations</h2>
			</div>
			<div className="panel-body settings-stack">
				<div className="field">
					<label htmlFor="settings-organization">Selected organization</label>
					<select
						id="settings-organization"
						className="input"
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
				{error ? <p className="error-box">{error}</p> : null}
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
		<section className="panel">
			<div className="panel-header">
				<h2 className="panel-title">Workspaces</h2>
			</div>
			<div className="panel-body settings-stack">
				{workspaceState.selectedOrganization?.workspaces.map((workspace) => (
					<div className="settings-row" key={workspace.id}>
						<div>
							<strong>{workspace.name}</strong>
							<div className="code muted">{workspace.id}</div>
						</div>
						<div className="inline-actions">
							<input
								className="input compact-input"
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
								className="button"
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
				{error ? <p className="error-box">{error}</p> : null}
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
		<section className="panel">
			<div className="panel-header">
				<h2 className="panel-title">Members</h2>
				<button className="button" onClick={onLeave}>
					Leave organization
				</button>
			</div>
			<div className="panel-body settings-stack">
				{loading ? (
					<p className="status-line">Loading members...</p>
				) : (
					members.map((member) => (
						<div className="settings-row" key={member.userId}>
							<div>
								<strong>
									{member.name}
									{member.userId === currentUserId ? " (you)" : ""}
								</strong>
								<div className="muted">{member.email}</div>
							</div>
							<div className="inline-actions">
								{isOwner ? (
									<select
										className="compact-select"
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
									<span className="muted">{member.role}</span>
								)}
								{isOwner && member.userId !== currentUserId ? (
									<button className="button" onClick={() => onRemove(member)}>
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
		<section className="panel">
			<div className="panel-header">
				<h2 className="panel-title">Invitations</h2>
			</div>
			<div className="panel-body settings-stack">
				<form className="inline-form" onSubmit={submit}>
					<div className="field grow">
						<label htmlFor="invite-email">Google account email</label>
						<input
							id="invite-email"
							className="input"
							type="email"
							value={email}
							onChange={(event) => setEmail(event.target.value)}
							required
						/>
					</div>
					<button className="button primary">Create invite link</button>
				</form>
				{inviteLink ? (
					<div className="invite-link">
						<input className="input code" readOnly value={inviteLink} />
						<button
							className="button"
							onClick={() => void navigator.clipboard.writeText(inviteLink)}
						>
							Copy
						</button>
					</div>
				) : null}
				{invitations.map((invitation) => (
					<div className="settings-row" key={invitation.id}>
						<div>
							<strong>{invitation.email}</strong>
							<div className="muted">
								Expires {new Date(invitation.expiresAt).toLocaleString()}
							</div>
						</div>
						<button className="button" onClick={() => onRevoke(invitation)}>
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
		<form className="inline-form" onSubmit={submit}>
			<div className="field grow">
				<label>{label}</label>
				<input
					className="input"
					value={value}
					maxLength={80}
					onChange={(event) => onChange(event.target.value)}
				/>
			</div>
			<button className="button" disabled={!value.trim()}>
				{button}
			</button>
		</form>
	);
}

function SignedOutSettings() {
	return (
		<div className="workspace-empty">
			<div className="workspace-empty-inner">
				<p className="eyebrow">Workspace settings</p>
				<h1>Sign in to manage workspaces.</h1>
				<div className="toolbar">
					<Link className="button primary" to="/sign-in">
						Sign in with Google
					</Link>
				</div>
			</div>
		</div>
	);
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : "The operation failed";
}
