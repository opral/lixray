import {
	ATELIER_BUILTIN_EXTENSION_IDS,
	type AtelierExtensionRegistration,
	type AtelierExtensionRuntime,
	type AtelierExtensionView,
} from "@opral/atelier";
import { Folder, Home, Settings, Users } from "lucide-react";
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EntryKind } from "../../lib/entry-kind.ts";
import type { LixConnectionPromptInput } from "~/lib/lix-connection-prompt";
import { DirectoryView } from "./directory-view";
import { canonicalDirectoryPath, dirNameFromPath } from "./lix-data";
import { PeopleView, type RepositoryTeamApi } from "./people-view";
import { SettingsView, type RepositorySettingsApi } from "./settings-view";

export const LIXRAY_HOME_EXTENSION_ID = "lixray_home";
export const LIXRAY_DIR_EXTENSION_ID = "lixray_dir";
export const LIXRAY_PEOPLE_EXTENSION_ID = "lixray_people";
export const LIXRAY_SETTINGS_EXTENSION_ID = "lixray_settings";

export type LixRepositoryConnection = Omit<LixConnectionPromptInput, "origin">;
export type AgentConnectionProbe = () => Promise<boolean>;

/** Central-tab state for a folder view; the tab label is the folder name. */
export const lixrayDirViewState = (dirPath: string) => {
	const path = canonicalDirectoryPath(dirPath);
	return {
		kind: EntryKind.Directory,
		path,
		atelier: { label: dirNameFromPath(path) || "Folder" },
	};
};

/**
 * Navigation state for the pinned Home surface: no label override, so the
 * tab keeps reading "Home" while its listing drills into folders (flow A).
 */
export const lixrayHomeDirState = (dirPath: string) => ({
	kind: EntryKind.Directory,
	path: canonicalDirectoryPath(dirPath),
});

/**
 * The folder a Files surface is showing, read from its view state. Old
 * persisted views predate the explicit kind discriminant; a conflicting
 * discriminant fails closed to the root listing.
 */
const dirPathFromViewState = (candidate: AtelierExtensionView): string => {
	if (
		candidate.state.kind !== undefined &&
		candidate.state.kind !== EntryKind.Directory
	)
		return "/";
	return typeof candidate.state.path === "string"
		? canonicalDirectoryPath(candidate.state.path)
		: "/";
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
			console.error("repository-home: unable to open file", error);
		});
}

/**
 * Folder navigation follows flow A: a plain click navigates the current
 * Files surface in place (re-opening its own instance with a new state
 * path — the shell merges state and re-renders the same tab), while an
 * explicit new-tab gesture forks a fresh folder tab, browser-style.
 */
function openDirFromView(
	atelier: AtelierExtensionRuntime,
	surface: { isHome: boolean; instanceId: string },
	dirPath: string,
	options: { newTab: boolean },
) {
	const open = options.newTab
		? atelier.views.open(LIXRAY_DIR_EXTENSION_ID, {
				state: lixrayDirViewState(dirPath),
				newTab: true,
			})
		: surface.isHome
			? atelier.views.open(LIXRAY_HOME_EXTENSION_ID, {
					state: lixrayHomeDirState(dirPath),
				})
			: atelier.views.open(LIXRAY_DIR_EXTENSION_ID, {
					state: lixrayDirViewState(dirPath),
					instanceId: surface.instanceId,
				});
	void open.catch((error: unknown) => {
		console.error("repository-home: unable to open folder", error);
	});
}

function openPeopleFromView(atelier: AtelierExtensionRuntime) {
	void atelier.views
		.open(LIXRAY_PEOPLE_EXTENSION_ID)
		.catch((error: unknown) => {
			console.error("repository-home: unable to open the People tab", error);
		});
}

function openSettingsFromView(atelier: AtelierExtensionRuntime) {
	void atelier.views
		.open(LIXRAY_SETTINGS_EXTENSION_ID)
		.catch((error: unknown) => {
			console.error("repository-home: unable to open the Settings tab", error);
		});
}

function openSqlExplorerFromView(atelier: AtelierExtensionRuntime) {
	void atelier.views.open("sql_explorer").catch((error: unknown) => {
		console.error("repository-home: unable to open SQL Explorer", error);
	});
}

function openHistoryFromView(atelier: AtelierExtensionRuntime) {
	// A normal central tab — the archive read, not the review mode.
	void atelier.views
		.open(ATELIER_BUILTIN_EXTENSION_IDS.history)
		.catch((error: unknown) => {
			console.error("repository-home: unable to open History", error);
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
	visibility,
}: {
	element: HTMLElement;
	atelier: AtelierExtensionRuntime;
	view: AtelierExtensionView;
	dirPath: (candidate: AtelierExtensionView) => string;
	isHome: boolean;
	connection: LixRepositoryConnection;
	teamApi: RepositoryTeamApi | null;
	hasAgentConnected: AgentConnectionProbe | null;
	visibility: "private" | "public";
}): {
	root: Root;
	render: (
		candidate: AtelierExtensionView,
		runtime: AtelierExtensionRuntime,
	) => void;
} {
	const root = createRoot(element);
	// Re-rendered on view updates so shortcut bindings track isActive.
	const render = (
		candidate: AtelierExtensionView,
		runtime: AtelierExtensionRuntime,
	) => {
		root.render(
			<StrictMode>
				<DirectoryView
					lix={atelier.lix}
					diffSession={runtime.diff?.session ?? null}
					onOpenHistory={() => openHistoryFromView(runtime)}
					{...(runtime.diff
						? {
								onOpenDiffFile: (path: string) => runtime.diff?.openFile(path),
							}
						: {})}
					dirPath={dirPath(candidate)}
					isHome={isHome}
					showHiddenFiles={
						runtime.preferences.get(
							ATELIER_BUILTIN_EXTENSION_IDS.files,
							"showHiddenFiles",
						) === true
					}
					readOnly={atelier.readOnly}
					connection={connection}
					teamApi={teamApi}
					hasAgentConnected={hasAgentConnected}
					visibility={visibility}
					isActive={candidate.isActive}
					onOpenFile={(path, options) =>
						openFileFromView(atelier, path, options)
					}
					onOpenDir={(path, options) =>
						openDirFromView(
							atelier,
							{ isHome, instanceId: candidate.instanceId },
							path,
							options,
						)
					}
					onOpenPeople={() => openPeopleFromView(atelier)}
					onOpenSettings={() => openSettingsFromView(atelier)}
					onOpenSqlExplorer={() => openSqlExplorerFromView(atelier)}
					{...(!atelier.readOnly && atelier.diff
						? {
								// reveal: false — home stays the landing surface; the
								// user picks the file from the review-aware listing.
								onOpenChangesReview: () =>
									void atelier.diff?.open({
										target: { working: true },
										reveal: false,
									}),
							}
						: {})}
				/>
			</StrictMode>,
		);
	};
	render(view, atelier);
	return { root, render };
}

/**
 * The repository home — the pinned, never-closing first tab of the central
 * panel (12b/12f in the home comp).
 */
const createLixrayHomeExtension = (
	connection: LixRepositoryConnection,
	hasAgentConnected: AgentConnectionProbe,
	teamApi: RepositoryTeamApi | null,
	visibility: "private" | "public",
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
				// Home is the primary Files surface (flow A): it drills into
				// folders in place, tracking the path in its view state.
				dirPath: dirPathFromViewState,
				isHome: true,
				connection,
				teamApi,
				hasAgentConnected,
				visibility,
			});
			return {
				update: ({ atelier: nextAtelier, view: nextView }) =>
					render(nextView, nextAtelier),
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
	connection: LixRepositoryConnection,
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
			const { root, render } = mountDirectoryView({
				element,
				atelier,
				view,
				dirPath: dirPathFromViewState,
				isHome: false,
				connection,
				teamApi: null,
				hasAgentConnected: null,
				visibility: "private",
			});
			return {
				update: ({ atelier: nextAtelier, view: nextView }) =>
					render(nextView, nextAtelier),
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
	teamApi: RepositoryTeamApi | null,
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

/**
 * The Settings tab (flow A): repository management as a regular closable
 * central tab, so navigation back is just closing the tab or clicking any
 * other one.
 */
const createLixraySettingsExtension = (
	settingsApi: RepositorySettingsApi | null,
): AtelierExtensionRegistration => ({
	manifest: {
		apiVersion: 1,
		id: LIXRAY_SETTINGS_EXTENSION_ID,
		name: "Settings",
		description: "Rename, access, and deletion for this repository.",
		placement: ["central"],
		hidden: true,
	},
	entry: {
		icon: Settings,
		mount: ({ element }) => {
			const root = createRoot(element);
			root.render(
				<StrictMode>
					<SettingsView settingsApi={settingsApi} />
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

export const createLixrayRepositoryExtensions = (
	connection: LixRepositoryConnection,
	hasAgentConnected: AgentConnectionProbe,
	teamApi: RepositoryTeamApi | null,
	settingsApi: RepositorySettingsApi | null,
	visibility: "private" | "public",
): readonly AtelierExtensionRegistration[] => [
	createLixrayHomeExtension(connection, hasAgentConnected, teamApi, visibility),
	createLixrayDirExtension(connection),
	createLixrayPeopleExtension(teamApi),
	createLixraySettingsExtension(settingsApi),
];
