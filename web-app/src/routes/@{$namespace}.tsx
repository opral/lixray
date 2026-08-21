import {
	createFileRoute,
	Link,
	Outlet,
	useRouterState,
} from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";
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
		<div className="min-h-dvh bg-[#fbf6f0] font-sans text-[#1c1917]">
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
		<header className="flex min-h-[60px] items-center border-b border-[#1c1917]/[0.06] px-9 py-[18px] max-[760px]:px-5 max-[760px]:py-3.5">
			<Link
				to="/"
				className="inline-flex items-center gap-2 text-[17px] font-bold tracking-[-0.01em] no-underline"
				aria-label="LixRay home"
			>
				<img className="size-6" src="/lixray-mark.svg" alt="" />
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

				<div className="h-px bg-[#eae2d6]" />
				<span className="text-[12px] text-[#b5afa6]">
					On LixRay since {joinedMonth(profile.joinedAt)}
				</span>
			</aside>

			<section
				className="flex min-w-0 flex-1 flex-col gap-10 pt-2 max-[760px]:pt-0"
				aria-labelledby="profile-files-title"
			>
				<div>
					<div className="flex items-baseline gap-2.5">
						<h2 id="profile-files-title" className="m-0 text-[15px] font-bold">
							Files
						</h2>
						<p className="m-0 text-[12.5px] text-[#a8a29e]">
							{activity.totalFiles} across {activity.repositories.length} public
							repositories
						</p>
					</div>

					<div className="mt-3.5 flex h-4 gap-[3px]">
						{activity.fileMix.map((segment) => (
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
						{activity.fileMix.map((segment) => (
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
				</div>

				<div>
					<div className="flex items-baseline gap-2.5 pb-3">
						<h2 className="m-0 text-[15px] font-bold">Repositories</h2>
						<p className="m-0 text-[12.5px] text-[#a8a29e]">
							{activity.repositories.length} public
						</p>
					</div>
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

function RepositoryRow({
	handle,
	repository,
}: {
	handle: string;
	repository: ProfileRepositoryActivity;
}) {
	return (
		<Link
			to="/@{$namespace}/$repository"
			params={{ namespace: handle, repository: repository.slug }}
			search={{}}
			className="group -mx-3 flex items-center gap-5 rounded-lg border-t border-[#eae2d6] px-3 py-3.5 no-underline transition hover:bg-[#f6efe4]"
		>
			<strong className="min-w-0 flex-1 truncate font-mono text-[14px] font-bold text-[#1c1917] group-hover:text-[#c2410c]">
				{repository.slug}
			</strong>
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
		<main className="grid min-h-[calc(100dvh-56px)] place-items-center px-6 text-center text-sm text-[#766d65]">
			{children}
		</main>
	);
}
