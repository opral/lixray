import {
	createFileRoute,
	Link,
	Outlet,
	useRouterState,
} from "@tanstack/react-router";
import { ArrowRight, Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { AccountMenu } from "~/components/account-menu";
import { AppTitlebar, AppTitlebarBrand } from "~/components/app-titlebar";
import { useAuth } from "~/components/auth-provider";
import { useRepository } from "~/components/repository-provider";
import { Button } from "~/components/ui/button";
import {
	type ProfileRepositoryActivity,
	type PublicProfileActivity,
} from "~/lib/profile-activity-aggregate";
import { formatRelativeTime } from "~/lib/format";
import { resolvePublicProfileActivity } from "~/lib/public-profile-activity";
import {
	resolvePublicProfileByHandle,
	type PublicProfile,
} from "~/lib/public-profile";

export const Route = createFileRoute("/@{$namespace}")({
	ssr: false,
	component: PublicProfileRoute,
});

function PublicProfileRoute() {
	const { namespace } = Route.useParams();
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	if (pathname !== `/@${namespace}` && pathname !== `/@${namespace}/`) {
		return <Outlet />;
	}
	return <PublicProfilePage />;
}

function PublicProfilePage() {
	const { namespace } = Route.useParams();
	const { isLoaded: authLoaded, user } = useAuth();
	const [profile, setProfile] = useState<PublicProfile | null | undefined>();
	const [error, setError] = useState<string | null>(null);
	const [activity, setActivity] = useState<
		PublicProfileActivity | null | undefined
	>();
	const [activityError, setActivityError] = useState<string | null>(null);

	useEffect(() => {
		let disposed = false;
		setProfile(undefined);
		setError(null);
		setActivity(undefined);
		setActivityError(null);
		void (async () => {
			try {
				const nextProfile = await resolvePublicProfileByHandle(namespace);
				if (disposed) return;
				setProfile(nextProfile);
				if (!nextProfile) return;
				try {
					const nextActivity = await resolvePublicProfileActivity(nextProfile);
					if (!disposed) setActivity(nextActivity);
				} catch (caught) {
					if (disposed) return;
					setActivityError(
						caught instanceof Error
							? caught.message
							: "Unable to load public repositories.",
					);
					setActivity(null);
				}
			} catch (caught) {
				if (disposed) return;
				setError(
					caught instanceof Error
						? caught.message
						: "Unable to load this profile.",
				);
				setProfile(null);
			}
		})();
		return () => {
			disposed = true;
		};
	}, [namespace]);

	return (
		<div className="min-h-dvh bg-bg-app font-sans text-text-primary">
			<ProfileHeader authLoaded={authLoaded} signedIn={Boolean(user)} />
			{profile === undefined ? (
				<ProfileStatus>Loading profile…</ProfileStatus>
			) : profile === null ? (
				<ProfileStatus>
					{error ?? `The @${namespace} profile does not exist.`}
				</ProfileStatus>
			) : (
				<ProfileContent
					profile={profile}
					activity={activity}
					activityError={activityError}
				/>
			)}
		</div>
	);
}

function ProfileHeader({
	authLoaded,
	signedIn,
}: {
	authLoaded: boolean;
	signedIn: boolean;
}) {
	return (
		<AppTitlebar>
			<AppTitlebarBrand href={signedIn ? "/home" : "/"} />
			<div className="ml-auto flex items-center gap-2.5">
				{signedIn ? (
					<AccountMenu />
				) : (
					<>
						<Button asChild variant="ghost" size="sm" disabled={!authLoaded}>
							<Link to="/sign-in">Sign in</Link>
						</Button>
						<Button asChild variant="featured" size="sm" disabled={!authLoaded}>
							<Link to="/sign-in">Get started</Link>
						</Button>
					</>
				)}
			</div>
		</AppTitlebar>
	);
}

function ProfileContent({
	profile,
	activity,
	activityError,
}: {
	profile: PublicProfile;
	activity: PublicProfileActivity | null | undefined;
	activityError: string | null;
}) {
	const { organizations } = useRepository();
	const memberOrganization =
		organizations.find(
			(organization) => organization.id === profile.namespaceId,
		) ?? null;
	const isOwner = Boolean(
		memberOrganization &&
			(memberOrganization.isPersonal || memberOrganization.role === "owner"),
	);
	const hasDetails =
		Boolean(profile.title || profile.organization || profile.location) ||
		profile.links.length > 0;
	return (
		<main className="mx-auto flex w-full max-w-[1240px] gap-[72px] px-16 pt-14 pb-20 max-[900px]:gap-10 max-[760px]:flex-col max-[760px]:gap-7 max-[760px]:px-6 max-[760px]:pt-7 max-[760px]:pb-12">
			<aside className="flex w-[264px] shrink-0 flex-col gap-5 max-[760px]:w-full">
				<div className="size-[108px] overflow-hidden rounded-full border border-[#1c1917]/10 bg-[#1c1917] text-[42px] font-bold text-[#fbf6f0] max-[760px]:size-[68px] max-[760px]:text-[28px]">
					{profile.avatarUri ? (
						<img
							src={profile.avatarUri}
							alt={`${profile.name} profile`}
							className="size-full object-cover"
							referrerPolicy="no-referrer"
						/>
					) : (
						<span className="grid size-full place-items-center">
							{profile.name.charAt(0).toUpperCase()}
						</span>
					)}
				</div>
				<div className="flex flex-col gap-1">
					<h1 className="m-0 text-[27px] leading-[1.15] font-bold tracking-[-0.025em] max-[760px]:text-[21px]">
						{profile.name}
					</h1>
					<p className="m-0 font-mono text-[14px] text-[#8a8178]">
						@{profile.handle}
					</p>
				</div>
				{profile.bio ? (
					<p className="m-0 text-[14.5px] leading-[1.6] text-[#57534e]">
						{profile.bio}
					</p>
				) : null}
				{isOwner ? (
					<Button
						asChild
						variant="outline"
						size="sm"
						className="h-8 w-full bg-white/40"
					>
						<Link
							to="/settings/@{$namespace}"
							params={{ namespace: profile.handle }}
						>
							Edit profile
						</Link>
					</Button>
				) : null}

				{hasDetails ? (
					<>
						<div className="h-px bg-[#eae2d6]" />
						<div className="flex flex-col gap-[9px] text-[13.5px] text-[#57534e]">
							{profile.title || profile.organization ? (
								<span>
									{[profile.title, profile.organization]
										.filter(Boolean)
										.join(" · ")}
								</span>
							) : null}
							{profile.location ? <span>{profile.location}</span> : null}
							{profile.links.map((link) => (
								<a
									key={link.uri}
									className="font-semibold text-[#c2410c] no-underline hover:text-[#9a3412]"
									href={link.uri}
									target="_blank"
									rel="noreferrer"
								>
									{link.label}
								</a>
							))}
						</div>
					</>
				) : null}

				<div className="h-px bg-[#eae2d6]" />
				<span className="text-[12px] text-[#b5afa6]">
					On LixRay since {joinedMonth(profile.joinedAt)}
				</span>
			</aside>

			<section
				className="flex min-w-0 flex-1 flex-col gap-10 pt-2 max-[760px]:pt-0"
				aria-labelledby="profile-files-title"
			>
				{activity === undefined ? (
					<ProfileActivityStatus>
						Loading public repositories…
					</ProfileActivityStatus>
				) : activity === null ? (
					<ProfileActivityStatus>
						{activityError ?? "Unable to load public repositories."}
					</ProfileActivityStatus>
				) : (
					<ProfileActivityContent
						activity={activity}
						memberRepositories={memberOrganization?.repositories ?? null}
						profileHandle={profile.handle}
					/>
				)}
			</section>
		</main>
	);
}

function ProfileActivityContent({
	activity,
	memberRepositories,
	profileHandle,
}: {
	activity: PublicProfileActivity;
	memberRepositories: Array<MemberRepository> | null;
	profileHandle: string;
}) {
	const visibleFileMix = activity.fileMix.filter(
		(segment) => segment.count > 0,
	);
	// The public feed is served from a cache that can lag behind visibility
	// changes, so a member's own data fills in anything the feed is missing.
	const feedRepositoryIds = new Set(
		activity.repositories.map((repository) => repository.id),
	);
	const memberOnlyRepositories = (memberRepositories ?? []).filter(
		(repository) => !feedRepositoryIds.has(repository.id),
	);
	const publicCount =
		activity.repositories.length +
		memberOnlyRepositories.filter(
			(repository) => repository.visibility === "public",
		).length;
	const privateCount = memberOnlyRepositories.filter(
		(repository) => repository.visibility === "private",
	).length;
	return (
		<>
			<div>
				<div className="flex items-baseline gap-2.5">
					<h2 id="profile-files-title" className="m-0 text-[15px] font-bold">
						Statistics
					</h2>
					<p className="m-0 text-[12.5px] text-[#a8a29e]">
						{profileFileSummary(activity)}
						{activity.computedAt
							? ` · updated ${formatRelativeTime(activity.computedAt)}`
							: ""}
					</p>
				</div>

				{visibleFileMix.length > 0 ? (
					<>
						<div className="mt-3.5 flex h-4 gap-[3px]">
							{visibleFileMix.map((segment) => (
								<span
									key={segment.label}
									style={{
										flexGrow: segment.percentage,
										flexBasis: 0,
										background: segment.color,
									}}
									className="rounded-[5px]"
								/>
							))}
						</div>
						<div className="mt-2.5">
							{visibleFileMix.map((segment) => (
								<div
									className="flex items-center gap-2.5 border-t border-[#efe8dc] px-0.5 py-2 text-[13px] first:border-t-0"
									key={segment.label}
								>
									<span
										className="size-2.5 shrink-0 rounded-[3px]"
										style={{ background: segment.color }}
									/>
									<span className="font-semibold">{segment.label}</span>
									<span className="text-[12px] text-[#a8a29e]">
										{segment.examples}
									</span>
									<span className="ml-auto shrink-0 text-[12px] text-[#a8a29e]">
										{segment.percentage}%
									</span>
								</div>
							))}
						</div>
					</>
				) : (
					<p className="m-0 mt-3 text-[13px] text-[#8a8178]">
						{activity.repositories.length === 0
							? "No public repositories yet."
							: activity.failedRepositories === activity.repositories.length
								? "File totals are temporarily unavailable."
								: "No files in these public repositories yet."}
					</p>
				)}
				{activity.failedRepositories > 0 ? (
					<p className="m-0 mt-2 text-[12px] text-[#a8a29e]">
						{activity.failedRepositories} recovering{" "}
						{activity.failedRepositories === 1
							? "repository is"
							: "repositories are"}{" "}
						not included in the file total yet.
					</p>
				) : null}
			</div>

			<div>
				<div className="flex items-baseline gap-2.5 pb-3">
					<h2 className="m-0 text-[15px] font-bold">Repositories</h2>
					<p className="m-0 text-[12.5px] text-[#a8a29e]">
						{publicCount} public
						{privateCount > 0 ? ` · ${privateCount} private` : ""}
					</p>
				</div>
				{activity.repositories.length === 0 &&
				memberOnlyRepositories.length === 0 ? (
					<p className="m-0 text-[13px] text-[#8a8178]">
						Public repositories will appear here.
					</p>
				) : null}
				{activity.repositories.map((repository) => (
					<RepositoryRow
						key={repository.id}
						handle={repository.namespaceHandle}
						repository={repository}
					/>
				))}
				{memberOnlyRepositories.map((repository) => (
					<RepositoryRow
						key={repository.id}
						handle={profileHandle}
						repository={repository}
						isPrivate={repository.visibility === "private"}
					/>
				))}
			</div>
		</>
	);
}

function profileFileSummary(activity: PublicProfileActivity): string {
	const repositoryCount = activity.repositories.length;
	const repositoryLabel =
		repositoryCount === 1 ? "public repository" : "public repositories";
	if (repositoryCount > 0 && activity.failedRepositories === repositoryCount) {
		return `Checking files across ${repositoryCount} ${repositoryLabel}`;
	}
	return `across ${repositoryCount} ${repositoryLabel}`;
}

function ProfileActivityStatus({ children }: { children: React.ReactNode }) {
	return (
		<div>
			<h2 id="profile-files-title" className="m-0 text-[15px] font-bold">
				Statistics
			</h2>
			<p className="m-0 mt-3 text-[13px] text-[#8a8178]">{children}</p>
		</div>
	);
}

/** The subset of the repository provider's shape the profile page renders. */
interface MemberRepository {
	id: string;
	slug: string;
	visibility: "private" | "public";
}

function RepositoryRow({
	handle,
	repository,
	isPrivate,
}: {
	handle: string;
	repository: Pick<ProfileRepositoryActivity, "slug">;
	isPrivate?: boolean;
}) {
	return (
		<Link
			to="/@{$namespace}/$repository"
			params={{ namespace: handle, repository: repository.slug }}
			search={{}}
			className="group -mx-3 flex items-center gap-5 rounded-lg border-t border-[#eae2d6] px-3 py-3.5 no-underline transition hover:bg-[#f6efe4]"
		>
			<strong className="min-w-0 flex-1 truncate text-[14.5px] font-semibold tracking-[-0.01em] text-[#1c1917] group-hover:text-[#c2410c]">
				{repository.slug}
			</strong>
			{isPrivate ? (
				<span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[#eae2d6] px-2 py-0.5 text-[11px] font-semibold text-[#8a8178]">
					<Lock className="size-3" aria-hidden="true" />
					Private
				</span>
			) : null}
			<ArrowRight
				className="ml-auto size-3.5 shrink-0 text-[#c9c2b8] transition-transform group-hover:translate-x-0.5 group-hover:text-[#c2410c]"
				aria-hidden="true"
			/>
		</Link>
	);
}

function joinedMonth(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.valueOf())
		? "recently"
		: new Intl.DateTimeFormat("en", { month: "long", year: "numeric" }).format(
				date,
			);
}

function ProfileStatus({ children }: { children: React.ReactNode }) {
	return (
		<main className="grid min-h-[calc(100dvh-44px)] place-items-center px-6 text-center text-sm text-[#766d65]">
			{children}
		</main>
	);
}
