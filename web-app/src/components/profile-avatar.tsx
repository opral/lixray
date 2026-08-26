import { useEffect, useState } from "react";
import { isDemoModeEnabled } from "~/lib/demo-client";
import { jsContactAvatarUri } from "~/lib/jscontact-profile";
import {
	demoProfileDocumentWithOverride,
	PROFILE_UPDATED_EVENT,
} from "~/lib/profile-editor";
import { cn } from "~/lib/utils";

export function ProfileAvatar({
	namespaceId,
	fallback,
	className,
}: {
	namespaceId: string | null;
	fallback: string;
	className?: string;
}) {
	const [avatarUri, setAvatarUri] = useState<string | null>(null);

	useEffect(() => {
		let controller: AbortController | null = null;
		const load = () => {
			controller?.abort();
			setAvatarUri(null);
			if (!namespaceId) return;
			if (isDemoModeEnabled) {
				setAvatarUri(
					jsContactAvatarUri(
						demoProfileDocumentWithOverride(window.location.origin),
					),
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
				.then((document: unknown) => {
					if (!requestController.signal.aborted) {
						setAvatarUri(jsContactAvatarUri(document));
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

	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full",
				className,
			)}
		>
			{avatarUri ? (
				<img
					src={avatarUri}
					alt=""
					className="size-full object-cover"
					referrerPolicy="no-referrer"
					onError={() => setAvatarUri(null)}
				/>
			) : (
				fallback
			)}
		</span>
	);
}
