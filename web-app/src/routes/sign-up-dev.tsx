import { createFileRoute } from "@tanstack/react-router";
import { LogIn } from "lucide-react";
import { useEffect, useState } from "react";
import { useAuth } from "~/components/auth-provider";
import { Button } from "~/components/ui/button";
import { normalizeAuthReturnTo } from "~/lib/auth-return-to";

interface SignUpDevSearch {
	returnTo?: string;
}

type DevAccountStatus = "loading" | "enabled" | "disabled";

export const Route = createFileRoute("/sign-up-dev")({
	validateSearch: (search: Record<string, unknown>): SignUpDevSearch =>
		typeof search.returnTo === "string" ? { returnTo: search.returnTo } : {},
	component: SignUpDevPage,
});

function SignUpDevPage() {
	const { isLoaded, signInAsProdDev, user } = useAuth();
	const search = Route.useSearch();
	const returnTo = normalizeAuthReturnTo(search.returnTo ?? "/open");
	const [accountEmail, setAccountEmail] = useState<string | null>(null);
	const [status, setStatus] = useState<DevAccountStatus>("loading");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);

	useEffect(() => {
		let disposed = false;
		void fetch("/auth/email", {
			headers: { Accept: "application/json" },
		})
			.then(async (response) => {
				if (!response.ok) {
					if (!disposed) setStatus("disabled");
					return;
				}
				const body: unknown = await response.json();
				if (
					!disposed &&
					body &&
					typeof body === "object" &&
					"enabled" in body &&
					body.enabled === true &&
					"email" in body &&
					typeof body.email === "string"
				) {
					setAccountEmail(body.email);
					setStatus("enabled");
				} else if (!disposed) {
					setStatus("disabled");
				}
			})
			.catch(() => {
				if (!disposed) setStatus("disabled");
			});
		return () => {
			disposed = true;
		};
	}, []);

	const signIn = async () => {
		setSubmitting(true);
		setError(null);
		try {
			await signInAsProdDev(password);
			window.location.replace(returnTo);
		} catch (signInError) {
			setError(
				signInError instanceof Error ? signInError.message : "Sign-in failed",
			);
			setSubmitting(false);
		}
	};

	const isEnabled = status === "enabled" && accountEmail !== null;

	return (
		<main className="grid min-h-screen place-items-center bg-bg px-5 py-8 text-fg">
			<div className="grid w-full max-w-[400px] justify-items-center gap-[22px] rounded-[14px] border border-border bg-panel px-7 py-9 shadow-[0_18px_50px_color-mix(in_srgb,var(--at-overlay)_10%,transparent),0_2px_8px_color-mix(in_srgb,var(--at-overlay)_5%,transparent)]">
				<a
					href="/"
					className="inline-flex items-center gap-2 text-[15px] font-[750] no-underline"
					aria-label="LixRay home"
				>
					<img src="/lixray-mark.svg" alt="" className="size-6" />
					<span>LixRay</span>
				</a>
				<div className="grid gap-[7px] text-center">
					<h1 className="m-0 text-[20px] font-bold leading-tight">
						Developer sign in
					</h1>
					<p className="m-0 text-[13.5px] leading-normal text-fg-faint">
						{isEnabled
							? `Use the dedicated production developer account (${accountEmail}).`
							: status === "loading"
								? "Checking developer sign-in availability..."
								: "This developer sign-in route is only available in production."}
					</p>
				</div>
				{isEnabled && user ? (
					<Button
						asChild
						variant="featured"
						className="h-auto w-full rounded-[10px] py-3 text-sm font-bold"
					>
						<a href={returnTo}>Continue to LixRay</a>
					</Button>
				) : isEnabled ? (
					<>
						<label className="grid w-full gap-1.5 text-left text-[12.5px] font-semibold text-fg-muted">
							<span>Password</span>
							<input
								type="password"
								autoComplete="current-password"
								value={password}
								onChange={(event) => setPassword(event.target.value)}
								disabled={!isLoaded || submitting}
								className="h-10 w-full rounded-[9px] border border-border bg-bg px-3 text-sm font-normal text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
							/>
						</label>
						<Button
							type="button"
							variant="featured"
							className="h-auto w-full gap-2.5 rounded-[10px] py-3 text-sm font-bold"
							disabled={!isLoaded || submitting || password.length === 0}
							onClick={() => void signIn()}
						>
							<LogIn aria-hidden="true" />
							{submitting ? "Signing in..." : "Sign in as developer"}
						</Button>
					</>
				) : null}
				{error ? (
					<p className="whitespace-pre-wrap rounded-lg border border-danger-subtle bg-danger-subtle px-3.5 py-3 text-sm text-diff-removed">
						{error}
					</p>
				) : null}
				<a
					href="/sign-in"
					className="text-[13px] font-semibold text-fg-muted underline underline-offset-2"
				>
					Back to standard sign in
				</a>
			</div>
		</main>
	);
}
