import { Link } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { useAuth } from "~/components/auth-provider";
import {
	type ActiveWorkspace,
	useWorkspace,
} from "~/components/workspace-provider";
import { isE2eAuthEnabled } from "~/lib/e2e-client";

export function WorkspaceGate({
	children,
}: {
	children: (activeWorkspace: ActiveWorkspace) => ReactNode;
}) {
	if (isE2eAuthEnabled) {
		return <LoadedWorkspace>{children}</LoadedWorkspace>;
	}
	return <AuthenticatedWorkspaceGate>{children}</AuthenticatedWorkspaceGate>;
}

function AuthenticatedWorkspaceGate({
	children,
}: {
	children: (activeWorkspace: ActiveWorkspace) => ReactNode;
}) {
	const { isLoaded: authLoaded, user } = useAuth();
	const {
		activeWorkspace,
		createOrganization,
		createWorkspace,
		error,
		isLoaded: workspaceLoaded,
		organizations,
		refresh,
		selectedOrganization,
	} = useWorkspace();

	if (!authLoaded || !workspaceLoaded) {
		return <div className="workspace-empty">Loading...</div>;
	}
	if (!user) return <SignedOutHome />;
	if (error) {
		return (
			<EmptyState eyebrow="Unable to load workspaces" title={error}>
				<button className="button primary" onClick={() => void refresh()}>
					Try again
				</button>
			</EmptyState>
		);
	}
	if (organizations.length === 0) {
		return (
			<NamePrompt
				eyebrow="Organization required"
				title="Create your organization."
				label="Organization name"
				buttonLabel="Create organization"
				onSubmit={createOrganization}
			/>
		);
	}
	if (selectedOrganization && selectedOrganization.workspaces.length === 0) {
		return (
			<NamePrompt
				eyebrow={selectedOrganization.name}
				title="Create your first workspace."
				label="Workspace name"
				buttonLabel="Create workspace"
				onSubmit={createWorkspace}
			/>
		);
	}
	if (!activeWorkspace) {
		return <div className="workspace-empty">Loading workspace...</div>;
	}
	return <>{children(activeWorkspace)}</>;
}

function LoadedWorkspace({
	children,
}: {
	children: (activeWorkspace: ActiveWorkspace) => ReactNode;
}) {
	const { activeWorkspace } = useWorkspace();
	return activeWorkspace ? <>{children(activeWorkspace)}</> : null;
}

function SignedOutHome() {
	return (
		<EmptyState eyebrow="Lixray" title="Sign in to continue.">
			<Link className="button primary" to="/sign-in">
				Sign in with Google
			</Link>
		</EmptyState>
	);
}

function NamePrompt({
	eyebrow,
	title,
	label,
	buttonLabel,
	onSubmit,
}: {
	eyebrow: string;
	title: string;
	label: string;
	buttonLabel: string;
	onSubmit: (name: string) => Promise<void>;
}) {
	const [name, setName] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setSubmitting(true);
		setError(null);
		try {
			await onSubmit(name);
		} catch (submitError) {
			setError(
				submitError instanceof Error
					? submitError.message
					: "Unable to continue",
			);
			setSubmitting(false);
		}
	};

	return (
		<EmptyState eyebrow={eyebrow} title={title}>
			<form
				className="onboarding-form"
				onSubmit={(event) => void submit(event)}
			>
				<div className="field">
					<label htmlFor="onboarding-name">{label}</label>
					<input
						id="onboarding-name"
						className="input"
						value={name}
						maxLength={80}
						autoFocus
						onChange={(event) => setName(event.target.value)}
					/>
				</div>
				<button
					className="button primary"
					disabled={submitting || !name.trim()}
				>
					{submitting ? "Creating..." : buttonLabel}
				</button>
				{error ? <p className="error-box">{error}</p> : null}
			</form>
		</EmptyState>
	);
}

function EmptyState({
	eyebrow,
	title,
	children,
}: {
	eyebrow: string;
	title: string;
	children: ReactNode;
}) {
	return (
		<main className="workspace-empty">
			<div className="workspace-empty-inner">
				<p className="eyebrow">{eyebrow}</p>
				<h1>{title}</h1>
				<div className="toolbar">{children}</div>
			</div>
		</main>
	);
}
