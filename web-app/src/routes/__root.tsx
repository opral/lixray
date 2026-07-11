import {
	createRootRoute,
	HeadContent,
	Outlet,
	Scripts,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AuthProvider } from "~/components/auth-provider";
import { Toaster } from "~/components/ui/sonner";
import { WorkspaceProvider } from "~/components/workspace-provider";
import appCss from "../styles.css?url";

const title = "Lixray";
const description = "Workspace-scoped Lix over HTTP, backed by SlateDB on R2.";

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title },
			{ name: "description", content: description },
		],
		links: [
			{ rel: "stylesheet", href: appCss },
			{ rel: "preconnect", href: "https://fonts.googleapis.com" },
			{
				rel: "preconnect",
				href: "https://fonts.gstatic.com",
				crossOrigin: "anonymous",
			},
			{
				rel: "stylesheet",
				href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;520;600;680;720;760&family=JetBrains+Mono:wght@400;500;600&display=swap",
			},
		],
	}),
	component: Outlet,
	shellComponent: RootDocument,
});

function RootDocument({ children }: { children: ReactNode }) {
	return (
		<html lang="en">
			<head>
				<HeadContent />
			</head>
			<body>
				<AuthProvider>
					<WorkspaceProvider>{children}</WorkspaceProvider>
				</AuthProvider>
				<Toaster />
				<Scripts />
			</body>
		</html>
	);
}
