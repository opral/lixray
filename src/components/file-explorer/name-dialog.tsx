import { useEffect, useId, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { formatCaughtError, validateEntryName } from "~/lib/format";

export interface NameDialogProps {
	open: boolean;
	title: string;
	description: string;
	initialValue: string;
	submitLabel: string;
	onSubmit: (name: string) => Promise<void>;
	onOpenChange: (open: boolean) => void;
}

export function NameDialog({
	open,
	title,
	description,
	initialValue,
	submitLabel,
	onSubmit,
	onOpenChange,
}: NameDialogProps) {
	const inputId = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	const [value, setValue] = useState(initialValue);
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);

	useEffect(() => {
		if (open) {
			setValue(initialValue);
			setError(null);
			setSubmitting(false);
		}
	}, [open, initialValue]);

	const handleSubmit = async (event: React.FormEvent) => {
		event.preventDefault();
		const name = value.trim();
		const validationError = validateEntryName(name);
		if (validationError) {
			setError(validationError);
			return;
		}
		setSubmitting(true);
		setError(null);
		try {
			await onSubmit(name);
			onOpenChange(false);
		} catch (caught) {
			setError(formatCaughtError(caught));
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
			<DialogContent className="sm:max-w-md">
				<form onSubmit={handleSubmit} className="grid gap-4">
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						<DialogDescription>{description}</DialogDescription>
					</DialogHeader>
					<div className="grid gap-2">
						<label htmlFor={inputId} className="text-sm font-medium">
							Name
						</label>
						<Input
							id={inputId}
							ref={inputRef}
							value={value}
							onChange={(event) => setValue(event.target.value)}
							autoFocus
							onFocus={(event) => event.target.select()}
							autoComplete="off"
							spellCheck={false}
							disabled={submitting}
						/>
						{error ? (
							<p role="alert" className="text-sm text-destructive">
								{error}
							</p>
						) : null}
					</div>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
							disabled={submitting}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={submitting || !value.trim()}>
							{submitting ? "Working…" : submitLabel}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
