import { Link } from "@tanstack/react-router";
import { LogOut, Pencil, UserRound } from "lucide-react";
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
import { cn } from "~/lib/utils";

export function AccountMenu({ className }: { className?: string }) {
	const { signOut, user } = useAuth();
	const { organizations } = useRepository();
	if (!user) return null;
	const personalNamespace = organizations.find(
		(organization) => organization.isPersonal,
	);
	const personalNamespaceHandle = isDemoModeEnabled
		? DEMO_PROFILE_HANDLE
		: (personalNamespace?.handle ?? null);
	const personalNamespaceId = isDemoModeEnabled
		? DEMO_PROFILE_NAMESPACE_ID
		: (personalNamespace?.id ?? null);
	const fullName = accountFullName(user.user_metadata);
	const email = user.email ?? null;

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					className={cn(
						"inline-flex size-[30px] cursor-pointer items-center justify-center rounded-full border border-border-panel bg-bg-action-secondary p-0 text-[11px] font-semibold text-text-on-action-secondary transition hover:-translate-y-px hover:bg-bg-action-secondary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring-focus-visible",
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
				className="w-[232px] min-w-[232px] rounded-[10px] border-border-panel bg-bg-panel p-[5px] shadow-lg [&_[data-slot=dropdown-menu-item]]:gap-[9px] [&_[data-slot=dropdown-menu-item]]:rounded-[7px] [&_[data-slot=dropdown-menu-item]]:px-2.5 [&_[data-slot=dropdown-menu-item]]:py-2 [&_[data-slot=dropdown-menu-item]]:text-[13px] [&_[data-slot=dropdown-menu-item]]:text-text-secondary [&_[data-slot=dropdown-menu-item]:focus]:bg-bg-hover [&_[data-slot=dropdown-menu-item]_svg]:size-3.5 [&_[data-slot=dropdown-menu-item]_svg]:text-icon-tertiary [&_[data-slot=dropdown-menu-separator]]:mx-2 [&_[data-slot=dropdown-menu-separator]]:my-[5px] [&_[data-slot=dropdown-menu-separator]]:bg-border-subtle"
			>
				<div className="flex items-center gap-2.5 px-2.5 py-2">
					<ProfileAvatar
						namespaceId={personalNamespaceId}
						fallback={accountInitial(user.user_metadata)}
						className="size-7 bg-bg-hover-canvas text-[12px] font-semibold text-text-secondary"
					/>
					<span className="flex min-w-0 flex-col gap-px">
						<span className="truncate text-[13px] leading-tight font-semibold text-text-primary">
							{fullName ?? email ?? "Account"}
						</span>
						{fullName && email ? (
							<span className="truncate text-[11.5px] leading-tight text-text-tertiary">
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
