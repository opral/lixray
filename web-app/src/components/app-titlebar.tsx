import type { ComponentPropsWithRef } from "react";
import { cn } from "~/lib/utils";

type AppTitlebarProps = ComponentPropsWithRef<"header"> & {
	readonly contentClassName?: string;
};

/**
 * LixRay's single page-level header surface.
 *
 * The inner content rail is kept separate so installed PWAs can reserve the
 * browser-owned window-control areas without changing the header semantics.
 */
export function AppTitlebar({
	children,
	className,
	contentClassName,
	...props
}: AppTitlebarProps) {
	return (
		<header
			{...props}
			className={cn(
				"flex h-11 shrink-0 items-center border-b border-border-subtle bg-bg-app text-text-primary",
				className,
			)}
			data-app-titlebar
		>
			<div
				className={cn(
					"relative flex h-full min-w-0 flex-1 items-center gap-2.5 px-[18px] max-[560px]:px-3",
					contentClassName,
				)}
				data-app-titlebar-content
			>
				{children}
			</div>
		</header>
	);
}

export function AppTitlebarTitle({
	className,
	...props
}: ComponentPropsWithRef<"span">) {
	return (
		<span
			{...props}
			className={cn(
				"pointer-events-none absolute inset-x-24 min-w-0 truncate text-center text-[12.5px] font-semibold text-text-primary",
				className,
			)}
			data-app-titlebar-title
		/>
	);
}

export function AppTitlebarBrand({
	className,
	...props
}: Omit<ComponentPropsWithRef<"a">, "children" | "href">) {
	return (
		<a
			{...props}
			aria-label={props["aria-label"] ?? "LixRay home"}
			className={cn(
				"inline-flex shrink-0 items-center gap-2 text-sm font-bold tracking-[-0.01em] text-text-primary no-underline",
				className,
			)}
			href="/home"
		>
			<img className="size-[19px]" src="/lixray-mark.svg" alt="" />
			<span data-app-titlebar-brand-label>LixRay</span>
		</a>
	);
}
