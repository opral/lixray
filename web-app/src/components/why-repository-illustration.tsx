import { CircleCheck } from "lucide-react";

const markers = [
	{ x: 52, icon: "icon-sq-csv" },
	{ x: 120, icon: "icon-sq-docx" },
	{ x: 188, icon: "icon-sq-pdf" },
	{ x: 548, icon: "icon-sq-xlsx" },
	{ x: 674, icon: "icon-sq-md" },
] as const;

export function WhyRepositoryIllustration() {
	return (
		<figure
			className="relative m-0 h-[160px] w-full"
			role="img"
			aria-label="Claude proposes changes to a repository, checks pass, and the changes are accepted into its history"
		>
			<svg
				className="absolute inset-0 h-full w-full"
				viewBox="0 0 736 160"
				preserveAspectRatio="xMidYMid meet"
				aria-hidden="true"
			>
				<path
					d="M0 116 H736"
					fill="none"
					stroke="var(--atelier-fg)"
					strokeWidth="1.7"
				/>
				<path
					d="M188 116 C218 116 216 44 248 44 H488 C520 44 518 116 548 116"
					fill="none"
					stroke="var(--atelier-link)"
					strokeWidth="2"
				/>
				{markers.map(({ x, icon }) => (
					<g key={x}>
						<circle
							cx={x}
							cy="116"
							r="17"
							fill="var(--atelier-panel)"
							stroke="var(--atelier-border)"
						/>
						<image
							href={"/landing/" + icon + ".svg"}
							x={x - 7}
							y="109"
							width="14"
							height="14"
						/>
					</g>
				))}
				<rect
					x="313"
					y="30"
					width="58"
					height="28"
					rx="14"
					fill="var(--atelier-panel)"
					stroke="var(--atelier-border)"
				/>
				<image
					href="/landing/icon-sq-xlsx.svg"
					x="323"
					y="37"
					width="14"
					height="14"
				/>
				<image
					href="/landing/icon-sq-csv.svg"
					x="344"
					y="37"
					width="14"
					height="14"
				/>
			</svg>
			<span className="absolute top-0 left-[29%] inline-flex items-center gap-1.5 rounded-full border border-border bg-panel px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap shadow-sm sm:text-[12px]">
				<img className="size-3" src="/landing/claude-spark.svg" alt="" />
				Claude proposes changes
			</span>
			<span className="absolute top-9 left-[50%] inline-flex items-center gap-1 rounded-full bg-success-subtle px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap text-success sm:left-[51%] sm:text-[12px]">
				<CircleCheck className="size-3" strokeWidth={2} aria-hidden="true" />
				Checks passed
			</span>
			<span className="absolute right-[21%] bottom-0 text-[12px] font-semibold">
				Accepted
			</span>
		</figure>
	);
}
