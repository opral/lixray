import {
	CircleCheckIcon,
	InfoIcon,
	Loader2Icon,
	OctagonXIcon,
	TriangleAlertIcon,
} from "lucide-react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * Toasts render as dark, bottom-centered capsules — the same recipe as the
 * tooltip tokens — so confirmations like “You joined …” read as quiet system
 * feedback instead of panel chrome.
 */
const Toaster = ({ ...props }: ToasterProps) => {
	return (
		<Sonner
			theme="light"
			position="bottom-center"
			className="toaster group"
			icons={{
				success: <CircleCheckIcon className="size-4 text-success" />,
				info: <InfoIcon className="size-4" />,
				warning: <TriangleAlertIcon className="size-4 text-warning" />,
				error: <OctagonXIcon className="size-4 text-danger" />,
				loading: <Loader2Icon className="size-4 animate-spin" />,
			}}
			toastOptions={{
				style: { width: "fit-content", marginInline: "auto" },
			}}
			style={
				{
					"--normal-bg": "var(--at-overlay)",
					"--normal-text": "var(--at-overlay-fg)",
					"--normal-border": "transparent",
					"--border-radius": "10px",
				} as React.CSSProperties
			}
			{...props}
		/>
	);
};

export { Toaster };
