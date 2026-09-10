import { useEffect, useRef } from "react";

// Solid approximation of the animated review glow over the app background.
const REVIEW_THEME_COLOR = "#f4cdb3";

export function useReviewThemeColor() {
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const container = containerRef.current;
		const meta = document.querySelector<HTMLMetaElement>(
			'meta[name="theme-color"]',
		);
		if (!container || !meta) return;
		const originalColor = meta.content;
		const sync = () => {
			const color = container.querySelector('[data-review-mode="true"]')
				? REVIEW_THEME_COLOR
				: originalColor;
			if (meta.content !== color) meta.content = color;
		};
		// Observe the shell's actual review state, including automatic reviews
		// and shell replacement when switching repositories.
		const observer = new MutationObserver(sync);
		observer.observe(container, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: ["data-review-mode"],
		});
		sync();
		return () => {
			observer.disconnect();
			meta.content = originalColor;
		};
	}, []);

	return containerRef;
}
