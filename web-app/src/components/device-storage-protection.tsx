import type { Lix } from "@lix-js/sdk";
import { useEffect, useRef, useState } from "react";
import {
	inspectDeviceStorage,
	type DeviceStorageState,
} from "../lib/repository-device-backup.ts";

/** Browser-managed storage is separate from native commit durability. */
export function DeviceStorageProtection({ lix }: { lix: Lix }) {
	const [state, setState] = useState<DeviceStorageState | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const generation = useRef(0);
	useEffect(() => {
		let active = true;
		const current = generation.current + 1;
		generation.current = current;
		setState(null);
		setBusy(false);
		setError(null);
		const inspect = () =>
			void inspectDeviceStorage()
				.then((value) => {
					if (active) setState(value);
				})
				.catch(() => undefined);
		inspect();
		const timer = window.setInterval(inspect, 60_000);
		window.addEventListener("focus", inspect);
		return () => {
			active = false;
			generation.current = current + 1;
			clearInterval(timer);
			window.removeEventListener("focus", inspect);
		};
	}, [lix]);
	if (!state || (state.persistent === true && !state.pressure)) return null;
	async function protect() {
		const current = generation.current;
		setBusy(true);
		setError(null);
		try {
			await navigator.storage.persist();
			const value = await inspectDeviceStorage();
			if (generation.current === current) setState(value);
		} catch {
			if (generation.current === current)
				setError("This browser could not enable persistent storage.");
		} finally {
			if (generation.current === current) setBusy(false);
		}
	}
	async function backup() {
		const current = generation.current;
		setBusy(true);
		setError(null);
		try {
			const blob = await new Response(lix.exportSnapshot()).blob();
			if (generation.current !== current) return;
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = "lix-device-backup.lixsnap";
			anchor.click();
			window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
		} catch {
			if (generation.current === current)
				setError(
					"The device backup could not be downloaded. Your saved copy remains on this device.",
				);
		} finally {
			if (generation.current === current) setBusy(false);
		}
	}
	return (
		<aside
			aria-label="Device storage protection"
			className="absolute bottom-4 right-4 z-50 max-w-sm rounded-lg border border-border-subtle bg-bg p-3 text-sm text-fg-muted shadow-lg"
		>
			<p>
				{state.pressure
					? "Device storage is nearly full. Download your device changes before freeing browser storage."
					: "Enable persistent storage to help protect offline changes from browser cleanup."}
			</p>
			<div className="mt-2 flex gap-3">
				{state.persistent !== true ? (
					<button type="button" disabled={busy} onClick={() => void protect()}>
						Protect offline changes
					</button>
				) : null}
				<button type="button" disabled={busy} onClick={() => void backup()}>
					Download device backup
				</button>
			</div>
			{error ? (
				<p role="alert" className="mt-2">
					{error}
				</p>
			) : null}
		</aside>
	);
}
