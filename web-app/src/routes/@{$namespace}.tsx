import {
	createFileRoute,
	Link,
	Outlet,
	useRouterState,
} from "@tanstack/react-router";
import {
	BriefcaseBusiness,
	Clock3,
	Code2,
	Download,
	FileArchive,
	FileText,
	Link2,
	MapPin,
	Presentation,
	Table2,
} from "lucide-react";
import { type ComponentType, useEffect, useState } from "react";
import { AccountMenu } from "~/components/account-menu";
import { useAuth } from "~/components/auth-provider";
import { Button } from "~/components/ui/button";
import {
	PLACEHOLDER_PROFILE_ACTIVITY,
	resolvePublicProfileByHandle,
	type ProfileRepositoryActivity,
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

	useEffect(() => {
		let disposed = false;
		setProfile(undefined);
		setError(null);
		void resolvePublicProfileByHandle(namespace)
			.then((nextProfile) => {
				if (!disposed) setProfile(nextProfile);
			})
			.catch((caught: unknown) => {
				if (disposed) return;
				setError(
					caught instanceof Error
						? caught.message
						: "Unable to load this profile.",
				);
				setProfile(null);
			});
		return () => {
			disposed = true;
		};
	}, [namespace]);

	return (
		<div className="min-h-dvh bg-[#fbf6f0] font-sans text-[#25211f]">
			<ProfileHeader authLoaded={authLoaded} signedIn={Boolean(user)} />
			{profile === undefined ? (
				<ProfileStatus>Loading profile…</ProfileStatus>
			) : profile === null ? (
				<ProfileStatus>
					{error ?? `The @${namespace} profile does not exist.`}
				</ProfileStatus>
			) : (
				<ProfileContent profile={profile} />
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
		<header className="flex h-14 items-center border-b border-[#25211f]/10 px-9 max-[760px]:px-5">
			<Link
				to="/"
				className="inline-flex items-center gap-2 text-[15px] font-bold tracking-[-0.01em] no-underline"
				aria-label="LixRay home"
			>
				<img className="size-5" src="/lixray-mark.svg" alt="" />
				LixRay
			</Link>
			<div className="ml-auto flex items-center gap-2.5">
				{signedIn ? (
					<>
						<Button
							asChild
							variant="outline"
							size="sm"
							className="h-8 bg-white/40"
						>
							<Link to="/home">Open LixRay</Link>
						</Button>
						<AccountMenu />
					</>
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
		</header>
	);
}

function ProfileContent({ profile }: { profile: PublicProfile }) {
	const activity = PLACEHOLDER_PROFILE_ACTIVITY;
	return (
		<main className="mx-auto flex w-full max-w-[1240px] gap-[72px] px-16 pt-14 pb-20 max-[900px]:gap-10 max-[760px]:flex-col max-[760px]:px-5 max-[760px]:pt-8">
			<aside className="w-[264px] shrink-0 max-[760px]:w-full">
				<div className="size-[108px] overflow-hidden rounded-full border border-[#25211f]/10 bg-[#eee4d8] text-[34px] font-bold max-[760px]:size-[68px]">
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
				<h1 className="mt-5 mb-0 text-[27px] leading-[1.18] font-bold tracking-[-0.025em] max-[760px]:text-[21px]">
					{profile.name}
				</h1>
				<p className="mt-1 font-mono text-[13px] text-[#766d65]">
					@{profile.handle}
				</p>
				{profile.bio ? (
					<p className="mt-5 text-[14px] leading-[1.55] text-[#4d4641]">
						{profile.bio}
					</p>
				) : null}

				<div className="my-6 h-px bg-[#25211f]/10" />
				<div className="grid gap-3 text-[13.5px] text-[#4d4641]">
					{profile.title || profile.organization ? (
						<ProfileFact icon={BriefcaseBusiness}>
							{[profile.title, profile.organization]
								.filter(Boolean)
								.join(" · ")}
						</ProfileFact>
					) : null}
					{profile.location ? (
						<ProfileFact icon={MapPin}>{profile.location}</ProfileFact>
					) : null}
					{profile.links.map((link) => (
						<ProfileFact icon={Link2} key={link.uri}>
							<a
								className="underline decoration-[#25211f]/25 underline-offset-4 hover:decoration-[#25211f]"
								href={link.uri}
								target="_blank"
								rel="noreferrer"
							>
								{link.label}
							</a>
						</ProfileFact>
					))}
				</div>

				<div className="my-6 h-px bg-[#25211f]/10" />
				<a
					href={profile.contactCardUri}
					download={`${profile.handle}.json`}
					className="inline-flex items-center gap-2 text-[13.5px] font-semibold underline decoration-[#25211f]/25 underline-offset-4 hover:decoration-[#25211f]"
				>
					<Download className="size-4" aria-hidden="true" />
					Contact card
				</a>
				<ProfileFact icon={Clock3} className="mt-4 text-[#766d65]">
					On LixRay since {joinedMonth(profile.joinedAt)}
				</ProfileFact>
			</aside>

			<section className="min-w-0 flex-1" aria-labelledby="profile-files-title">
				<div className="flex items-baseline gap-2.5 border-b border-[#25211f]/10 pb-5">
					<h2
						id="profile-files-title"
						className="m-0 text-[21px] font-bold tracking-[-0.02em]"
					>
						Files
					</h2>
					<p className="m-0 text-[13px] text-[#766d65]">
						{activity.totalFiles} across {activity.repositories.length} public
						repositories
					</p>
				</div>

				<div className="py-7">
					<div className="flex h-2.5 overflow-hidden rounded-full bg-[#e9dfd4]">
						{activity.fileMix.map((segment) => (
							<span
								key={segment.label}
								style={{
									width: `${segment.percentage}%`,
									background: segment.color,
								}}
							/>
						))}
					</div>
					<div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
						{activity.fileMix.map((segment) => (
							<span
								className="inline-flex items-center gap-1.5 text-[11.5px] text-[#766d65]"
								key={segment.label}
							>
								<i
									className="size-2 rounded-full"
									style={{ background: segment.color }}
								/>
								{segment.label} {segment.percentage}%
							</span>
						))}
					</div>
				</div>

				<div className="divide-y divide-[#25211f]/10 border-y border-[#25211f]/10">
					{activity.repositories.map((repository) => (
						<RepositoryRow
							key={repository.slug}
							handle={profile.handle}
							repository={repository}
						/>
					))}
				</div>
			</section>
		</main>
	);
}

function ProfileFact({
	children,
	className,
	icon: Icon,
}: {
	children: React.ReactNode;
	className?: string;
	icon: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;
}) {
	return (
		<div className={`flex items-start gap-2.5 ${className ?? ""}`}>
			<Icon
				className="mt-0.5 size-4 shrink-0 text-[#8b8178]"
				aria-hidden="true"
			/>
			<span className="min-w-0">{children}</span>
		</div>
	);
}

function RepositoryRow({
	handle,
	repository,
}: {
	handle: string;
	repository: ProfileRepositoryActivity;
}) {
	const Icon = repositoryIcon(repository.fileKind);
	return (
		<Link
			to="/@{$namespace}/$repository"
			params={{ namespace: handle, repository: repository.slug }}
			search={{}}
			className="group flex items-center gap-4 px-1 py-[18px] no-underline transition hover:bg-white/35 max-[540px]:items-start"
		>
			<span className="grid size-9 shrink-0 place-items-center rounded-[9px] border border-[#25211f]/10 bg-white/45">
				<Icon className="size-[17px] text-[#635b54]" aria-hidden="true" />
			</span>
			<span className="min-w-0 flex-1">
				<strong className="block truncate text-[14px] font-semibold group-hover:text-[#d6530b]">
					{repository.slug}
				</strong>
				<span className="mt-1 block truncate text-[12.5px] text-[#766d65]">
					{repository.description}
				</span>
			</span>
			<span className="ml-auto shrink-0 text-right text-[11.5px] leading-5 text-[#8b8178] max-[540px]:hidden">
				{repository.fileCount} files
				<br />
				{repository.updatedLabel}
			</span>
		</Link>
	);
}

function repositoryIcon(kind: ProfileRepositoryActivity["fileKind"]) {
	if (kind === "code") return Code2;
	if (kind === "sheets") return Table2;
	if (kind === "decks") return Presentation;
	if (kind === "other") return FileArchive;
	return FileText;
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
		<main className="grid min-h-[calc(100dvh-56px)] place-items-center px-6 text-center text-sm text-[#766d65]">
			{children}
		</main>
	);
}
