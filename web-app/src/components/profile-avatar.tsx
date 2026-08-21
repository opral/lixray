import { useEffect, useState } from "react";
import { jsContactAvatarUri } from "~/lib/jscontact-profile";
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
		setAvatarUri(null);
		if (!namespaceId) return;
		const controller = new AbortController();
		void fetch(`/profile/${encodeURIComponent(namespaceId)}`, {
			headers: { Accept: "application/jscontact+json; version=2.0" },
			signal: controller.signal,
		})
			.then(async (response) => (response.ok ? response.json() : null))
			.then((document: unknown) => {
				if (!controller.signal.aborted) {
					setAvatarUri(jsContactAvatarUri(document));
				}
			})
			.catch(() => undefined);
		return () => controller.abort();
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
