import {
	SiteFooter,
	SiteHeader,
	useRepositoryCta,
} from "~/components/site-header";

export const primaryButton =
	"inline-flex min-h-[48px] items-center justify-center rounded-[10px] bg-[image:var(--atelier-accent-gradient)] px-6 text-[16px] font-bold whitespace-nowrap text-accent-on no-underline shadow-accent transition hover:brightness-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
export const secondaryButton =
	"inline-flex min-h-[48px] items-center justify-center gap-2 rounded-[10px] border border-fg/15 bg-panel px-5 text-[16px] font-semibold whitespace-nowrap text-fg no-underline transition hover:border-fg/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * The landing body mirrors the "LixRay Landing" design export one to one, so
 * its layout is inline styles. These rules only add what inline styles can't:
 * link colors and the narrow-screen layout, keyed on data-lr markers.
 */
const landingCss = `
[data-lr="root"] a { color: #1C1917; }
[data-lr="root"] a:hover { color: #E8590C; }
@media (max-width: 860px) {
	[data-lr="root"] { padding: 40px 20px 56px !important; gap: 56px !important; }
	[data-lr="root"] h1 { font-size: 40px !important; }
	[data-lr="root"] > :first-child a { white-space: nowrap; }
	[data-lr="mock"] { grid-template-columns: minmax(0, 1fr) !important; }
	[data-lr="mock"] > :first-child { display: none !important; }
	[data-lr="hooks"] { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
	[data-lr="hooks"] > * { grid-column: auto !important; }
	[data-lr="hack"] { grid-template-columns: minmax(0, 1fr) !important; }
	[data-lr="hack"] > :nth-child(2) { justify-self: center; transform: rotate(90deg); }
	[data-lr="hack"] > :first-child { overflow-x: auto !important; }
	[data-lr="hack"] > :first-child > :first-child > :first-child { white-space: nowrap; font-size: 14px !important; }
	[data-lr="cases"] { grid-template-columns: minmax(0, 1fr) !important; }
	[data-lr="cmp"] { overflow-x: auto !important; }
	[data-lr="cmp-row"] { min-width: 760px; }
}
`;

const compareColumns = [
	"Notion",
	"ChatGPT / Claude Projects",
	"GitHub",
	"Obsidian",
];

// Cells are claims about other products. Keep them conservative.
// The first cell of each row is LixRay.
const compareRows: { label: string; cells: boolean[] }[] = [
	{
		label: "Open source, self-hostable",
		cells: [true, false, false, false, false],
	},
	{
		label: "Works with ChatGPT, Claude, and Codex",
		cells: [true, true, false, true, true],
	},
	{
		label: "Plain files: Markdown, CSV, PDF",
		cells: [true, false, true, true, true],
	},
	{
		label: "Database tables",
		cells: [true, true, false, false, false],
	},
	{
		label: "Version control",
		cells: [true, false, false, true, false],
	},
];

const compareGrid = "minmax(0,1.4fr) repeat(5, minmax(0,1fr))";
const compareCell = {
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	textAlign: "center",
} as const;

function CompareMark({ value }: { value: boolean }) {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 22 22"
			aria-label={value ? "Yes" : "No"}
		>
			<circle cx="11" cy="11" r="11" fill={value ? "#2F8F57" : "#E7E5E4"} />
			<path
				d={value ? "M6.6 11.3 l3 3 l5.8 -6.3" : "M7.5 7.5 l7 7 M14.5 7.5 l-7 7"}
				fill="none"
				stroke={value ? "#FFFFFF" : "#78716C"}
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

function CompareTable() {
	return (
		<div
			data-lr="cmp"
			style={{
				background: "#FFFFFF",
				border: "1px solid #E2DCD3",
				borderRadius: "14px",
				overflow: "hidden",
			}}
		>
			<div
				data-lr="cmp-row"
				style={{
					display: "grid",
					gridTemplateColumns: compareGrid,
					gap: "12px",
					padding: "14px 20px",
					background: "#FAF9F7",
					fontSize: "14.5px",
					fontWeight: "600",
					color: "#44403C",
				}}
			>
				<span />
				<span style={compareCell}>
					<b style={{ display: "flex", alignItems: "center", gap: "7px" }}>
						<img
							src="/lixray-mark.svg"
							alt=""
							style={{ width: "16px", height: "16px" }}
						/>
						LixRay
					</b>
				</span>
				{compareColumns.map((column) => (
					<span key={column} style={compareCell}>
						{column}
					</span>
				))}
			</div>
			{compareRows.map((row) => (
				<div
					key={row.label}
					data-lr="cmp-row"
					style={{
						display: "grid",
						gridTemplateColumns: compareGrid,
						gap: "12px",
						padding: "13px 20px",
						borderTop: "1px solid #EDEAE6",
						fontSize: "15px",
						alignItems: "center",
					}}
				>
					<span>{row.label}</span>
					{row.cells.map((cell, index) => (
						<span key={index} style={compareCell}>
							<CompareMark value={cell} />
						</span>
					))}
				</div>
			))}
		</div>
	);
}

type ExamplePill =
	| { kind: "table" | "file" | "app"; label: string }
	| { kind: "agents" };

type ExampleMock =
	| { kind: "approvals"; branch: string; rows: [string, string][] }
	| { kind: "bars"; rows: [string, number][] }
	| { kind: "board"; columns: [string, string[]][] }
	| { kind: "reading"; rows: [string, string, boolean][] }
	| { kind: "diff"; file: string; removed: string; added: string }
	| { kind: "files"; files: string[] };

type Example = {
	title: string;
	body: string;
	tint: string;
	flow: [ExamplePill, ExamplePill];
	// Pixel art, one character per 6px pixel. "." is transparent.
	sprite: string[];
	mock: ExampleMock;
};

const spritePalette: Record<string, string> = {
	A: "#1C1917",
	W: "#FFFFFF",
	L: "#A8A29E",
	Y: "#F2C94C",
	D: "#C99A2E",
	B: "#E8B48A",
	N: "#3B4A6B",
	R: "#D9534F",
	G: "#E7E5E4",
	E: "#08B5D6",
	O: "#E8590C",
	C: "#7FB3E6",
};

// Each example needs data that lives on and changes over time. If an agent
// could do it alone in one chat, it doesn't belong here.
const examples: Example[] = [
	{
		title: "Refund approvals",
		body: "Ask an agent to build a refund panel on your orders table. It works on a branch until you merge.",
		tint: "#FFF1EA",
		flow: [
			{ kind: "table", label: "orders" },
			{ kind: "app", label: "refund panel" },
		],
		sprite: [
			"AAAAAAAAAA",
			"ACCCCCCCCA",
			"AAAAAAAAAA",
			"AAAAAAAAAA",
			"ACCCCCCCCA",
			"ACYYCCCCCA",
			"ACYYCCWWCA",
			"ACCCCCCCCA",
			"AAAAAAAAAA",
		],
		mock: {
			kind: "approvals",
			branch: "refund-panel",
			rows: [
				["#4821 · €39", "Approve"],
				["#4817 · €120", "Approve"],
			],
		},
	},
	{
		title: "Feature requests",
		body: "An agent reads support emails and keeps a table of who asked for what.",
		tint: "#EEF4F9",
		flow: [
			{ kind: "file", label: "support/*.md" },
			{ kind: "table", label: "requests" },
		],
		sprite: [
			"........RR",
			"........RR",
			"AAAAAAAAAA",
			"AAWWWWWWAA",
			"AWAWWWWAWA",
			"AWWAWWAWWA",
			"AWWWAAWWWA",
			"AWWWWWWWWA",
			"AWWWWWWWWA",
			"AAAAAAAAAA",
		],
		mock: {
			kind: "bars",
			rows: [
				["CSV export", 4],
				["Dark mode", 2],
				["SSO", 1],
			],
		},
	},
	{
		title: "Hiring pipeline",
		body: "CVs stay PDFs. An agent screens each new one into a candidates table, and your team reviews it from any AI tool.",
		tint: "#F1F5EE",
		flow: [
			{ kind: "file", label: "cvs/*.pdf" },
			{ kind: "table", label: "candidates" },
		],
		sprite: [
			"...AAAA...",
			"..AAAAAA..",
			"..ABBBBA..",
			"..ABBBBA..",
			"...ABBA...",
			"..AAWWAA..",
			".ANNWRWNA.",
			".ANNNRNNA.",
			".ANNNRNNA.",
			".ANNNNNNA.",
			".AAAAAAAA.",
		],
		mock: {
			kind: "board",
			columns: [
				["Screen", ["JW", "AT", "KO"]],
				["Call", ["ML"]],
				["Offer", []],
			],
		},
	},
	{
		title: "Read-later archive",
		body: "Clip articles as Markdown files. An agent tags them and keeps your reading list.",
		tint: "#FFF4E8",
		flow: [
			{ kind: "file", label: "clips/*.md" },
			{ kind: "table", label: "reading" },
		],
		sprite: [
			".AAAA.AAAA.",
			"AWWWWAWWWWA",
			"AWLLWAWLLWA",
			"AWWWWAWWWWA",
			"AWLLWAWLLWA",
			"AWWWWAWWWWA",
			"AWLLWAWLLWA",
			"AWWWWAWWWWA",
			".AAAAAAAAA.",
			"........R..",
			"........R..",
		],
		mock: {
			kind: "reading",
			rows: [
				["Local-first software", "sync", true],
				["SQLite in production", "db", false],
				["Designing data apps", "db", true],
			],
		},
	},
	{
		title: "Auto-updating wiki",
		body: "After each release, an agent updates your wiki. Every edit shows up in a diff.",
		tint: "#F1F0EC",
		flow: [
			{ kind: "file", label: "CHANGELOG.md" },
			{ kind: "file", label: "wiki/" },
		],
		sprite: [
			"....Y.....",
			"....A.....",
			".AAAAAAA..",
			".AGGGGGA..",
			".AGEGEGA..",
			".AGGGGGA..",
			".AAAAAAA..",
			"..AOOOA...",
			".AOOOOOA..",
			".AOOOOOA..",
			"..A...A...",
		],
		mock: {
			kind: "diff",
			file: "wiki/exports.md",
			removed: "Runs every night.",
			added: "Runs every hour.",
		},
	},
	{
		title: "Sharing skills",
		body: "Write down how your team does a task, once. Every agent can read it.",
		tint: "#FDF0EA",
		flow: [{ kind: "file", label: "skills/" }, { kind: "agents" }],
		sprite: [
			"...AAAA...",
			"...A..A...",
			"AAAAAAAAAA",
			"ARRRRRRRRA",
			"ARRRRRRRRA",
			"AAAAYYAAAA",
			"ARRRRRRRRA",
			"ARRRRRRRRA",
			"AAAAAAAAAA",
		],
		mock: {
			kind: "files",
			files: ["refund-policy.md", "release-notes.md", "hiring-rubric.md"],
		},
	},
];

const monoFont = "ui-monospace, Menlo, monospace";

function Sprite({ rows }: { rows: string[] }) {
	const width = Math.max(...rows.map((row) => row.length)) * 6;
	return (
		<svg
			width={width}
			height={rows.length * 6}
			viewBox={`0 0 ${width} ${rows.length * 6}`}
			shapeRendering="crispEdges"
			aria-hidden="true"
			style={{ display: "block", flexShrink: "0" }}
		>
			{rows.flatMap((row, y) =>
				[...row].map((pixel, x) =>
					pixel === "." ? null : (
						<rect
							key={`${x}-${y}`}
							x={x * 6}
							y={y * 6}
							width="6"
							height="6"
							fill={spritePalette[pixel]}
						/>
					),
				),
			)}
		</svg>
	);
}

function ExamplePillView({ pill }: { pill: ExamplePill }) {
	if (pill.kind === "agents") {
		return (
			<span style={{ display: "flex", alignItems: "center", gap: "5px" }}>
				{[
					"/landing/claude-spark.svg",
					"/landing/brand-openai.svg",
					"/landing/codex-icon.svg",
				].map((src) => (
					<img
						key={src}
						src={src}
						alt=""
						style={{ width: "18px", height: "18px", display: "block" }}
					/>
				))}
			</span>
		);
	}
	return (
		<span
			style={{
				display: "flex",
				alignItems: "center",
				gap: "5px",
				background: "#FFFFFF",
				border: "1px solid #E2DCD3",
				borderRadius: "99px",
				padding: "2px 9px",
				fontFamily: monoFont,
				fontSize: "12px",
			}}
		>
			<svg
				width="12"
				height="12"
				viewBox="0 0 16 16"
				fill="none"
				stroke="#78716C"
				strokeWidth="1.3"
			>
				{pill.kind === "table" ? (
					<>
						<rect x="1.5" y="2.5" width="13" height="11" rx="1.8" />
						<path d="M1.5 6.3 h13 M6 6.3 v7.2" />
					</>
				) : pill.kind === "file" ? (
					<path d="M4 1.5 h5 l3.5 3.5 v9.5 h-8.5 z M9 1.5 v3.5 h3.5" />
				) : (
					<>
						<rect x="1.5" y="2.5" width="13" height="11" rx="1.8" />
						<path d="M1.5 5.5 h13" />
					</>
				)}
			</svg>
			{pill.label}
		</span>
	);
}

const mockPanel = {
	background: "#FFFFFF",
	border: "1px solid #E2DCD3",
	borderRadius: "9px",
	fontSize: "12px",
	overflow: "hidden",
} as const;

const ellipsis = {
	overflow: "hidden",
	textOverflow: "ellipsis",
	whiteSpace: "nowrap",
} as const;

function ExampleMockView({ mock }: { mock: ExampleMock }) {
	switch (mock.kind) {
		case "approvals":
			return (
				<div style={mockPanel}>
					<div
						style={{
							padding: "6px 9px",
							fontFamily: monoFont,
							fontSize: "11px",
							color: "#C2410C",
							background: "#FFF7F2",
							display: "flex",
							alignItems: "center",
							borderBottom: "1px solid #EDEAE6",
						}}
					>
						<svg
							width="10"
							height="10"
							viewBox="0 0 16 16"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.6"
							style={{ marginRight: "5px", flexShrink: "0" }}
						>
							<circle cx="4" cy="3.5" r="1.8" />
							<circle cx="4" cy="12.5" r="1.8" />
							<circle cx="12" cy="5.5" r="1.8" />
							<path d="M4 5.3 v5.4 M12 7.3 c0 3 -8 2 -8 3.4" />
						</svg>
						{mock.branch}
					</div>
					{mock.rows.map(([order, action]) => (
						<div
							key={order}
							style={{
								display: "flex",
								alignItems: "center",
								justifyContent: "space-between",
								gap: "6px",
								padding: "6px 9px",
								borderTop: "1px solid #EDEAE6",
							}}
						>
							<span style={ellipsis}>{order}</span>
							<span
								style={{
									fontSize: "11px",
									fontWeight: "600",
									color: "#FFFFFF",
									background: "#2F8F57",
									borderRadius: "6px",
									padding: "2px 7px",
								}}
							>
								{action}
							</span>
						</div>
					))}
				</div>
			);
		case "bars": {
			const max = Math.max(...mock.rows.map(([, count]) => count));
			return (
				<div
					style={{
						...mockPanel,
						padding: "8px 9px",
						display: "grid",
						gap: "7px",
					}}
				>
					{mock.rows.map(([label, count]) => (
						<div
							key={label}
							style={{
								display: "grid",
								gridTemplateColumns: "72px minmax(0,1fr) 12px",
								gap: "7px",
								alignItems: "center",
							}}
						>
							<span style={ellipsis}>{label}</span>
							<span
								style={{
									height: "8px",
									borderRadius: "4px",
									background: "#7FB3E6",
									width: `${(count / max) * 100}%`,
								}}
							/>
							<span style={{ color: "#78716C", textAlign: "right" }}>
								{count}
							</span>
						</div>
					))}
				</div>
			);
		}
		case "board":
			return (
				<div
					style={{
						display: "grid",
						gridTemplateColumns: `repeat(${mock.columns.length}, minmax(0,1fr))`,
						gap: "5px",
					}}
				>
					{mock.columns.map(([column, people]) => (
						<div
							key={column}
							style={{ ...mockPanel, padding: "6px", minHeight: "74px" }}
						>
							<div
								style={{
									fontSize: "10.5px",
									color: "#78716C",
									marginBottom: "5px",
									...ellipsis,
								}}
							>
								{column}
							</div>
							<div style={{ display: "flex", flexWrap: "wrap", gap: "3px" }}>
								{people.map((initials) => (
									<span
										key={initials}
										style={{
											fontSize: "10px",
											fontWeight: "700",
											background: "#E3EEDC",
											color: "#3E6B2E",
											borderRadius: "5px",
											padding: "2px 4px",
										}}
									>
										{initials}
									</span>
								))}
							</div>
						</div>
					))}
				</div>
			);
		case "reading":
			return (
				<div style={mockPanel}>
					{mock.rows.map(([title, tag, unread], index) => (
						<div
							key={title}
							style={{
								display: "flex",
								alignItems: "center",
								gap: "6px",
								padding: "6px 9px",
								borderTop: index ? "1px solid #EDEAE6" : "none",
							}}
						>
							<span
								style={{
									width: "6px",
									height: "6px",
									borderRadius: "3px",
									flexShrink: "0",
									background: unread ? "#E8590C" : "transparent",
								}}
							/>
							<span style={{ ...ellipsis, flex: "1" }}>{title}</span>
							<span
								style={{
									fontFamily: monoFont,
									fontSize: "10.5px",
									color: "#78716C",
									background: "#F3F1ED",
									borderRadius: "4px",
									padding: "1px 5px",
								}}
							>
								{tag}
							</span>
						</div>
					))}
				</div>
			);
		case "diff":
			return (
				<div style={{ ...mockPanel, fontFamily: monoFont, fontSize: "11.5px" }}>
					<div
						style={{
							padding: "6px 9px",
							borderBottom: "1px solid #EDEAE6",
							color: "#78716C",
							...ellipsis,
						}}
					>
						{mock.file}
					</div>
					<div
						style={{
							padding: "5px 9px",
							background: "#FDECEC",
							color: "#B42318",
							...ellipsis,
						}}
					>
						{"- " + mock.removed}
					</div>
					<div
						style={{
							padding: "5px 9px",
							background: "#E8F5EC",
							color: "#1F7A43",
							...ellipsis,
						}}
					>
						{"+ " + mock.added}
					</div>
				</div>
			);
		case "files":
			return (
				<div style={{ ...mockPanel, fontFamily: monoFont, fontSize: "11.5px" }}>
					{mock.files.map((file, index) => (
						<div
							key={file}
							style={{
								padding: "6px 9px",
								borderTop: index ? "1px solid #EDEAE6" : "none",
								...ellipsis,
							}}
						>
							{file}
						</div>
					))}
				</div>
			);
	}
}

function ExampleCards() {
	return (
		<div
			data-lr="cases"
			style={{
				display: "grid",
				gridTemplateColumns: "repeat(3, minmax(0,1fr))",
				gap: "16px",
			}}
		>
			{examples.map((example) => (
				<div
					key={example.title}
					style={{
						background: "#FFFFFF",
						border: "1px solid #E2DCD3",
						borderRadius: "16px",
						overflow: "hidden",
						display: "flex",
						flexDirection: "column",
					}}
				>
					<div
						style={{
							background: example.tint,
							padding: "16px 16px 18px",
							display: "flex",
							flexDirection: "column",
							gap: "14px",
							height: "190px",
							boxSizing: "border-box",
						}}
					>
						<div
							style={{
								display: "flex",
								alignItems: "center",
								gap: "7px",
								flexWrap: "wrap",
							}}
						>
							<ExamplePillView pill={example.flow[0]} />
							<span style={{ color: "#A8A29E" }}>{"→"}</span>
							<ExamplePillView pill={example.flow[1]} />
						</div>
						<div
							style={{
								flex: "1",
								display: "flex",
								alignItems: "flex-end",
								gap: "14px",
							}}
						>
							<Sprite rows={example.sprite} />
							<div style={{ flex: "1", minWidth: "0" }}>
								<ExampleMockView mock={example.mock} />
							</div>
						</div>
					</div>
					<div
						style={{
							padding: "14px 16px 16px",
							display: "flex",
							flexDirection: "column",
							gap: "5px",
							borderTop: "1px solid #EDEAE6",
							flex: "1",
						}}
					>
						<b style={{ fontSize: "16px" }}>{example.title}</b>
						<span
							style={{
								fontSize: "14px",
								lineHeight: "1.5",
								color: "#57534E",
								textWrap: "pretty",
							}}
						>
							{example.body}
						</span>
					</div>
				</div>
			))}
		</div>
	);
}

export function LandingPage() {
	const { user, repositoryTo } = useRepositoryCta();
	const ctaLabel = user ? "Open LixRay" : "Create a repository";

	return (
		<div style={{ minHeight: "100vh", background: "#F3F1ED" }}>
			<style>{landingCss}</style>
			<SiteHeader />
			<main>
				<div
					data-lr="root"
					style={{
						background: "#F3F1ED",
						maxWidth: "1040px",
						margin: "0 auto",
						boxSizing: "border-box",
						fontFamily:
							"-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
						color: "#1C1917",
						padding: "80px 64px 72px",
						display: "flex",
						flexDirection: "column",
						gap: "72px",
					}}
				>
					<div
						style={{ display: "flex", flexDirection: "column", gap: "26px" }}
					>
						<h1
							style={{
								margin: "0",
								fontSize: "58px",
								fontWeight: "700",
								letterSpacing: "-0.04em",
								lineHeight: "1.05",
								textWrap: "balance",
							}}
						>
							{"Shared repository for every AI agent you use."}
						</h1>
						<p
							style={{
								margin: "0",
								fontSize: "19px",
								lineHeight: "1.6",
								color: "#44403C",
								textWrap: "pretty",
								maxWidth: "680px",
							}}
						>
							{
								"Files and SQL tables under version control, in one open-source repo. Claude, ChatGPT, Codex, and your scripts read and write the same data."
							}
						</p>
						<div style={{ display: "flex", alignItems: "center", gap: "20px" }}>
							<a
								href={repositoryTo}
								style={{
									fontSize: "17px",
									fontWeight: "700",
									color: "#FFFFFF",
									background:
										"linear-gradient(180deg, #F97316 0%, #E8590C 100%)",
									boxShadow:
										"0 8px 20px rgba(232,89,12,.3), inset 0 1px 0 rgba(255,255,255,.25)",
									textDecoration: "none",
									padding: "14px 24px",
									borderRadius: "10px",
								}}
							>
								{ctaLabel}
							</a>
							<a
								href="https://github.com/opral/lix"
								target="_blank"
								rel="noreferrer"
								style={{ fontSize: "16px", fontWeight: "600" }}
							>
								{"View on GitHub"}
							</a>
						</div>
					</div>
					<div
						style={{
							background: "#FFFFFF",
							border: "1px solid #E2DCD3",
							borderRadius: "16px",
							boxShadow: "0 12px 32px rgba(28,25,23,0.07)",
							overflow: "hidden",
						}}
					>
						<div
							style={{
								display: "flex",
								alignItems: "center",
								gap: "8px",
								padding: "12px 16px",
								background: "#FAF9F7",
								borderBottom: "1px solid #EDEAE6",
							}}
						>
							<span
								style={{
									width: "11px",
									height: "11px",
									borderRadius: "50%",
									background: "#E2DCD3",
								}}
							></span>
							<span
								style={{
									width: "11px",
									height: "11px",
									borderRadius: "50%",
									background: "#E2DCD3",
								}}
							></span>
							<span
								style={{
									width: "11px",
									height: "11px",
									borderRadius: "50%",
									background: "#E2DCD3",
									marginRight: "8px",
								}}
							></span>
							<span
								style={{
									fontFamily: "ui-monospace, Menlo, monospace",
									fontSize: "13.5px",
									color: "#78716C",
								}}
							>
								{"lixray.com"}
							</span>
						</div>
						<div
							data-lr="mock"
							style={{
								display: "grid",
								gridTemplateColumns: "210px minmax(0,1fr)",
							}}
						>
							<div
								style={{
									padding: "16px 10px",
									borderRight: "1px solid #EDEAE6",
									display: "flex",
									flexDirection: "column",
									gap: "2px",
									fontSize: "14.5px",
								}}
							>
								<span
									style={{
										display: "flex",
										alignItems: "center",
										gap: "9px",
										padding: "4px 10px 12px",
										fontSize: "18px",
										fontWeight: "700",
									}}
								>
									<img
										src="/lixray-mark.svg"
										alt=""
										style={{ width: "20px", height: "20px" }}
									/>
									{"home"}
								</span>
								<span
									style={{
										display: "flex",
										alignItems: "center",
										gap: "10px",
										padding: "7px 10px",
										borderRadius: "8px",
										background: "#F3F1ED",
										fontWeight: "600",
									}}
								>
									<svg
										width="16"
										height="16"
										viewBox="0 0 16 16"
										fill="none"
										stroke="#1C1917"
										strokeWidth="1.3"
									>
										<rect x="1.5" y="1.5" width="5" height="5" rx="1" />
										<rect x="9.5" y="1.5" width="5" height="5" rx="1" />
										<rect x="1.5" y="9.5" width="5" height="5" rx="1" />
										<rect x="9.5" y="9.5" width="5" height="5" rx="1" />
									</svg>
									{"All"}
								</span>
								<span
									style={{
										display: "flex",
										alignItems: "center",
										gap: "10px",
										padding: "7px 10px",
										color: "#44403C",
									}}
								>
									<svg
										width="16"
										height="16"
										viewBox="0 0 16 16"
										fill="none"
										stroke="#78716C"
										strokeWidth="1.3"
										strokeLinejoin="round"
									>
										<path d="M3.5 1.5 h6 l3 3 v10 h-9 z M5.5 8 h5 M5.5 10.5 h5" />
									</svg>
									{"Documents"}
								</span>
								<span
									style={{
										display: "flex",
										alignItems: "center",
										gap: "10px",
										padding: "7px 10px",
										color: "#44403C",
									}}
								>
									<svg
										width="16"
										height="16"
										viewBox="0 0 16 16"
										fill="none"
										stroke="#78716C"
										strokeWidth="1.3"
									>
										<rect x="1.5" y="2.5" width="13" height="11" rx="1.8" />
										<path d="M1.5 6.3 h13 M6 6.3 v7.2" />
									</svg>
									{"Tables"}
								</span>
								<span
									style={{
										display: "flex",
										alignItems: "center",
										gap: "10px",
										padding: "7px 10px",
										color: "#44403C",
									}}
								>
									<svg
										width="16"
										height="16"
										viewBox="0 0 16 16"
										fill="none"
										stroke="#78716C"
										strokeWidth="1.3"
										strokeLinecap="round"
									>
										<path d="M2 8 a6 6 0 1 0 1.8 -4.3 M2 2.5 v3 h3 M8 4.8 v3.4 l2 1.3" />
									</svg>
									{"History"}
								</span>
								<span
									style={{
										padding: "18px 10px 6px",
										fontSize: "12px",
										fontWeight: "700",
										letterSpacing: "0.1em",
										color: "#78716C",
									}}
								>
									{"SOURCES"}
									<span
										style={{
											marginLeft: "8px",
											padding: "1px 7px",
											borderRadius: "99px",
											background: "#FFF4EC",
											color: "#C2410C",
											fontSize: "10.5px",
											letterSpacing: "0.04em",
										}}
									>
										{"SOON"}
									</span>
								</span>
								<span
									style={{
										display: "flex",
										alignItems: "center",
										gap: "10px",
										padding: "7px 10px",
									}}
								>
									<svg width="16" height="16" viewBox="0 0 16 16">
										<path d="M5.5 1.5h5l4.5 8h-5z" fill="#FBBC04" />
										<path d="M5.5 1.5L1 9.5l2.5 4.3L8 5.8z" fill="#0F9D58" />
										<path d="M3.5 13.8h9.5l2-4.3H5.8z" fill="#4285F4" />
									</svg>
									{"Google Drive"}
								</span>
								<span
									style={{
										display: "flex",
										alignItems: "center",
										gap: "10px",
										padding: "7px 10px",
									}}
								>
									<svg width="16" height="16" viewBox="0 0 16 16">
										<rect
											x="1.5"
											y="1.5"
											width="13"
											height="13"
											rx="2.5"
											fill="#FFFFFF"
											stroke="#1C1917"
											strokeWidth="1.3"
										/>
										<path
											d="M5.2 11.5 V4.6 l5.8 6.9 V4.5"
											fill="none"
											stroke="#1C1917"
											strokeWidth="1.4"
											strokeLinejoin="round"
										/>
									</svg>
									{"Notion"}
								</span>
								<span
									style={{
										display: "flex",
										alignItems: "center",
										gap: "10px",
										padding: "7px 10px",
										color: "#78716C",
									}}
								>
									<span
										style={{
											width: "16px",
											textAlign: "center",
											fontSize: "18px",
											lineHeight: "1",
										}}
									>
										{"+"}
									</span>
									{"Connect source"}
								</span>
								<span
									style={{
										padding: "18px 10px 6px",
										fontSize: "12px",
										fontWeight: "700",
										letterSpacing: "0.1em",
										color: "#78716C",
									}}
								>
									{"AGENTS"}
								</span>
								<span
									style={{
										display: "flex",
										alignItems: "center",
										gap: "10px",
										padding: "7px 10px",
									}}
								>
									<img
										src="/landing/claude-spark.svg"
										alt=""
										style={{ width: "16px", height: "16px" }}
									/>
									{"Claude"}
								</span>
								<span
									style={{
										display: "flex",
										alignItems: "center",
										gap: "10px",
										padding: "7px 10px",
									}}
								>
									<img
										src="/landing/brand-openai.svg"
										alt=""
										style={{ width: "16px", height: "16px" }}
									/>
									{"ChatGPT"}
								</span>
							</div>
							<div
								style={{
									padding: "24px 28px",
									display: "flex",
									flexDirection: "column",
									gap: "14px",
									fontSize: "15px",
								}}
							>
								<div
									style={{
										display: "flex",
										alignItems: "center",
										justifyContent: "space-between",
									}}
								>
									<span
										style={{
											fontSize: "26px",
											fontWeight: "700",
											letterSpacing: "-0.02em",
										}}
									>
										{"All"}
									</span>
									<span
										style={{
											background: "#1C1917",
											color: "#FFFFFF",
											fontSize: "14px",
											fontWeight: "600",
											padding: "8px 16px",
											borderRadius: "99px",
										}}
									>
										{"New \u25be"}
									</span>
								</div>
								<div
									style={{
										display: "flex",
										justifyContent: "space-between",
										padding: "8px 0",
										borderBottom: "1px solid #EDEAE6",
										fontSize: "13.5px",
										color: "#78716C",
									}}
								>
									<span>{"Name"}</span>
									<span>{"Changed by"}</span>
								</div>
								<div
									style={{
										display: "flex",
										justifyContent: "space-between",
										alignItems: "center",
										padding: "7px 0",
										borderBottom: "1px solid #EDEAE6",
									}}
								>
									<span
										style={{
											display: "flex",
											alignItems: "center",
											gap: "12px",
										}}
									>
										<svg
											width="20"
											height="20"
											viewBox="0 0 16 16"
											fill="none"
											stroke="#78716C"
											strokeWidth="1.1"
										>
											<rect x="1.5" y="2.5" width="13" height="11" rx="1.8" />
											<path d="M1.5 6.3 h13 M6 6.3 v7.2" />
										</svg>
										{"customers"}
									</span>
									<span
										style={{
											display: "flex",
											alignItems: "center",
											gap: "7px",
										}}
									>
										<img
											src="/landing/claude-spark.svg"
											alt=""
											style={{ width: "15px", height: "15px" }}
										/>
										{"Claude"}
									</span>
								</div>
								<div
									style={{
										display: "flex",
										justifyContent: "space-between",
										alignItems: "center",
										padding: "7px 0",
										borderBottom: "1px solid #EDEAE6",
									}}
								>
									<span
										style={{
											display: "flex",
											alignItems: "center",
											gap: "12px",
										}}
									>
										<svg
											width="20"
											height="20"
											viewBox="0 0 16 16"
											fill="none"
											stroke="#78716C"
											strokeWidth="1.1"
										>
											<rect x="1.5" y="2.5" width="13" height="11" rx="1.8" />
											<path d="M1.5 6.3 h13 M6 6.3 v7.2" />
										</svg>
										{"orders"}
									</span>
									<span
										style={{
											display: "flex",
											alignItems: "center",
											gap: "7px",
										}}
									>
										<img
											src="/landing/brand-openai.svg"
											alt=""
											style={{ width: "15px", height: "15px" }}
										/>
										{"ChatGPT"}
									</span>
								</div>
								<div
									style={{
										display: "flex",
										justifyContent: "space-between",
										alignItems: "center",
										padding: "7px 0",
										borderBottom: "1px solid #EDEAE6",
									}}
								>
									<span
										style={{
											display: "flex",
											alignItems: "center",
											gap: "12px",
										}}
									>
										<img
											src="/landing/icon-folder.svg"
											alt=""
											style={{ width: "20px", height: "20px" }}
										/>
										{"research"}
									</span>
									<span
										style={{
											display: "flex",
											alignItems: "center",
											gap: "7px",
										}}
									>
										<img
											src="/landing/claude-spark.svg"
											alt=""
											style={{ width: "15px", height: "15px" }}
										/>
										{"Claude"}
									</span>
								</div>
								<div
									style={{
										display: "flex",
										justifyContent: "space-between",
										alignItems: "center",
										padding: "7px 0",
										borderBottom: "1px solid #EDEAE6",
									}}
								>
									<span
										style={{
											display: "flex",
											alignItems: "center",
											gap: "12px",
										}}
									>
										<img
											src="/landing/icon-sq-md.svg"
											alt=""
											style={{ width: "20px", height: "20px" }}
										/>
										{"roadmap.md"}
									</span>
									<span
										style={{
											display: "flex",
											alignItems: "center",
											gap: "7px",
										}}
									>
										<img
											src="/landing/brand-openai.svg"
											alt=""
											style={{ width: "15px", height: "15px" }}
										/>
										{"ChatGPT"}
									</span>
								</div>
								<div
									style={{
										display: "flex",
										justifyContent: "space-between",
										alignItems: "center",
										padding: "7px 0",
										borderBottom: "1px solid #EDEAE6",
									}}
								>
									<span
										style={{
											display: "flex",
											alignItems: "center",
											gap: "12px",
										}}
									>
										<svg width="20" height="20" viewBox="0 0 16 16">
											<rect
												x="4"
												y="1"
												width="11"
												height="14"
												rx="1.6"
												fill="#21A366"
											/>
											<rect
												x="1"
												y="4"
												width="9"
												height="8"
												rx="1.3"
												fill="#107C41"
											/>
											<path
												d="M3.3 6 l4 4 M7.3 6 l-4 4"
												stroke="#FFFFFF"
												strokeWidth="1.2"
												strokeLinecap="round"
											/>
										</svg>
										{"budget.xlsx"}
									</span>
									<span style={{ color: "#44403C" }}>{"You"}</span>
								</div>
								<div
									style={{
										display: "flex",
										justifyContent: "space-between",
										alignItems: "center",
										padding: "7px 0",
									}}
								>
									<span
										style={{
											display: "flex",
											alignItems: "center",
											gap: "12px",
										}}
									>
										<img
											src="/landing/icon-sq-pdf.svg"
											alt=""
											style={{ width: "20px", height: "20px" }}
										/>
										{"pitch-deck.pdf"}
									</span>
									<span style={{ color: "#44403C" }}>{"You"}</span>
								</div>
								<div
									style={{
										marginTop: "6px",
										border: "1px solid #E2DCD3",
										borderRadius: "14px",
										background: "#FAF9F7",
										padding: "14px 16px",
										display: "flex",
										alignItems: "center",
										gap: "14px",
										flexWrap: "wrap",
									}}
								>
									<span
										style={{
											display: "flex",
											alignItems: "center",
											gap: "8px",
											fontSize: "14.5px",
										}}
									>
										<img
											src="/landing/claude-spark.svg"
											alt=""
											style={{ width: "16px", height: "16px" }}
										/>
										<span>
											<b>{"Claude"}</b>
											{" changed 1 row in customers"}
										</span>
									</span>
									<div
										style={{
											flex: "1",
											minWidth: "150px",
											background: "#FFFFFF",
											borderRadius: "8px",
											padding: "6px 12px",
											fontFamily: "ui-monospace, Menlo, monospace",
											fontSize: "13px",
										}}
									>
										<div
											style={{
												display: "flex",
												gap: "40px",
												color: "#78716C",
												paddingBottom: "4px",
												borderBottom: "1px solid #EDEAE6",
											}}
										>
											<span style={{ width: "50px" }}>{"name"}</span>
											<span>{"plan"}</span>
										</div>
										<div
											style={{
												display: "flex",
												gap: "40px",
												paddingTop: "5px",
											}}
										>
											<span style={{ width: "50px" }}>{"Acme"}</span>
											<span>
												<span
													style={{
														background: "#FDECEC",
														color: "#B42318",
														textDecoration: "line-through",
														padding: "0 4px",
														borderRadius: "3px",
													}}
												>
													{"trial"}
												</span>{" "}
												<span
													style={{
														background: "#E7F3EB",
														color: "#1F6B40",
														padding: "0 4px",
														borderRadius: "3px",
													}}
												>
													{"paid"}
												</span>
											</span>
										</div>
									</div>
									<span style={{ display: "flex", gap: "8px" }}>
										<span
											style={{
												background: "#1C1917",
												color: "#FFFFFF",
												fontSize: "14px",
												fontWeight: "600",
												padding: "8px 16px",
												borderRadius: "8px",
											}}
										>
											{"Keep"}
										</span>
										<span
											style={{
												border: "1px solid #E2DCD3",
												background: "#FFFFFF",
												fontSize: "14px",
												padding: "8px 16px",
												borderRadius: "8px",
											}}
										>
											{"Undo"}
										</span>
									</span>
								</div>
							</div>
						</div>
					</div>
					<div
						data-lr="hooks"
						style={{
							display: "grid",
							gridTemplateColumns: "repeat(6, minmax(0,1fr))",
							gap: "36px 32px",
						}}
					>
						<div
							style={{
								gridColumn: "span 2",
								display: "flex",
								flexDirection: "column",
								gap: "8px",
							}}
						>
							<span
								style={{
									display: "flex",
									alignItems: "center",
									gap: "10px",
									height: "24px",
								}}
							>
								<img
									src="/landing/claude-spark.svg"
									alt="Claude"
									style={{
										width: "22px",
										height: "22px",
										display: "block",
										flexShrink: "0",
									}}
								/>
								<img
									src="/landing/brand-openai.svg"
									alt="ChatGPT"
									style={{
										width: "22px",
										height: "22px",
										display: "block",
										flexShrink: "0",
									}}
								/>
								<img
									src="/landing/codex-icon.svg"
									alt="Codex"
									style={{
										width: "22px",
										height: "22px",
										display: "block",
										flexShrink: "0",
									}}
								/>
								<span style={{ fontSize: "14px", color: "#78716C" }}>
									{"and more"}
								</span>
							</span>
							<b style={{ fontSize: "17px" }}>{"Every agent"}</b>
							<span
								style={{
									fontSize: "15px",
									lineHeight: "1.55",
									color: "#44403C",
									textWrap: "pretty",
								}}
							>
								{
									"Claude, ChatGPT, Codex, and any MCP client connect. Your scripts use the same SQL."
								}
							</span>
						</div>
						<div
							style={{
								gridColumn: "span 2",
								display: "flex",
								flexDirection: "column",
								gap: "8px",
							}}
						>
							<svg
								width="24"
								height="24"
								viewBox="0 0 20 20"
								fill="none"
								stroke="#1C1917"
								strokeWidth="1.6"
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								<path d="M5 2.5 h6 l4 4 v11 h-10 z M11 2.5 v4 h4" />
							</svg>
							<b style={{ fontSize: "17px" }}>{"Files"}</b>
							<span
								style={{
									fontSize: "15px",
									lineHeight: "1.55",
									color: "#44403C",
									textWrap: "pretty",
								}}
							>
								{
									"Markdown, CSV, PDFs, and spreadsheets stay files. Any agent can read them."
								}
							</span>
						</div>
						<div
							style={{
								gridColumn: "span 2",
								display: "flex",
								flexDirection: "column",
								gap: "8px",
							}}
						>
							<svg
								width="24"
								height="24"
								viewBox="0 0 20 20"
								fill="none"
								stroke="#1C1917"
								strokeWidth="1.6"
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								<rect x="2.5" y="3.5" width="15" height="13" rx="2" />
								<path d="M2.5 8 h15 M7.5 8 v8.5" />
							</svg>
							<b style={{ fontSize: "17px" }}>{"Database tables"}</b>
							<span
								style={{
									fontSize: "15px",
									lineHeight: "1.55",
									color: "#44403C",
									textWrap: "pretty",
								}}
							>
								{"Customers, orders, runs. Agents query them with SQL."}
							</span>
						</div>
						<div
							style={{
								gridColumn: "span 2",
								display: "flex",
								flexDirection: "column",
								gap: "8px",
							}}
						>
							<svg
								width="24"
								height="24"
								viewBox="0 0 20 20"
								fill="none"
								stroke="#1C1917"
								strokeWidth="1.6"
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								<circle cx="5" cy="4.5" r="2" />
								<circle cx="5" cy="15.5" r="2" />
								<circle cx="15" cy="7" r="2" />
								<path d="M5 6.5 v7 M15 9 c0 3.5 -10 2.5 -10 4.5" />
							</svg>
							<b style={{ fontSize: "17px" }}>{"Version control"}</b>
							<span
								style={{
									fontSize: "15px",
									lineHeight: "1.55",
									color: "#44403C",
									textWrap: "pretty",
								}}
							>
								{
									"Branch, diff, and roll back files and rows. Markdown and CSV diff row by row."
								}
							</span>
						</div>
						<div
							style={{
								gridColumn: "span 2",
								display: "flex",
								flexDirection: "column",
								gap: "8px",
							}}
						>
							<svg
								width="24"
								height="24"
								viewBox="0 0 20 20"
								fill="none"
								stroke="#1C1917"
								strokeWidth="1.6"
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								<path d="M7 6 L3 10 L7 14 M13 6 L17 10 L13 14" />
							</svg>
							<b style={{ fontSize: "17px" }}>{"Open source"}</b>
							<span
								style={{
									fontSize: "15px",
									lineHeight: "1.55",
									color: "#44403C",
									textWrap: "pretty",
								}}
							>
								{"Self-host it, or embed Lix in your product."}
							</span>
						</div>
						<div
							style={{
								gridColumn: "span 2",
								display: "flex",
								flexDirection: "column",
								gap: "8px",
							}}
						>
							<span
								style={{
									display: "flex",
									alignItems: "center",
									gap: "10px",
									height: "24px",
								}}
							>
								<svg width="22" height="22" viewBox="0 0 16 16">
									<path d="M5.5 1.5h5l4.5 8h-5z" fill="#FBBC04" />
									<path d="M5.5 1.5L1 9.5l2.5 4.3L8 5.8z" fill="#0F9D58" />
									<path d="M3.5 13.8h9.5l2-4.3H5.8z" fill="#4285F4" />
								</svg>
								<svg width="22" height="22" viewBox="0 0 16 16">
									<rect
										x="1.5"
										y="1.5"
										width="13"
										height="13"
										rx="2.5"
										fill="#FFFFFF"
										stroke="#1C1917"
										strokeWidth="1.3"
									/>
									<path
										d="M5.2 11.5 V4.6 l5.8 6.9 V4.5"
										fill="none"
										stroke="#1C1917"
										strokeWidth="1.4"
										strokeLinejoin="round"
									/>
								</svg>
								<img
									src="/landing/brand-granola.svg"
									alt="Granola"
									style={{
										width: "22px",
										height: "22px",
										display: "block",
										flexShrink: "0",
									}}
								/>
								<span style={{ fontSize: "14px", color: "#78716C" }}>
									{"and more"}
								</span>
							</span>
							<b
								style={{
									fontSize: "17px",
									display: "flex",
									alignItems: "center",
									gap: "8px",
								}}
							>
								{"Mount your sources"}
								<span
									style={{
										fontSize: "11.5px",
										fontWeight: "700",
										color: "#B54708",
										background: "#FDEBD3",
										padding: "2px 8px",
										borderRadius: "99px",
									}}
								>
									{"Soon"}
								</span>
							</b>
							<span
								style={{
									fontSize: "15px",
									lineHeight: "1.55",
									color: "#44403C",
									textWrap: "pretty",
								}}
							>
								{
									"Mount Drive, Notion, and Granola. Agents work from one place."
								}
							</span>
						</div>
					</div>
					<div
						style={{
							display: "flex",
							flexDirection: "column",
							gap: "20px",
							paddingTop: "56px",
							borderTop: "1px solid #D6CFC6",
						}}
					>
						<h3
							style={{
								margin: "0",
								fontSize: "34px",
								fontWeight: "700",
								letterSpacing: "-0.02em",
							}}
						>
							{"Why not Notion or GitHub?"}
						</h3>
						<p
							style={{
								margin: "0",
								fontSize: "18px",
								lineHeight: "1.65",
								color: "#44403C",
								maxWidth: "680px",
								textWrap: "pretty",
							}}
						>
							{
								"Each covers part of it. LixRay is the only one that is open source and keeps files, database tables, and version control in one repo every agent can use."
							}
						</p>
						<CompareTable />
					</div>
					<div
						style={{
							display: "flex",
							flexDirection: "column",
							gap: "28px",
							paddingTop: "56px",
							borderTop: "1px solid #D6CFC6",
						}}
					>
						<div
							style={{ display: "flex", flexDirection: "column", gap: "12px" }}
						>
							<h3
								style={{
									margin: "0",
									fontSize: "34px",
									fontWeight: "700",
									letterSpacing: "-0.02em",
								}}
							>
								{"Your agents can build on it"}
							</h3>
							<p
								style={{
									margin: "0",
									fontSize: "18px",
									lineHeight: "1.65",
									color: "#44403C",
									textWrap: "pretty",
									maxWidth: "740px",
								}}
							>
								{
									"Ask an agent to build a dashboard, an app, or a workflow on your files and tables. It works on a branch, so it can try anything. Merge what works and throw away the rest. LixRay is built on "
								}
								<a
									href="https://lix.dev"
									aria-label="Lix"
									style={{ display: "inline-block", padding: "0 2px" }}
								>
									<svg
										width="23"
										height="16"
										viewBox="0 0 26 18"
										fill="none"
										style={{ display: "inline-block", verticalAlign: "-2px" }}
									>
										<path
											d="M14.7618 5.74842L16.9208 9.85984L22.3675 0.358398H25.7133L19.0723 11.6284L22.5712 17.5085H19.2407L16.9208 13.443L14.6393 17.5085H11.2705L14.7618 11.6284L11.393 5.74842H14.7618Z"
											fill="#08B5D6"
										/>
										<path
											d="M6.16211 17.5081V5.74805H9.42368V17.5081H6.16211Z"
											fill="#08B5D6"
										/>
										<path
											d="M3.52112 0.393555V17.6416H0.287109V0.393555H3.52112Z"
											fill="#08B5D6"
										/>
										<path
											d="M6.21582 0.393555H14.8399V3.08856H6.21582V0.393555Z"
											fill="#08B5D6"
										/>
									</svg>
									<svg
										width="11"
										height="11"
										viewBox="0 0 12 12"
										fill="none"
										stroke="#08B5D6"
										strokeWidth="1.6"
										strokeLinecap="round"
										strokeLinejoin="round"
										aria-hidden="true"
										style={{
											display: "inline-block",
											marginLeft: "2px",
											verticalAlign: "4px",
										}}
									>
										<path d="M3.5 8.5 L8.5 3.5 M4.5 3.5 H8.5 V7.5" />
									</svg>
								</a>
								{
									", an open-source engine with one SQL API for agents and your own code."
								}
							</p>
						</div>
						<div
							data-lr="hack"
							style={{
								display: "grid",
								gridTemplateColumns: "minmax(0,1.25fr) 44px minmax(0,1fr)",
								gap: "14px",
								alignItems: "center",
							}}
						>
							<div
								style={{
									background: "#1C1917",
									borderRadius: "14px",
									overflow: "hidden",
									boxShadow: "0 16px 36px rgba(28,25,23,0.16)",
								}}
							>
								<div
									style={{
										display: "flex",
										alignItems: "center",
										justifyContent: "space-between",
										gap: "12px",
										padding: "14px 20px",
										background: "#292524",
										borderBottom: "1px solid #3A3531",
									}}
								>
									<span
										style={{
											fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
											fontSize: "16px",
											color: "#F3F1ED",
										}}
									>
										<span style={{ color: "#8A8178" }}>{"$ "}</span>
										{"npm install @lix-js/sdk"}
									</span>
									<span
										style={{
											fontSize: "13px",
											fontWeight: "600",
											color: "#1C1917",
											background: "#F3F1ED",
											padding: "5px 12px",
											borderRadius: "7px",
										}}
									>
										{"Copy"}
									</span>
								</div>
								<div
									style={{
										padding: "18px 20px 20px 8px",
										fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
										fontSize: "14px",
										lineHeight: "1.8",
										color: "#F3F1ED",
									}}
								>
									<div
										style={{
											display: "grid",
											gridTemplateColumns: "26px minmax(0,1fr)",
											gap: "16px",
											minHeight: "1.8em",
										}}
									>
										<span style={{ color: "#57534E", textAlign: "right" }}>
											{"1"}
										</span>
										<span style={{ whiteSpace: "nowrap" }}>
											<span style={{ color: "#93C5FD" }}>{"import"}</span>
											{" { openLix } "}
											<span style={{ color: "#93C5FD" }}>{"from"}</span>{" "}
											<span style={{ color: "#A8D8B9" }}>
												{'"@lix-js/sdk"'}
											</span>
											{";"}
										</span>
									</div>
									<div
										style={{
											display: "grid",
											gridTemplateColumns: "26px minmax(0,1fr)",
											gap: "16px",
											minHeight: "1.8em",
										}}
									>
										<span style={{ color: "#57534E", textAlign: "right" }}>
											{"2"}
										</span>
										<span style={{ whiteSpace: "nowrap" }}></span>
									</div>
									<div
										style={{
											display: "grid",
											gridTemplateColumns: "26px minmax(0,1fr)",
											gap: "16px",
											minHeight: "1.8em",
										}}
									>
										<span style={{ color: "#57534E", textAlign: "right" }}>
											{"3"}
										</span>
										<span style={{ whiteSpace: "nowrap" }}>
											<span style={{ color: "#93C5FD" }}>{"const"}</span>
											{" lix = "}
											<span style={{ color: "#93C5FD" }}>{"await"}</span>
											{" openLix({"}
										</span>
									</div>
									<div
										style={{
											display: "grid",
											gridTemplateColumns: "26px minmax(0,1fr)",
											gap: "16px",
											minHeight: "1.8em",
										}}
									>
										<span style={{ color: "#57534E", textAlign: "right" }}>
											{"4"}
										</span>
										<span style={{ whiteSpace: "nowrap" }}>
											<span style={{ paddingLeft: "2ch" }}>
												{"server: "}
												<span style={{ color: "#A8D8B9" }}>
													{'"https://lixray.com/acme/home"'}
												</span>
												{","}
											</span>
										</span>
									</div>
									<div
										style={{
											display: "grid",
											gridTemplateColumns: "26px minmax(0,1fr)",
											gap: "16px",
											minHeight: "1.8em",
										}}
									>
										<span style={{ color: "#57534E", textAlign: "right" }}>
											{"5"}
										</span>
										<span style={{ whiteSpace: "nowrap" }}>{"});"}</span>
									</div>
									<div
										style={{
											display: "grid",
											gridTemplateColumns: "26px minmax(0,1fr)",
											gap: "16px",
											minHeight: "1.8em",
										}}
									>
										<span style={{ color: "#57534E", textAlign: "right" }}>
											{"6"}
										</span>
										<span style={{ whiteSpace: "nowrap" }}></span>
									</div>
									<div
										style={{
											display: "grid",
											gridTemplateColumns: "26px minmax(0,1fr)",
											gap: "16px",
											minHeight: "1.8em",
										}}
									>
										<span style={{ color: "#57534E", textAlign: "right" }}>
											{"7"}
										</span>
										<span style={{ whiteSpace: "nowrap" }}>
											<span style={{ color: "#93C5FD" }}>{"const"}</span>
											{" rows = "}
											<span style={{ color: "#93C5FD" }}>{"await"}</span>
											{" lix.execute("}
											<span style={{ color: "#A8D8B9" }}>{"`"}</span>
										</span>
									</div>
									<div
										style={{
											display: "grid",
											gridTemplateColumns: "26px minmax(0,1fr)",
											gap: "16px",
											minHeight: "1.8em",
										}}
									>
										<span style={{ color: "#57534E", textAlign: "right" }}>
											{"8"}
										</span>
										<span style={{ whiteSpace: "nowrap" }}>
											<span style={{ paddingLeft: "2ch" }}>
												<span style={{ color: "#F97316" }}>{"SELECT"}</span>
												{" name, city, plan"}
											</span>
										</span>
									</div>
									<div
										style={{
											display: "grid",
											gridTemplateColumns: "26px minmax(0,1fr)",
											gap: "16px",
											minHeight: "1.8em",
											background: "rgba(249,115,22,0.14)",
											boxShadow: "inset 2px 0 0 #F97316",
										}}
									>
										<span style={{ color: "#57534E", textAlign: "right" }}>
											{"9"}
										</span>
										<span style={{ whiteSpace: "nowrap" }}>
											<span style={{ paddingLeft: "2ch" }}>
												<span style={{ color: "#F97316" }}>{"FROM"}</span>
												{" customers"}
											</span>
										</span>
									</div>
									<div
										style={{
											display: "grid",
											gridTemplateColumns: "26px minmax(0,1fr)",
											gap: "16px",
											minHeight: "1.8em",
										}}
									>
										<span style={{ color: "#57534E", textAlign: "right" }}>
											{"10"}
										</span>
										<span style={{ whiteSpace: "nowrap" }}>
											<span style={{ paddingLeft: "2ch" }}>
												<span style={{ color: "#F97316" }}>{"ORDER BY"}</span>
												{" name"}
											</span>
										</span>
									</div>
									<div
										style={{
											display: "grid",
											gridTemplateColumns: "26px minmax(0,1fr)",
											gap: "16px",
											minHeight: "1.8em",
										}}
									>
										<span style={{ color: "#57534E", textAlign: "right" }}>
											{"11"}
										</span>
										<span style={{ whiteSpace: "nowrap" }}>
											<span style={{ color: "#A8D8B9" }}>{"`"}</span>
											{");"}
										</span>
									</div>
								</div>
							</div>
							<svg
								width="44"
								height="24"
								viewBox="0 0 44 24"
								fill="none"
								stroke="#E8590C"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
								style={{ flexShrink: "0", alignSelf: "center" }}
							>
								<path d="M2 12 H40 M32 4 L40 12 L32 20" />
							</svg>
							<div
								style={{
									display: "flex",
									flexDirection: "column",
									gap: "10px",
								}}
							>
								<div
									style={{
										background: "#FFFFFF",
										border: "1px solid #E2DCD3",
										borderRadius: "14px",
										overflow: "hidden",
										boxShadow: "0 12px 28px rgba(28,25,23,0.06)",
									}}
								>
									<div
										style={{
											display: "flex",
											alignItems: "center",
											gap: "8px",
											padding: "10px 14px",
											background: "#FAF9F7",
											borderBottom: "1px solid #EDEAE6",
										}}
									>
										<span
											style={{
												width: "9px",
												height: "9px",
												borderRadius: "50%",
												background: "#E2DCD3",
											}}
										></span>
										<span
											style={{
												width: "9px",
												height: "9px",
												borderRadius: "50%",
												background: "#E2DCD3",
											}}
										></span>
										<span
											style={{
												width: "9px",
												height: "9px",
												borderRadius: "50%",
												background: "#E2DCD3",
												marginRight: "6px",
											}}
										></span>
										<span
											style={{
												fontFamily: "ui-monospace, Menlo, monospace",
												fontSize: "12.5px",
												color: "#78716C",
											}}
										>
											{"lixray.com/acme/home"}
										</span>
									</div>
									<div
										style={{
											display: "flex",
											alignItems: "center",
											gap: "9px",
											padding: "14px 16px 10px",
											fontSize: "17px",
											fontWeight: "700",
										}}
									>
										<svg
											width="16"
											height="16"
											viewBox="0 0 16 16"
											fill="none"
											stroke="#78716C"
											strokeWidth="1.3"
										>
											<rect x="1.5" y="2.5" width="13" height="11" rx="1.8" />
											<path d="M1.5 6.3 h13 M6 6.3 v7.2" />
										</svg>
										{"customers"}
									</div>
									<div
										style={{
											display: "grid",
											gridTemplateColumns: "minmax(0,1.3fr) minmax(0,1fr) 60px",
											gap: "10px",
											padding: "8px 16px",
											borderTop: "1px solid #EDEAE6",
											fontSize: "12.5px",
											color: "#8A8178",
										}}
									>
										<span>{"name"}</span>
										<span>{"city"}</span>
										<span>{"plan"}</span>
									</div>
									<div
										style={{
											display: "grid",
											gridTemplateColumns: "minmax(0,1.3fr) minmax(0,1fr) 60px",
											gap: "10px",
											padding: "10px 16px",
											borderTop: "1px solid #EDEAE6",
											fontSize: "14px",
											alignItems: "center",
										}}
									>
										<span>{"Acme"}</span>
										<span style={{ color: "#57534E" }}>{"Hamburg"}</span>
										<span
											style={{
												justifySelf: "start",
												background: "#E7F3EB",
												color: "#1F6B40",
												padding: "1px 10px",
												borderRadius: "99px",
												fontSize: "12.5px",
											}}
										>
											{"paid"}
										</span>
									</div>
									<div
										style={{
											display: "grid",
											gridTemplateColumns: "minmax(0,1.3fr) minmax(0,1fr) 60px",
											gap: "10px",
											padding: "10px 16px",
											borderTop: "1px solid #EDEAE6",
											fontSize: "14px",
											alignItems: "center",
										}}
									>
										<span>{"Bluebird Caf\u00e9"}</span>
										<span style={{ color: "#57534E" }}>{"Lisbon"}</span>
										<span
											style={{
												justifySelf: "start",
												background: "#FDEBD3",
												color: "#B54708",
												padding: "1px 10px",
												borderRadius: "99px",
												fontSize: "12.5px",
											}}
										>
											{"trial"}
										</span>
									</div>
									<div
										style={{
											display: "grid",
											gridTemplateColumns: "minmax(0,1.3fr) minmax(0,1fr) 60px",
											gap: "10px",
											padding: "10px 16px",
											borderTop: "1px solid #EDEAE6",
											fontSize: "14px",
											alignItems: "center",
										}}
									>
										<span>{"Northwind"}</span>
										<span style={{ color: "#57534E" }}>{"Berlin"}</span>
										<span
											style={{
												justifySelf: "start",
												background: "#E7F3EB",
												color: "#1F6B40",
												padding: "1px 10px",
												borderRadius: "99px",
												fontSize: "12.5px",
											}}
										>
											{"paid"}
										</span>
									</div>
								</div>
							</div>
						</div>
						<div
							style={{
								display: "flex",
								flexDirection: "column",
								gap: "16px",
								paddingTop: "28px",
							}}
						>
							<span
								style={{
									fontFamily: "ui-monospace, Menlo, monospace",
									fontSize: "13px",
									fontWeight: "700",
									letterSpacing: "0.1em",
									color: "#78716C",
								}}
							>
								{"EXAMPLES"}
							</span>
							<ExampleCards />
						</div>
					</div>
				</div>
			</main>
			<SiteFooter />
		</div>
	);
}
