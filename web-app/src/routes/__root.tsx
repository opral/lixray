import {
	createRootRoute,
	HeadContent,
	Outlet,
	Scripts,
	useRouterState,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AuthProvider } from "~/components/auth-provider";
import { PostHogAnalytics } from "~/components/posthog-analytics";
import { Toaster } from "~/components/ui/sonner";
import { ThemeColorSync } from "~/components/theme-color-sync";
import { RepositoryProvider } from "~/components/repository-provider";
import { RepositoryMcpGuidance } from "~/components/repository-mcp-guidance";
import pwaIcons from "../pwa-icons.json";
import appCss from "../styles.css?url";

const title = "LixRay — Version control, made simple";
const description =
	"A repository for any file type. Every change is tracked and reversible. Shared with your team and your agents.";
// Absolute URL: link-preview crawlers do not resolve relative image paths.
const ogImage = "https://lixray.com/og.png";

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title },
			{ name: "description", content: description },
			{ name: "theme-color", content: "#f4f2ef" }, // token-literal: --atelier-bg (light); the meta tag cannot read var()
			{ name: "referrer", content: "no-referrer" },
			{ property: "og:title", content: title },
			{ property: "og:description", content: description },
			{ property: "og:type", content: "website" },
			{ property: "og:image", content: ogImage },
			{ property: "og:image:width", content: "2400" },
			{ property: "og:image:height", content: "1260" },
			{ name: "twitter:card", content: "summary_large_image" },
			{ name: "twitter:image", content: ogImage },
		],
		links: [{ rel: "stylesheet", href: appCss }, ...pwaIcons],
	}),
	component: Outlet,
	shellComponent: RootDocument,
});

function RootDocument({ children }: { children: ReactNode }) {
	const location = useRouterState({ select: (state) => state.location });
	return (
		<html lang="en">
			<head>
				<HeadContent />
			</head>
			<body>
				<AuthProvider>
					<RepositoryProvider>
						<PostHogAnalytics />
						{children}
					</RepositoryProvider>
				</AuthProvider>
				<RepositoryMcpGuidance
					pathname={location.pathname}
					searchStr={location.searchStr}
				/>
				<Toaster />
				<ThemeColorSync />
				<Scripts />
			</body>
		</html>
	);
}
