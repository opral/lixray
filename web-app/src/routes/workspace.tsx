import { createFileRoute, Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { AppTitlebar, AppTitlebarBrand } from "~/components/app-titlebar";
import { useAuth } from "~/components/auth-provider";
import { useWorkspace } from "~/components/workspace-provider";

const workspaceEmptyClass =
	"grid min-h-[calc(100vh_-_44px)] place-items-center px-5 py-10";
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

function WorkspacePage() {
	const { isLoaded: authLoaded, user } = useAuth();
	const workspaceState = useWorkspace();
	const { selectedOrganization } = workspaceState;

	if (!authLoaded || !workspaceState.isLoaded) {
		return (
			<div className="min-h-screen bg-bg-app">
				<AppTitlebar>
					<AppTitlebarBrand />
				</AppTitlebar>
				<main className={workspaceEmptyClass}>Loading...</main>
			</div>
		);
	}
	if (!user) return <SignedOutSettings />;

	return (
		<div className="min-h-screen">
			<AppTitlebar className="sticky top-0 z-10 bg-bg-app/90 backdrop-blur-[16px]">
				<AppTitlebarBrand />
				<Link to="/home" className={`${buttonClass} ml-auto min-h-7 px-2.5`}>
					Back to workspace
				</Link>
			</AppTitlebar>
			<main className="mx-auto grid w-[min(1180px,calc(100%_-_40px))] gap-[18px] pt-6 pb-12 max-[800px]:w-[min(1180px,calc(100%_-_24px))] max-[800px]:pt-[22px]">
				<section className="mb-[18px] max-w-[760px]">
					<p className="mb-2 text-[13px] font-[760] tracking-[0.08em] text-text-link uppercase">
						Workspace settings
					</p>
					<h1 className="m-0 text-2xl leading-[1.2] tracking-normal">
						Namespaces and workspaces
					</h1>
				</section>

				<OrganizationPanel workspaceState={workspaceState} />

				{selectedOrganization && selectedOrganization.role !== null ? (
					<WorkspacePanel workspaceState={workspaceState} />
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
				<h2 className={panelTitleClass}>Namespaces</h2>
			</div>
			<div className={panelBodyStackClass}>
				<div className={fieldClass}>
					<label htmlFor="settings-organization">Selected namespace</label>
					<select
						id="settings-organization"
						className={inputClass}
						value={workspaceState.selectedOrganization?.id ?? ""}
						onChange={(event) =>
							workspaceState.selectOrganization(event.target.value)
						}
					>
						<option value="" disabled>
							Select a namespace
						</option>
						{workspaceState.organizations.map((organization) => (
							<option key={organization.id} value={organization.id}>
								{organization.name}
							</option>
						))}
					</select>
				</div>
				<InlineNameForm
					label="New organization namespace"
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
						label="Rename selected namespace"
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
		<div className="min-h-screen bg-bg-app">
			<AppTitlebar>
				<AppTitlebarBrand />
			</AppTitlebar>
			<main className={workspaceEmptyClass}>
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
			</main>
		</div>
	);
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : "The operation failed";
}
