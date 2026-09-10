/**
 * Keeps `<meta name="theme-color">` equal to what the page actually paints
 * behind the PWA window controls.
 *
 * In window-controls-overlay mode the page draws its own title bar, so a
 * dialog backdrop or a review tint covers it like any other pixel. Chrome
 * still paints the small controls region from theme-color, which used to be
 * updated by hand per feature and drifted every time a new overlay shipped.
 * Instead, this samples the element stack under the controls and composites
 * their backgrounds, so any surface that paints there is matched without
 * knowing about it. Effects that are not backgrounds (the review glow is an
 * inset box-shadow) are declared once in `TINTS` and composited in place.
 */

export type Rgba = {
	readonly r: number;
	readonly g: number;
	readonly b: number;
	readonly a: number;
};

/** One painted layer, topmost first. */
export type PaintLayer = {
	readonly color: Rgba | null;
	/** Computed `opacity`; scales the layer. */
	readonly opacity: number;
	/** A non-background effect painted just above this layer's background. */
	readonly tint?: Rgba | null;
};

/** Non-background effects, keyed by the element that paints them. */
export const TINTS: ReadonlyArray<{
	readonly selector: string;
	readonly color: string;
}> = [
	// The review glow: the top inset shadow over the shell, at the corner.
	{ selector: '[data-review-mode="true"]', color: "rgba(249, 115, 22, 0.24)" },
];

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const channel = (value: string): number => {
	const trimmed = value.trim();
	if (trimmed.endsWith("%")) return (Number.parseFloat(trimmed) / 100) * 255;
	return Number.parseFloat(trimmed);
};
const alpha = (value: string | undefined): number => {
	if (value === undefined) return 1;
	const trimmed = value.trim();
	if (trimmed.endsWith("%")) return Number.parseFloat(trimmed) / 100;
	return Number.parseFloat(trimmed);
};

/**
 * Parses the colour forms a computed style can carry: `rgb()`/`rgba()` in
 * comma or space syntax, `color(srgb …)`, hex, and `transparent`. Returns
 * null for anything else (lab, oklch, …) so the caller can skip the layer.
 */
export function parseCssColor(value: string): Rgba | null {
	const text = value.trim().toLowerCase();
	if (text === "" || text === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
	const hex = /^#([0-9a-f]{3,8})$/.exec(text);
	if (hex) {
		const digits = hex[1]!;
		const expand = (index: number) =>
			digits.length <= 4
				? Number.parseInt(digits[index]! + digits[index]!, 16)
				: Number.parseInt(digits.slice(index * 2, index * 2 + 2), 16);
		const hasAlpha = digits.length === 4 || digits.length === 8;
		return {
			r: expand(0),
			g: expand(1),
			b: expand(2),
			a: hasAlpha ? expand(3) / 255 : 1,
		};
	}
	const rgb = /^rgba?\((.+)\)$/.exec(text);
	if (rgb) {
		const parts = rgb[1]!.includes(",")
			? rgb[1]!.split(",")
			: rgb[1]!.replace("/", " ").split(/\s+/).filter(Boolean);
		if (parts.length < 3) return null;
		return {
			r: channel(parts[0]!),
			g: channel(parts[1]!),
			b: channel(parts[2]!),
			a: clamp01(alpha(parts[3])),
		};
	}
	const srgb = /^color\(srgb\s+(.+)\)$/.exec(text);
	if (srgb) {
		const parts = srgb[1]!.replace("/", " ").split(/\s+/).filter(Boolean);
		if (parts.length < 3) return null;
		return {
			r: Number.parseFloat(parts[0]!) * 255,
			g: Number.parseFloat(parts[1]!) * 255,
			b: Number.parseFloat(parts[2]!) * 255,
			a: clamp01(alpha(parts[3])),
		};
	}
	return null;
}

const toHex = (value: number) =>
	Math.round(Math.min(255, Math.max(0, value)))
		.toString(16)
		.padStart(2, "0");

export function formatHexColor({ r, g, b }: Rgba): string {
	return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Composites layers top to bottom with the "over" operator and finishes on
 * `fallback`, which stands in for whatever is below the sampled stack.
 */
export function compositeLayers(
	layers: readonly PaintLayer[],
	fallback: Rgba,
): Rgba {
	// Accumulate premultiplied colour and coverage from the top down.
	let r = 0;
	let g = 0;
	let b = 0;
	let coverage = 0;
	const over = (color: Rgba | null | undefined, opacity: number) => {
		if (!color) return;
		const a = clamp01(color.a * opacity);
		if (a <= 0) return;
		const weight = (1 - coverage) * a;
		r += color.r * weight;
		g += color.g * weight;
		b += color.b * weight;
		coverage += weight;
	};
	for (const layer of layers) {
		if (coverage >= 0.995) break;
		over(layer.tint, layer.opacity);
		over(layer.color, layer.opacity);
	}
	over(fallback, 1);
	return { r, g, b, a: 1 };
}

type ElementLike = {
	matches?: (selector: string) => boolean;
};

/**
 * Builds the paint stack for the elements under a point (topmost first)
 * from their computed styles. Hidden elements paint nothing.
 */
export function layersFromElements<T extends ElementLike>(
	elements: readonly T[],
	styleOf: (element: T) => {
		readonly backgroundColor: string;
		readonly opacity: string;
		readonly visibility: string;
	},
	tints: typeof TINTS = TINTS,
): PaintLayer[] {
	const layers: PaintLayer[] = [];
	for (const element of elements) {
		const style = styleOf(element);
		if (style.visibility === "hidden" || style.visibility === "collapse")
			continue;
		const tint = tints.find((entry) => element.matches?.(entry.selector));
		layers.push({
			color: parseCssColor(style.backgroundColor),
			opacity: clamp01(Number.parseFloat(style.opacity) || 0),
			...(tint ? { tint: parseCssColor(tint.color) } : {}),
		});
	}
	return layers;
}

type OverlayNavigator = Navigator & {
	windowControlsOverlay?: {
		visible: boolean;
		getTitlebarAreaRect(): DOMRect;
		addEventListener(type: "geometrychange", listener: () => void): void;
		removeEventListener(type: "geometrychange", listener: () => void): void;
	};
};

/** Where to sample: just inside the title bar next to the window controls. */
export function samplePoint(win: Window): { x: number; y: number } {
	const overlay = (win.navigator as OverlayNavigator).windowControlsOverlay;
	if (overlay?.visible) {
		const rect = overlay.getTitlebarAreaRect();
		if (rect.width > 0 && rect.height > 0) {
			return {
				x: Math.max(0, Math.min(win.innerWidth - 1, rect.x + rect.width - 2)),
				y: Math.max(0, rect.y + rect.height / 2),
			};
		}
	}
	return { x: Math.floor(win.innerWidth / 2), y: 1 };
}

/** Installs the sync on `document`; returns a disposer that restores the meta. */
export function installThemeColorSync(win: Window = window): () => void {
	const doc = win.document;
	let meta = doc.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
	if (!meta) {
		meta = doc.createElement("meta");
		meta.name = "theme-color";
		doc.head.append(meta);
	}
	const original = meta.content;
	const fallback = parseCssColor(original) ?? { r: 244, g: 242, b: 239, a: 1 };

	const sync = () => {
		const { x, y } = samplePoint(win);
		const elements = doc.elementsFromPoint(x, y);
		const layers = layersFromElements(elements, (element) =>
			win.getComputedStyle(element),
		);
		const next = formatHexColor(compositeLayers(layers, fallback));
		// Comparing first keeps our own write from re-triggering the observer.
		if (meta.content !== next) meta.content = next;
	};

	let frame: number | null = null;
	const request = () => {
		if (frame !== null) return;
		frame = win.requestAnimationFrame(() => {
			frame = null;
			sync();
		});
	};

	// Anything that changes what is painted: DOM and attribute changes
	// (dialogs mount, data-state flips, review mode toggles), the end of
	// transitions and animations (fades settle), looping glows, resizes, and
	// the overlay's own geometry.
	const observer = new MutationObserver(request);
	observer.observe(doc.documentElement, {
		subtree: true,
		childList: true,
		attributes: true,
	});
	const events = [
		"transitionend",
		"animationend",
		"animationiteration",
	] as const;
	for (const type of events)
		doc.addEventListener(type, request, { capture: true, passive: true });
	win.addEventListener("resize", request, { passive: true });
	const overlay = (win.navigator as OverlayNavigator).windowControlsOverlay;
	overlay?.addEventListener("geometrychange", request);
	request();

	return () => {
		observer.disconnect();
		for (const type of events)
			doc.removeEventListener(type, request, { capture: true });
		win.removeEventListener("resize", request);
		overlay?.removeEventListener("geometrychange", request);
		if (frame !== null) win.cancelAnimationFrame(frame);
		meta.content = original;
	};
}
