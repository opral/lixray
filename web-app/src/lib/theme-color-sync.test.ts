import assert from "node:assert/strict";
import test from "node:test";
import {
	TINTS,
	compositeLayers,
	formatHexColor,
	layersFromElements,
	parseCssColor,
} from "./theme-color-sync.ts";

const APP_BG = { r: 244, g: 242, b: 239, a: 1 };

void test("parses the colour forms a computed style can carry", () => {
	assert.deepEqual(parseCssColor("rgb(244, 242, 239)"), APP_BG);
	assert.deepEqual(parseCssColor("rgba(12, 10, 9, 0.38)"), {
		r: 12,
		g: 10,
		b: 9,
		a: 0.38,
	});
	assert.deepEqual(parseCssColor("rgb(12 10 9 / 38%)"), {
		r: 12,
		g: 10,
		b: 9,
		a: 0.38,
	});
	const srgb = parseCssColor("color(srgb 0.047 0.039 0.035 / 0.38)");
	assert.ok(srgb);
	assert.equal(Math.round(srgb.r), 12);
	assert.equal(srgb.a, 0.38);
	const white = parseCssColor("oklch(1 0 0)");
	assert.ok(white);
	assert.deepEqual(
		[white.r, white.g, white.b].map(Math.round),
		[255, 255, 255],
	);
	const black = parseCssColor("oklch(0% 0 none / 50%)");
	assert.ok(black);
	assert.deepEqual([black.r, black.g, black.b].map(Math.round), [0, 0, 0]);
	assert.equal(black.a, 0.5);
	// Tailwind's red-500.
	const red = parseCssColor("oklch(0.637 0.237 25.331)");
	assert.ok(red);
	assert.deepEqual([red.r, red.g, red.b].map(Math.round), [251, 44, 54]);
	assert.deepEqual(parseCssColor("#f4f2ef"), APP_BG);
	assert.deepEqual(parseCssColor("#0008"), { r: 0, g: 0, b: 0, a: 136 / 255 });
	assert.deepEqual(parseCssColor("transparent"), { r: 0, g: 0, b: 0, a: 0 });
	assert.equal(parseCssColor("lab(50% 40 30)"), null);
});

void test("a dialog backdrop over the app ground yields the dimmed grey", () => {
	// Chrome computes the 38% neutral-950 backdrop as color(srgb …).
	const backdrop = parseCssColor("color(srgb 0.047 0.039 0.035 / 0.38)");
	const result = compositeLayers(
		[
			{ color: backdrop, opacity: 1 },
			{ color: APP_BG, opacity: 1 },
		],
		APP_BG,
	);
	assert.equal(formatHexColor(result), "#9c9a98");
});

void test("an opaque layer hides everything below it", () => {
	const result = compositeLayers(
		[
			{ color: parseCssColor("transparent"), opacity: 1 },
			{ color: { r: 255, g: 255, b: 255, a: 1 }, opacity: 1 },
			{ color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1 },
		],
		APP_BG,
	);
	assert.equal(formatHexColor(result), "#ffffff");
});

void test("opacity scales a layer and the fallback fills the rest", () => {
	const result = compositeLayers(
		[{ color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 0.5 }],
		{ r: 200, g: 200, b: 200, a: 1 },
	);
	assert.equal(formatHexColor(result), "#646464");
});

void test("the review glow is declared once and composited in place", () => {
	const layers = layersFromElements(
		[
			{
				id: "shell",
				matches: (selector: string) => selector === '[data-review-mode="true"]',
			},
			{ id: "html", matches: () => false },
		],
		(element) =>
			element.id === "shell"
				? {
						backgroundColor: "rgb(244, 242, 239)",
						opacity: "1",
						visibility: "visible",
					}
				: {
						backgroundColor: "rgba(0, 0, 0, 0)",
						opacity: "1",
						visibility: "visible",
					},
	);
	assert.equal(layers.length, 2);
	assert.ok(layers[0]?.tint);
	const result = formatHexColor(compositeLayers(layers, APP_BG));
	// The accent glow over the app ground.
	assert.equal(result, "#e8c8b9");
	assert.equal(TINTS.length, 1);
});

void test("a backdrop above the review shell dims the glow too", () => {
	const backdrop = parseCssColor("rgba(12, 10, 9, 0.38)");
	const glow = parseCssColor(TINTS[0]!.color);
	const result = compositeLayers(
		[
			{ color: backdrop, opacity: 1 },
			{ color: APP_BG, opacity: 1, tint: glow },
		],
		APP_BG,
	);
	assert.equal(formatHexColor(result), "#948076");
});

void test("hidden elements paint nothing", () => {
	const layers = layersFromElements([{ matches: () => false }], () => ({
		backgroundColor: "rgb(0, 0, 0)",
		opacity: "1",
		visibility: "hidden",
	}));
	assert.deepEqual(layers, []);
});
