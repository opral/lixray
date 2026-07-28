import { LixrayApiError } from "./lixray-api";

export function formatCaughtError(caught: unknown): string {
	if (caught instanceof LixrayApiError) {
		return `${caught.status}: ${caught.message}`;
	}
	if (caught instanceof Error) {
		return caught.message;
	}
	if (
		typeof caught === "object" &&
		caught !== null &&
		"message" in caught &&
		typeof caught.message === "string"
	) {
		return caught.message;
	}
	return "Unexpected error";
}

const relativeTimeFormat = new Intl.RelativeTimeFormat("en", {
	numeric: "auto",
});

const RELATIVE_TIME_STEPS: Array<{
	unit: Intl.RelativeTimeFormatUnit;
	seconds: number;
}> = [
	{ unit: "year", seconds: 365 * 24 * 60 * 60 },
	{ unit: "month", seconds: 30 * 24 * 60 * 60 },
	{ unit: "week", seconds: 7 * 24 * 60 * 60 },
	{ unit: "day", seconds: 24 * 60 * 60 },
	{ unit: "hour", seconds: 60 * 60 },
	{ unit: "minute", seconds: 60 },
];

export function formatRelativeTime(iso: string): string {
	const timestamp = Date.parse(iso);
	if (Number.isNaN(timestamp)) {
		return iso;
	}
	const elapsedSeconds = (timestamp - Date.now()) / 1000;
	for (const { unit, seconds } of RELATIVE_TIME_STEPS) {
		if (Math.abs(elapsedSeconds) >= seconds) {
			return relativeTimeFormat.format(
				Math.round(elapsedSeconds / seconds),
				unit,
			);
		}
	}
	return "just now";
}
