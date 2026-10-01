const connections = [
	{ x: 150, label: "agents" },
	{ x: 368, label: "apps" },
	{ x: 586, label: "services" },
] as const;

const fileTypes = ["docx", "xlsx", "pdf", "png", "mp4"] as const;

const mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

function FileIcon({ x, y, type }: { x: number; y: number; type: string }) {
	return (
		<g>
			<path
				d={`M${x} ${y} H${x + 22} L${x + 30} ${y + 8} V${y + 38} H${x} Z M${x + 22} ${y} V${y + 8} H${x + 30}`}
				fill="var(--atelier-panel)"
				stroke="var(--atelier-fg)"
				strokeWidth="1.2"
				strokeLinejoin="round"
			/>
			<text
				x={x + 15}
				y={y + 29}
				fontSize="8.5"
				fontWeight="700"
				textAnchor="middle"
				fill="var(--atelier-fg)"
			>
				{type.toUpperCase()}
			</text>
		</g>
	);
}

function TableIcon({ x, y }: { x: number; y: number }) {
	return (
		<g>
			<rect
				x={x}
				y={y}
				width="40"
				height="32"
				rx="3"
				fill="var(--atelier-panel)"
				stroke="var(--atelier-fg)"
				strokeWidth="1.2"
			/>
			<rect
				x={x}
				y={y}
				width="40"
				height="9"
				rx="3"
				fill="var(--atelier-border)"
			/>
			<path
				d={`M${x} ${y + 9} H${x + 40} M${x} ${y + 20.5} H${x + 40} M${x + 13.3} ${y} V${y + 32} M${x + 26.6} ${y} V${y + 32}`}
				stroke="var(--atelier-fg)"
				strokeWidth="0.9"
			/>
		</g>
	);
}

export function SharedSourceIllustration() {
	return (
		<svg
			className="block h-auto w-full"
			viewBox="0 0 736 182"
			role="img"
			aria-label="AI agents, apps, and services connect to one repository that holds files and tables"
			style={{ fontFamily: mono }}
		>
			{connections.map(({ x, label }) => {
				const width = label.length * 7.3 + 28;
				return (
					<g key={label}>
						<rect
							x={x - width / 2}
							y="6"
							width={width}
							height="28"
							rx="4"
							fill="var(--atelier-panel)"
							stroke="var(--atelier-fg-subtle)"
						/>
						<text
							x={x}
							y="24.5"
							fontSize="12"
							textAnchor="middle"
							fill="var(--atelier-fg)"
						>
							{label}
						</text>
						<path
							d={`M${x} 34 V62 M${x - 4} 57 L${x} 63 L${x + 4} 57`}
							fill="none"
							stroke="var(--atelier-fg-subtle)"
						/>
					</g>
				);
			})}
			<rect
				x="1"
				y="66"
				width="734"
				height="110"
				rx="6"
				fill="var(--atelier-panel)"
				stroke="var(--atelier-fg)"
			/>
			<rect x="16" y="59" width="92" height="14" fill="var(--atelier-bg)" />
			<text x="22" y="70" fontSize="11" fill="var(--atelier-fg-subtle)">
				repository
			</text>
			<text
				x="40"
				y="98"
				fontSize="10.5"
				fontWeight="700"
				fill="var(--atelier-fg-subtle)"
			>
				FILES
			</text>
			{fileTypes.map((type, index) => (
				<FileIcon key={type} type={type} x={40 + index * 48} y={116} />
			))}
			<path
				d="M368 84 V162"
				stroke="var(--atelier-fg-subtle)"
				strokeDasharray="2 3"
			/>
			<text
				x="400"
				y="98"
				fontSize="10.5"
				fontWeight="700"
				fill="var(--atelier-fg-subtle)"
			>
				TABLES
			</text>
			{[0, 1, 2].map((index) => (
				<TableIcon key={index} x={400 + index * 56} y={118} />
			))}
		</svg>
	);
}
