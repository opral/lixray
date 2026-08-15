import {
	coerceAtelierSessionUiState,
	type AtelierExtensionRegistration,
	type AtelierExtensionRuntime,
	type AtelierExtensionView,
	type AtelierSessionUiState,
} from "@opral/atelier";
import { Folder, Home, Sparkles, Users } from "lucide-react";
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EntryKind } from "../../lib/entry-kind.ts";
import type { LixConnectionPromptInput } from "~/lib/lix-connection-prompt";
import { DirectoryView, GettingStartedView } from "./directory-view";
import { canonicalDirectoryPath, dirNameFromPath } from "./lix-data";
import { PeopleView, type WorkspaceTeamApi } from "./people-view";

export const LIXRAY_HOME_EXTENSION_ID = "lixray_home";
export const LIXRAY_DIR_EXTENSION_ID = "lixray_dir";
export const LIXRAY_GETTING_STARTED_EXTENSION_ID = "lixray_getting_started";
export const LIXRAY_PEOPLE_EXTENSION_ID = "lixray_people";

export type LixWorkspaceConnection = Omit<LixConnectionPromptInput, "origin">;
export type AgentConnectionProbe = () => Promise<boolean>;

/** Stable central-tab identity for the folder view at dirPath. */
export const lixrayDirInstanceId = (dirPath: string): string =>
	`${LIXRAY_DIR_EXTENSION_ID}:${canonicalDirectoryPath(dirPath)}`;

/** Central-tab state for a folder view; the tab label is the folder name. */
export const lixrayDirViewState = (dirPath: string) => {
	const path = canonicalDirectoryPath(dirPath);
	return {
		kind: EntryKind.Directory,
		path,
		atelier: { label: dirNameFromPath(path) || "Folder" },
	};
};

function openFileFromView(
	atelier: AtelierExtensionRuntime,
	path: string,
	options: { newTab: boolean; created?: boolean },
) {
	void atelier.documents
		.open(path, {
			...(options.newTab ? { newTab: true } : {}),
			// A just-created file opens focused with its draft affordances,
			// matching Atelier's own new-file flow.
			...(options.created
				? {
						documentOrigin: "new" as const,
						state: { focusOnLoad: true, defaultBlock: "heading1" },
					}
				: {}),
		})
		.catch((error: unknown) => {
			console.error("workspace-home: unable to open file", error);
		});
}

function openDirFromView(
	atelier: AtelierExtensionRuntime,
	dirPath: string,
	options: { newTab: boolean },
) {
	void atelier.views
		.open(LIXRAY_DIR_EXTENSION_ID, {
			state: lixrayDirViewState(dirPath),
			instanceId: lixrayDirInstanceId(dirPath),
			...(options.newTab ? { newTab: true } : {}),
		})
		.catch((error: unknown) => {
			console.error("workspace-home: unable to open folder", error);
		});
}

function openPeopleFromView(atelier: AtelierExtensionRuntime) {
	void atelier.views
		.open(LIXRAY_PEOPLE_EXTENSION_ID)
		.catch((error: unknown) => {
			console.error("workspace-home: unable to open the People tab", error);
		});
}

function mountDirectoryView({
	element,
	atelier,
	view,
	dirPath,
	isHome,
	connection,
	teamApi,
	hasAgentConnected,
}: {
	element: HTMLElement;
	atelier: AtelierExtensionRuntime;
	view: AtelierExtensionView;
	dirPath: (candidate: AtelierExtensionView) => string;
	isHome: boolean;
	connection: LixWorkspaceConnection;
	teamApi: WorkspaceTeamApi | null;
	hasAgentConnected: AgentConnectionProbe | null;
}): { root: Root; render: (candidate: AtelierExtensionView) => void } {
	const root = createRoot(element);
	// Re-rendered on view updates so shortcut bindings track isActive.
	const render = (candidate: AtelierExtensionView) => {
		root.render(
			<StrictMode>
				<DirectoryView
					lix={atelier.lix}
					dirPath={dirPath(candidate)}
					isHome={isHome}
					readOnly={atelier.readOnly}
					connection={connection}
					teamApi={teamApi}
					hasAgentConnected={hasAgentConnected}
					isActive={candidate.isActive}
					onOpenFile={(path, options) =>
						openFileFromView(atelier, path, options)
					}
					onOpenDir={(path, options) => openDirFromView(atelier, path, options)}
					onOpenPeople={() => openPeopleFromView(atelier)}
				/>
			</StrictMode>,
		);
	};
	render(view);
	return { root, render };
}

/**
 * The workspace home — the pinned, never-closing first tab of the central
 * panel (12b/12f in the home comp).
 */
const createLixrayHomeExtension = (
	connection: LixWorkspaceConnection,
	hasAgentConnected: AgentConnectionProbe,
	teamApi: WorkspaceTeamApi | null,
): AtelierExtensionRegistration => ({
	manifest: {
		apiVersion: 1,
		id: LIXRAY_HOME_EXTENSION_ID,
		name: "Home",
		description: "Repository home: files, README, connect.",
		placement: ["central"],
		hidden: true,
	},
	entry: {
		icon: Home,
		mount: ({ element, atelier, view }) => {
			const { root, render } = mountDirectoryView({
				element,
				atelier,
				view,
				dirPath: () => "/",
				isHome: true,
				connection,
				teamApi,
				hasAgentConnected,
			});
			return {
				update: ({ view: nextView }) => render(nextView),
				dispose: () => {
					queueMicrotask(() => root.unmount());
				},
			};
		},
	},
});

/**
 * A folder opened as its own content tab (12d): same listing as home minus
 * the connect row, navigating in place by the browser-like tab rules.
 */
const createLixrayDirExtension = (
	connection: LixWorkspaceConnection,
): AtelierExtensionRegistration => ({
	manifest: {
		apiVersion: 1,
		id: LIXRAY_DIR_EXTENSION_ID,
		name: "Folder",
		description: "A repository folder as a content tab.",
		placement: ["central"],
		hidden: true,
		multiInstance: true,
	},
	entry: {
		icon: Folder,
		mount: ({ element, atelier, view }) => {
			const dirPathFromView = (candidate: AtelierExtensionView) => {
				// LIXRAY_DIR is the authoritative surface for old persisted Atelier
				// views that predate the explicit kind field. New state always writes
				// the discriminant; a conflicting discriminant fails closed.
				if (
					candidate.state.kind !== undefined &&
					candidate.state.kind !== EntryKind.Directory
				)
					return "/";
				return typeof candidate.state.path === "string"
					? canonicalDirectoryPath(candidate.state.path)
					: "/";
			};
			const { root, render } = mountDirectoryView({
				element,
				atelier,
				view,
				dirPath: dirPathFromView,
				isHome: false,
				connection,
				teamApi: null,
				hasAgentConnected: null,
			});
			return {
				update: ({ view: nextView }) => render(nextView),
				dispose: () => {
					queueMicrotask(() => root.unmount());
				},
			};
		},
	},
});

/**
 * The Getting started tab (12f): a regular closable content tab the host
 * opens as the default active tab while the workspace is empty. Home stays
 * the pinned first tab and never changes its presentation.
 */
const createLixrayGettingStartedExtension = (
	connection: LixWorkspaceConnection,
	hasAgentConnected: AgentConnectionProbe,
): AtelierExtensionRegistration => ({
	manifest: {
		apiVersion: 1,
		id: LIXRAY_GETTING_STARTED_EXTENSION_ID,
		name: "Getting started",
		description: "Connect an agent or start your first document.",
		placement: ["central"],
		hidden: true,
	},
	entry: {
		icon: Sparkles,
		mount: ({ element, atelier }) => {
			const root = createRoot(element);
			root.render(
				<StrictMode>
					<GettingStartedView
						lix={atelier.lix}
						readOnly={atelier.readOnly}
						connection={connection}
						hasAgentConnected={hasAgentConnected}
						onOpenFile={(path, options) =>
							openFileFromView(atelier, path, options)
						}
					/>
				</StrictMode>,
			);
			return {
				dispose: () => {
					queueMicrotask(() => root.unmount());
				},
			};
		},
	},
});

/**
 * The People tab (3c): the namespace roster and invite link as a regular
 * closable content tab — tabs are the shell's only navigation primitive, so
 * People behaves like any file rather than a modal or standalone route shell.
 */
const createLixrayPeopleExtension = (
	teamApi: WorkspaceTeamApi | null,
): AtelierExtensionRegistration => ({
	manifest: {
		apiVersion: 1,
		id: LIXRAY_PEOPLE_EXTENSION_ID,
		name: "People",
		description: "Who's in this repository's namespace, and the invite link.",
		placement: ["central"],
		hidden: true,
	},
	entry: {
		icon: Users,
		mount: ({ element }) => {
			const root = createRoot(element);
			root.render(
				<StrictMode>
					<PeopleView teamApi={teamApi} />
				</StrictMode>,
			);
			return {
				dispose: () => {
					queueMicrotask(() => root.unmount());
				},
			};
		},
	},
});

export const createLixrayWorkspaceExtensions = (
	connection: LixWorkspaceConnection,
	hasAgentConnected: AgentConnectionProbe,
	teamApi: WorkspaceTeamApi | null,
): readonly AtelierExtensionRegistration[] => [
	createLixrayHomeExtension(connection, hasAgentConnected, teamApi),
	createLixrayDirExtension(connection),
	createLixrayGettingStartedExtension(connection, hasAgentConnected),
	createLixrayPeopleExtension(teamApi),
];

/**
 * Opening shell state for an empty workspace: the Getting started tab open
 * and active next to the pinned Home (12f), merged into whatever tab state
 * is persisted. Applied through the session state store so the first paint
 * already shows it — an imperative views.open() here races the shell's
 * mount/restore churn.
 */
export const emptyWorkspaceOpeningUiState = (
	persisted: AtelierSessionUiState | null,
): AtelierSessionUiState => {
	const base =
		persisted ??
		coerceAtelierSessionUiState({ focusedPanel: "central", panels: {} });
	const central = base.panels.central;
	const existingInstance = central.views.find(
		(view) => view.kind === LIXRAY_GETTING_STARTED_EXTENSION_ID,
	)?.instance;
	return {
		...base,
		focusedPanel: "central",
		panels: {
			...base.panels,
			central: {
				views: existingInstance
					? central.views
					: [
							...central.views,
							{
								instance: LIXRAY_GETTING_STARTED_EXTENSION_ID,
								kind: LIXRAY_GETTING_STARTED_EXTENSION_ID,
							},
						],
				activeInstance: existingInstance ?? LIXRAY_GETTING_STARTED_EXTENSION_ID,
			},
		},
	};
};
