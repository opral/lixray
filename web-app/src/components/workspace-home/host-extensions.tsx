import type {
	AtelierExtensionRegistration,
	AtelierExtensionRuntime,
	AtelierExtensionView,
} from "@opral/atelier";
import { Folder, Home } from "lucide-react";
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DirectoryView } from "./directory-view";
import { dirNameFromPath, normalizeHomeDirPath } from "./lix-data";

export const LIXRAY_HOME_EXTENSION_ID = "lixray_home";
export const LIXRAY_DIR_EXTENSION_ID = "lixray_dir";

// Keep in sync with MCP_DOCUMENTATION_PATH in ~/mcp/server (not imported to
// keep MCP server code out of the client bundle).
const MCP_DOCUMENTATION_PATH = "/docs/mcp";

/** Stable central-tab identity for the folder view at dirPath. */
export const lixrayDirInstanceId = (dirPath: string): string =>
	`${LIXRAY_DIR_EXTENSION_ID}:${normalizeHomeDirPath(dirPath)}`;

/** Central-tab state for a folder view; the tab label is the folder name. */
export const lixrayDirViewState = (dirPath: string) => {
	const normalized = normalizeHomeDirPath(dirPath);
	return {
		path: normalized,
		atelier: { label: dirNameFromPath(normalized) || "Folder" },
	};
};

function openFileFromView(
	atelier: AtelierExtensionRuntime,
	path: string,
	options: { newTab: boolean },
) {
	void atelier.documents
		.open(path, options.newTab ? { newTab: true } : {})
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

function mountDirectoryView({
	element,
	atelier,
	dirPath,
	isHome,
}: {
	element: HTMLElement;
	atelier: AtelierExtensionRuntime;
	dirPath: string;
	isHome: boolean;
}): Root {
	const root = createRoot(element);
	root.render(
		<StrictMode>
			<DirectoryView
				lix={atelier.lix}
				dirPath={dirPath}
				isHome={isHome}
				readOnly={atelier.readOnly}
				connectHref={MCP_DOCUMENTATION_PATH}
				onOpenFile={(path, options) =>
					openFileFromView(atelier, path, options)
				}
				onOpenDir={(path, options) => openDirFromView(atelier, path, options)}
			/>
		</StrictMode>,
	);
	return root;
}

/**
 * The workspace home — the pinned, never-closing first tab of the central
 * panel (12b/12f in the home comp).
 */
export const lixrayHomeExtension: AtelierExtensionRegistration = {
	manifest: {
		apiVersion: 1,
		id: LIXRAY_HOME_EXTENSION_ID,
		name: "Home",
		description: "Workspace home: files, README, connect.",
		placement: ["central"],
		hidden: true,
	},
	entry: {
		icon: Home,
		mount: ({ element, atelier }) => {
			const root = mountDirectoryView({
				element,
				atelier,
				dirPath: "/",
				isHome: true,
			});
			return {
				dispose: () => {
					queueMicrotask(() => root.unmount());
				},
			};
		},
	},
};

/**
 * A folder opened as its own content tab (12d): same listing as home minus
 * the connect row, navigating in place by the browser-like tab rules.
 */
export const lixrayDirExtension: AtelierExtensionRegistration = {
	manifest: {
		apiVersion: 1,
		id: LIXRAY_DIR_EXTENSION_ID,
		name: "Folder",
		description: "A workspace folder as a content tab.",
		placement: ["central"],
		hidden: true,
		multiInstance: true,
	},
	entry: {
		icon: Folder,
		mount: ({ element, atelier, view }) => {
			const dirPathFromView = (candidate: AtelierExtensionView) =>
				normalizeHomeDirPath(
					typeof candidate.state.path === "string" ? candidate.state.path : "/",
				);
			const root = mountDirectoryView({
				element,
				atelier,
				dirPath: dirPathFromView(view),
				isHome: false,
			});
			return {
				dispose: () => {
					queueMicrotask(() => root.unmount());
				},
			};
		},
	},
};

export const lixrayWorkspaceExtensions: readonly AtelierExtensionRegistration[] =
	[lixrayHomeExtension, lixrayDirExtension];
