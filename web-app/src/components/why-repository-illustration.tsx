import { Table2 } from "lucide-react";

type IllustrationItem = {
	name: string;
	icon?: string;
};

const todayGroups: { label: string; items: IllustrationItem[] }[] = [
	{ label: "Code host", items: [{ name: "crm-sync.py", icon: "icon-sq-py" }] },
	{
		label: "Cloud drive",
		items: [
			{ name: "handbook.md", icon: "icon-sq-md" },
			{ name: "launch-deck.pdf", icon: "icon-sq-pdf" },
		],
	},
	{
		label: "Database",
		items: [{ name: "orders" }, { name: "customers" }],
	},
];

const repositoryItems = todayGroups.flatMap((group) => group.items);

function ItemPill({ name, icon }: IllustrationItem) {
	return (
		<span className="inline-flex items-center gap-1.5 rounded-[7px] border border-fg/12 bg-panel px-2.5 py-1.5 text-[12.5px] leading-none whitespace-nowrap">
			{icon ? (
				<img
					className="size-3.5 shrink-0"
					src={`/landing/${icon}.svg`}
					alt=""
				/>
			) : (
				<Table2
					className="size-3.5 shrink-0 text-fg-subtle"
					strokeWidth={1.5}
					aria-hidden="true"
				/>
			)}
			{name}
		</span>
	);
}

export function WhyRepositoryIllustration() {
	return (
		<figure
			className="m-0 grid w-full grid-cols-1 items-start gap-3 py-2 sm:grid-cols-[minmax(0,1fr)_24px_minmax(0,1fr)]"
			role="img"
			aria-label="Today, code, documents, and tables sit in separate services. LixRay puts them in one repository where changes can be proposed for review."
		>
			<div className="flex min-w-0 flex-col gap-2.5">
				<span className="text-[11.5px] font-semibold tracking-[.04em] text-fg-faint uppercase">
					Today
				</span>
				{todayGroups.map((group) => (
					<div
						key={group.label}
						className="flex flex-col gap-2 rounded-[10px] border border-dashed border-fg/25 p-2.5"
					>
						<span className="text-xs text-fg-subtle">{group.label}</span>
						<div className="flex flex-wrap gap-1.5">
							{group.items.map((item) => (
								<ItemPill key={item.name} {...item} />
							))}
						</div>
					</div>
				))}
			</div>

			<span
				className="self-center text-center text-xl text-fg-faint max-sm:rotate-90"
				aria-hidden="true"
			>
				→
			</span>

			<div className="flex min-w-0 flex-col gap-2.5 self-stretch">
				<span className="text-[11.5px] font-semibold tracking-[.04em] text-fg-faint uppercase">
					LixRay
				</span>
				<div className="my-auto w-full overflow-hidden rounded-[10px] border border-fg/12 bg-panel">
					<div className="border-b border-fg/8 bg-bg-hover px-3 py-2 font-mono text-xs font-bold">
						@acme/repository
					</div>
					<div className="flex flex-wrap gap-1.5 p-3">
						{repositoryItems.map((item) => (
							<ItemPill key={item.name} {...item} />
						))}
					</div>
					<div className="border-t border-fg/8 px-3 pt-3.5 pb-2.5">
						<svg
							viewBox="0 0 240 56"
							className="block w-full overflow-visible"
							aria-hidden="true"
						>
							<path
								d="M4 14 H236"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.8"
							/>
							<path
								d="M80 14 C96 14 96 36 112 36 H144 C160 36 160 14 176 14"
								fill="none"
								stroke="var(--atelier-link)"
								strokeWidth="1.8"
							/>
							{[20, 50, 80, 212].map((x) => (
								<circle
									key={x}
									cx={x}
									cy="14"
									r="4"
									fill="white"
									stroke="currentColor"
									strokeWidth="1.8"
								/>
							))}
							<circle cx="128" cy="36" r="4.5" fill="var(--atelier-link)" />
							<circle cx="176" cy="14" r="7" fill="var(--atelier-success)" />
							<path
								d="M172.8 14 l2.3 2.3 l4.2 -4.6"
								fill="none"
								stroke="white"
								strokeWidth="1.6"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
							<text
								x="128"
								y="54"
								fontSize="10"
								fill="var(--atelier-fg-muted)"
								textAnchor="middle"
							>
								Proposed change
							</text>
							<text
								x="176"
								y="2"
								fontSize="10"
								fill="var(--atelier-success)"
								textAnchor="middle"
							>
								Reviewed
							</text>
						</svg>
					</div>
				</div>
			</div>
		</figure>
	);
}
