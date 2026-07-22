import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "~/lib/utils";

const buttonVariants = cva(
	"inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
	{
		variants: {
			variant: {
				default:
					"bg-bg-action-primary text-text-on-action-primary hover:bg-bg-action-primary-hover",
				featured:
					"bg-[linear-gradient(180deg,var(--color-bg-action-primary-start)_0%,var(--color-bg-action-primary-end)_100%)] text-text-on-action-primary shadow-[var(--shadow-action-primary)] hover:brightness-105 active:translate-y-px",
				destructive:
					"bg-error-700 text-text-on-action-primary hover:bg-error-800 focus-visible:ring-error-700/20 dark:focus-visible:ring-error-700/40",
				outline:
					"border border-border-action-secondary bg-bg-panel font-semibold text-text-secondary shadow-action-secondary hover:bg-bg-hover hover:text-text-primary dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
				secondary:
					"bg-bg-action-secondary text-text-on-action-secondary hover:bg-bg-action-secondary-hover",
				ghost:
					"hover:bg-bg-hover hover:text-text-primary dark:hover:bg-bg-hover/50",
				link: "text-text-link underline-offset-4 hover:text-text-link-hover hover:underline",
			},
			size: {
				default: "h-9 px-4 py-2 has-[>svg]:px-3",
				xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
				sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
				lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
				icon: "size-9",
				"icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
				"icon-sm": "size-8",
				"icon-lg": "size-10",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

function Button({
	className,
	variant = "default",
	size = "default",
	asChild = false,
	...props
}: React.ComponentProps<"button"> &
	VariantProps<typeof buttonVariants> & {
		asChild?: boolean;
	}) {
	const Comp = asChild ? Slot.Root : "button";

	return (
		<Comp
			data-slot="button"
			data-variant={variant}
			data-size={size}
			className={cn(buttonVariants({ variant, size, className }))}
			{...props}
		/>
	);
}

export { Button };
