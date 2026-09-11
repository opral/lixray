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

/** Samples coalesce per frame and, while a page keeps changing, per interval. */
const SYNC_INTERVAL_MS = 100;
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
	// Tailwind v4 palettes are oklch, and Chrome keeps them so in computed
	// styles rather than serializing to rgb().
	const oklch = /^oklch\((.+)\)$/.exec(text);
	if (oklch) {
		const parts = oklch[1]!.replace("/", " ").split(/\s+/).filter(Boolean);
		if (parts.length < 3) return null;
		const lightness = parts[0]!.endsWith("%")
			? Number.parseFloat(parts[0]!) / 100
			: Number.parseFloat(parts[0]!);
		const chroma = parts[1]!.endsWith("%")
			? Number.parseFloat(parts[1]!) * 0.004
			: Number.parseFloat(parts[1]!);
		const hue = parts[2] === "none" ? 0 : Number.parseFloat(parts[2]!);
		if (![lightness, chroma, hue].every(Number.isFinite)) return null;
		return {
			...oklchToSrgb(lightness, chroma, hue),
			a: clamp01(alpha(parts[3])),
		};
	}
	return null;
}

/** OKLCH to gamma-encoded sRGB channels in 0..255 (Björn Ottosson's matrices). */
function oklchToSrgb(
	lightness: number,
	chroma: number,
	hueDegrees: number,
): { r: number; g: number; b: number } {
	const hue = (hueDegrees * Math.PI) / 180;
	const a = chroma * Math.cos(hue);
	const b = chroma * Math.sin(hue);
	const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
	const gamma = (linear: number) => {
		const value = clamp01(linear);
		return (
			(value <= 0.0031308
				? 12.92 * value
				: 1.055 * value ** (1 / 2.4) - 0.055) * 255
		);
	};
	return {
		r: gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
		g: gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
		b: gamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
	};
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

	// A burst of changes (a mount, a transition settling) becomes one sample
	// per frame, and a page that keeps changing is sampled once per interval.
	let frame: number | null = null;
	let timer: number | null = null;
	let lastSync = Number.NEGATIVE_INFINITY;
	const run = () => {
		frame = null;
		lastSync = win.performance.now();
		sync();
	};
	const request = () => {
		if (frame !== null || timer !== null) return;
		const wait = SYNC_INTERVAL_MS - (win.performance.now() - lastSync);
		if (wait > 0) {
			timer = win.setTimeout(() => {
				timer = null;
				frame = win.requestAnimationFrame(run);
			}, wait);
			return;
		}
		frame = win.requestAnimationFrame(run);
	};

	// Anything that changes what is painted: DOM changes and the attributes
	// that style elements (dialogs mount, data-state flips, review mode
	// toggles), the end of transitions and animations (fades settle),
	// resizes, and the overlay's own geometry. Text edits and the many
	// attributes that do not paint are left alone.
	const observer = new MutationObserver(request);
	observer.observe(doc.documentElement, {
		subtree: true,
		childList: true,
		attributes: true,
		attributeFilter: [
			"class",
			"style",
			"hidden",
			"open",
			"aria-hidden",
			"data-state",
			"data-theme",
			"data-review-mode",
		],
	});
	const events = ["transitionend", "animationend"] as const;
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
		if (timer !== null) win.clearTimeout(timer);
		meta.content = original;
	};
}
