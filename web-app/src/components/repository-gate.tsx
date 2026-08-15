import { Link } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { useAuth } from "~/components/auth-provider";
import {
	type ActiveRepository,
	useRepository,
} from "~/components/repository-provider";
import { isDemoModeEnabled } from "~/lib/demo-client";

const repositoryEmptyClass =
	"grid min-h-[calc(100vh_-_80px)] place-items-center px-5 py-10";
const buttonClass =
	"inline-flex min-h-[38px] cursor-pointer items-center justify-center gap-2 rounded-[7px] border border-bg-action-primary bg-bg-action-primary px-3.5 font-[680] text-text-on-action-primary no-underline disabled:cursor-not-allowed disabled:opacity-[0.55] max-[800px]:w-full";
const fieldClass =
	"grid gap-2 [&_label]:text-[13px] [&_label]:font-[680] [&_label]:text-text-secondary";
const inputClass =
	"h-[42px] w-full rounded-[7px] border border-border-panel bg-bg-panel px-3 text-text-primary outline-none focus:border-border-panel focus:outline-2 focus:outline-offset-1 focus:outline-ring-focus-visible";
const errorClass =
	"mt-3.5 whitespace-pre-wrap rounded-[8px] border border-error-200 bg-error-50 px-3.5 py-3 text-error-800";

export function RepositoryGate({
	children,
}: {
	children: (activeRepository: ActiveRepository) => ReactNode;
}) {
	if (isDemoModeEnabled) {
		return <LoadedRepository>{children}</LoadedRepository>;
	}
	return <AuthenticatedRepositoryGate>{children}</AuthenticatedRepositoryGate>;
}

function AuthenticatedRepositoryGate({
	children,
}: {
	children: (activeRepository: ActiveRepository) => ReactNode;
}) {
	const { isLoaded: authLoaded, user } = useAuth();
	const {
		activeRepository,
		createOrganization,
		createRepository,
		error,
		isLoaded: repositoryLoaded,
		organizations,
		refresh,
		selectedOrganization,
	} = useRepository();

	if (!authLoaded || !repositoryLoaded) {
		return <div className={repositoryEmptyClass}>Loading...</div>;
	}
	if (!user) return <SignedOutHome />;
	if (error) {
		return (
			<EmptyState eyebrow="Unable to load repositories" title={error}>
				<button className={buttonClass} onClick={() => void refresh()}>
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
	if (selectedOrganization && selectedOrganization.repositories.length === 0) {
		return (
			<NamePrompt
				eyebrow={selectedOrganization.name}
				title="Create your first repository."
				label="Repository name"
				buttonLabel="Create repository"
				onSubmit={createRepository}
			/>
		);
	}
	if (!activeRepository) {
		return <div className={repositoryEmptyClass}>Loading repository...</div>;
	}
	return <>{children(activeRepository)}</>;
}

function LoadedRepository({
	children,
}: {
	children: (activeRepository: ActiveRepository) => ReactNode;
}) {
	const { activeRepository } = useRepository();
	return activeRepository ? <>{children(activeRepository)}</> : null;
}

function SignedOutHome() {
	return (
		<EmptyState eyebrow="LixRay" title="Sign in to continue.">
			<Link className={buttonClass} to="/sign-in">
				Sign in
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
				className="mt-3.5 grid w-full gap-3.5"
				onSubmit={(event) => void submit(event)}
			>
				<div className={fieldClass}>
					<label htmlFor="onboarding-name">{label}</label>
					<input
						id="onboarding-name"
						className={inputClass}
						value={name}
						maxLength={80}
						autoFocus
						onChange={(event) => setName(event.target.value)}
					/>
				</div>
				<button className={buttonClass} disabled={submitting || !name.trim()}>
					{submitting ? "Creating..." : buttonLabel}
				</button>
				{error ? <p className={errorClass}>{error}</p> : null}
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
		<main className={repositoryEmptyClass}>
			<div className="w-[min(620px,100%)] rounded-[8px] border border-border-panel bg-bg-panel p-7 shadow-md">
				<p className="mb-2 text-[13px] font-[760] tracking-[0.08em] text-text-link uppercase">
					{eyebrow}
				</p>
				<h1 className="m-0 text-[clamp(30px,5vw,42px)] leading-[1.08] tracking-normal">
					{title}
				</h1>
				<div className="mt-3 flex items-center justify-between gap-3 max-[800px]:flex-col max-[800px]:items-stretch">
					{children}
				</div>
			</div>
		</main>
	);
}
