import { Link } from "@tanstack/react-router";
import { Bug, LogOut, Pencil, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { useAuth } from "~/components/auth-provider";
import { ProfileAvatar } from "~/components/profile-avatar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { useRepository } from "~/components/repository-provider";
import { isDemoModeEnabled } from "~/lib/demo-client";
import {
	DEMO_PROFILE_HANDLE,
	DEMO_PROFILE_NAMESPACE_ID,
} from "~/lib/demo-identity";
import {
	demoProfileDocumentWithOverride,
	editableProfileFromDocument,
	PROFILE_UPDATED_EVENT,
} from "~/lib/profile-editor";
import { cn } from "~/lib/utils";

export function AccountMenu({ className }: { className?: string }) {
	const { signOut, user } = useAuth();
	const { organizations } = useRepository();
	const personalNamespace = organizations.find(
		(organization) => organization.isPersonal,
	);
	const personalNamespaceHandle = isDemoModeEnabled
		? DEMO_PROFILE_HANDLE
		: (personalNamespace?.handle ?? null);
	const personalNamespaceId = isDemoModeEnabled
		? DEMO_PROFILE_NAMESPACE_ID
		: (personalNamespace?.id ?? null);
	const publicName = usePublicProfileName(personalNamespaceId);
	if (!user) return null;
	const fullName = accountFullName(user.user_metadata);
	const email = user.email ?? null;

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					className={cn(
						// 24px: the same footprint as the brand mark at the other end of
						// the bar, so the two ends of the header weigh the same.
						// On the white island (the workspace header) the white fill
						// would hide an initial-only avatar: canvas there instead.
						"inline-flex size-6 cursor-pointer items-center justify-center rounded-full bg-panel p-0 [[data-atelier-part=top-bar]_&]:bg-bg text-[11px] font-semibold text-fg-muted transition-colors hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
						className,
					)}
					type="button"
					aria-label="Account menu"
				>
					<ProfileAvatar
						namespaceId={personalNamespaceId}
						fallback={accountInitial(user.user_metadata)}
						className="size-full"
					/>
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="end"
				sideOffset={6}
				// Atelier's popup metrics: 4px panel padding, 32px rows, 12.5px
				// labels, 14px tertiary icons, hairline separators one row apart.
				className="w-[220px] min-w-[220px] rounded-[10px] border-border bg-panel p-1 shadow-lg [&_[data-slot=dropdown-menu-item]]:h-8 [&_[data-slot=dropdown-menu-item]]:gap-2 [&_[data-slot=dropdown-menu-item]]:rounded-[7px] [&_[data-slot=dropdown-menu-item]]:px-2 [&_[data-slot=dropdown-menu-item]]:py-0 [&_[data-slot=dropdown-menu-item]]:text-[12.5px] [&_[data-slot=dropdown-menu-item]]:font-medium [&_[data-slot=dropdown-menu-item]]:text-fg-muted [&_[data-slot=dropdown-menu-item]:focus]:bg-bg-hover [&_[data-slot=dropdown-menu-item]:focus]:text-fg [&_[data-slot=dropdown-menu-item]_svg]:size-3.5 [&_[data-slot=dropdown-menu-item]_svg]:text-fg-subtle [&_[data-slot=dropdown-menu-separator]]:mx-1 [&_[data-slot=dropdown-menu-separator]]:my-1 [&_[data-slot=dropdown-menu-separator]]:bg-border-subtle"
			>
				<div className="flex items-center gap-2 px-2 py-1.5">
					<ProfileAvatar
						namespaceId={personalNamespaceId}
						fallback={accountInitial(user.user_metadata)}
						className="size-7 bg-bg-hover-strong text-[12px] font-semibold text-fg-muted"
					/>
					<span className="flex min-w-0 flex-col">
						<span className="truncate text-[12.5px] leading-4 font-semibold text-fg">
							{publicName ?? fullName ?? email ?? "Account"}
						</span>
						{fullName && email ? (
							<span className="truncate text-[11.5px] leading-4 text-fg-subtle">
								{email}
							</span>
						) : null}
					</span>
				</div>
				<DropdownMenuSeparator />
				{personalNamespaceHandle ? (
					<>
						<DropdownMenuItem asChild>
							<Link
								to="/@{$namespace}"
								params={{ namespace: personalNamespaceHandle }}
							>
								<UserRound aria-hidden="true" />
								View profile
							</Link>
						</DropdownMenuItem>
						<DropdownMenuItem asChild>
							<Link
								to="/settings/@{$namespace}"
								params={{ namespace: personalNamespaceHandle }}
							>
								<Pencil aria-hidden="true" />
								Edit profile
							</Link>
						</DropdownMenuItem>
					</>
				) : null}
				<DropdownMenuSeparator />
				<DropdownMenuItem asChild>
					<Link to="/debug">
						<Bug aria-hidden="true" />
						Open dev tools
					</Link>
				</DropdownMenuItem>
				{!isDemoModeEnabled ? (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem onSelect={() => void signOut()}>
							<LogOut aria-hidden="true" />
							Sign out
						</DropdownMenuItem>
					</>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function usePublicProfileName(namespaceId: string | null): string | null {
	const [name, setName] = useState<string | null>(null);

	useEffect(() => {
		let controller: AbortController | null = null;
		const load = () => {
			controller?.abort();
			setName(null);
			if (!namespaceId) return;
			if (isDemoModeEnabled) {
				setName(
					editableProfileFromDocument(
						demoProfileDocumentWithOverride(window.location.origin),
					).name,
				);
				return;
			}
			const requestController = new AbortController();
			controller = requestController;
			void fetch(`/profile/${encodeURIComponent(namespaceId)}`, {
				headers: { Accept: "application/jscontact+json; version=2.0" },
				cache: "no-cache",
				signal: requestController.signal,
			})
				.then(
					async (response): Promise<unknown> =>
						response.ok ? ((await response.json()) as unknown) : null,
				)
				.then((document) => {
					if (!requestController.signal.aborted) {
						setName(editableProfileFromDocument(document).name);
					}
				})
				.catch(() => undefined);
		};
		load();
		window.addEventListener(PROFILE_UPDATED_EVENT, load);
		return () => {
			controller?.abort();
			window.removeEventListener(PROFILE_UPDATED_EVENT, load);
		};
	}, [namespaceId]);

	return name;
}

function accountFullName(
	metadata: Record<string, unknown> | undefined,
): string | null {
	const value = metadata?.full_name ?? metadata?.name;
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function accountInitial(metadata: Record<string, unknown> | undefined): string {
	const value = metadata?.full_name ?? metadata?.name;
	return typeof value === "string" && value.trim()
		? value.trim().charAt(0).toUpperCase()
		: "M";
}
