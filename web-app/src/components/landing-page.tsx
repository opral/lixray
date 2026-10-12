import { useState } from "react";
import { highlightDocsCode } from "~/lib/docs-highlight";
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
/* Reference palette belongs to this marketing surface, independently of editor themes. */
[data-lr="landing-page"] {
 --landing-bg: #F3F1ED; /* token-literal: supplied landing reference palette */
 --landing-panel: #FFFFFF; /* token-literal: supplied landing reference palette */
 --landing-panel-muted: #FAF9F7; /* token-literal: supplied landing reference palette */
 --landing-border: #E2DCD3; /* token-literal: supplied landing reference palette */
 --landing-divider: #EDEAE6; /* token-literal: supplied landing reference palette */
 --landing-fg: #1C1917; /* token-literal: supplied landing reference palette */
 --landing-muted: #44403C; /* token-literal: supplied landing reference palette */
 --landing-subtle: #78716C; /* token-literal: supplied landing reference palette */
 --landing-faint: #A8A29E; /* token-literal: supplied landing reference palette */
 --landing-accent: #E8590C; /* token-literal: supplied landing reference palette */
 --landing-success-bg: #E7F3EB; /* token-literal: supplied landing reference palette */
 --landing-success-fg: #1F6B40; /* token-literal: supplied landing reference palette */
 --landing-warning-bg: #FDEBD3; /* token-literal: supplied landing reference palette */
 --landing-warning-fg: #B54708; /* token-literal: supplied landing reference palette */
 --landing-code-bg: #1C1917; /* token-literal: supplied code reference palette */
 --landing-code-header: #292524; /* token-literal: supplied code reference palette */
 --landing-code-border: #3A3531; /* token-literal: supplied code reference palette */
 --landing-code-text: #F3F1ED; /* token-literal: supplied code reference palette */
 --landing-code-line: #57534E; /* token-literal: supplied code reference palette */
 --landing-code-keyword: #93C5FD; /* token-literal: supplied syntax reference palette */
 --landing-code-string: #A8D8B9; /* token-literal: supplied syntax reference palette */
 --landing-code-sql: #F97316; /* token-literal: supplied syntax reference palette */
 --landing-code-highlight: rgba(249,115,22,.14); /* token-literal: supplied highlighted SQL row */
 --landing-code-shadow: rgba(28,25,23,.16); /* token-literal: reference elevation outside editor theme */
}
.landing-code code { font-family: inherit; font-weight: inherit; }
.landing-code .tok-keyword { color: var(--landing-code-keyword); }
.landing-code .tok-string, .landing-code .tok-string2 { color: var(--landing-code-string); }
.landing-code .landing-sql .tok-keyword { color: var(--landing-code-sql); }
.landing-code .landing-code-row { display:grid; grid-template-columns:26px minmax(0,1fr); gap:16px; min-height:1.8em; }
.landing-code .landing-line-number { color:var(--landing-code-line); text-align:right; user-select:none; }
.landing-code .landing-source-line { white-space:pre; }
.landing-code .landing-code-row[data-emphasis="true"] { background:var(--landing-code-highlight); box-shadow:inset 2px 0 0 var(--landing-code-sql); }

[data-lr="root"] a { color: var(--landing-fg); }
[data-lr="root"] a:hover { color: var(--landing-accent); }
@media (max-width: 860px) {
	[data-lr="root"] { padding: 40px 20px 56px !important; gap: 56px !important; }
	[data-lr="root"] h1 { font-size: 40px !important; }
	[data-lr="root"] > :first-child a { white-space: nowrap; }
	[data-lr="mock"] { grid-template-columns: minmax(0, 1fr) !important; }
	[data-lr="mock"] > :first-child { display: none !important; }
	[data-lr="hooks"] { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
	[data-lr="hooks"] > * { grid-column: auto !important; }
	[data-lr="hooks"] > :last-child { grid-column: 1 / -1 !important; }
	[data-lr="hack"] { grid-template-columns: minmax(0, 1fr) !important; }
	[data-lr="hack"] > :nth-child(2) { justify-self: center; transform: rotate(90deg); }
	[data-lr="hack"] > :first-child { overflow-x: auto !important; }
	[data-lr="hack"] > :first-child > :first-child > :first-child { white-space: nowrap; font-size: 14px !important; }
	[data-lr="cases"] { grid-template-columns: minmax(0, 1fr) !important; }
	[data-lr="cmp"] { overflow-x: auto !important; }
	[data-lr="cmp-row"] { min-width: 760px; }
}
`;

type CompareCell = true | false | string;

const compareColumns = [
	"Notion",
	"Google Drive",
	"ChatGPT / Claude Projects",
	"git + SQLite",
];

// Cells are claims about other products. Keep them conservative.
const compareRows: { label: string; cells: CompareCell[] }[] = [
	{ label: "Open source", cells: [false, false, false, true] },
	{
		label: "Files in any format",
		cells: ["Attachments", true, "Uploads", true],
	},
	{
		label: "Tables you can query with SQL",
		cells: ["API, no SQL", "Sheets, no SQL", false, true],
	},
	{
		label: "Version control for files and rows",
		cells: ["Page history", "File versions", false, "Files, not rows"],
	},
	{
		label: "Same data for every agent",
		cells: ["MCP + API", "Via connectors", "One vendor", "Local files"],
	},
];

const compareGrid = "minmax(0,1.6fr) repeat(5, minmax(0,1fr))";
const compareCell = {
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	textAlign: "center",
} as const;

function CompareMark({ value }: { value: CompareCell }) {
	if (value === true) {
		return (
			<svg width="18" height="18" viewBox="0 0 22 22" aria-label="Yes">
				<circle cx="11" cy="11" r="11" fill="var(--atelier-success)" />
				<path
					d="M6.6 11.3 l3 3 l5.8 -6.3"
					fill="none"
					stroke="var(--landing-panel)"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			</svg>
		);
	}
	if (value === false) {
		return (
			<span
				aria-label="No"
				style={{
					color: "var(--landing-faint)",
					fontSize: "18px",
					lineHeight: "1",
				}}
			>
				{"\u2013"}
			</span>
		);
	}
	return (
		<span style={{ fontSize: "13.5px", color: "var(--landing-subtle)" }}>
			{value}
		</span>
	);
}

function CompareTable() {
	return (
		<div
			data-lr="cmp"
			style={{
				background: "var(--landing-panel)",
				border: "1px solid var(--landing-border)",
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
					background: "var(--landing-panel-muted)",
					fontSize: "14.5px",
					fontWeight: "600",
					color: "var(--landing-muted)",
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
						borderTop: "1px solid var(--landing-divider)",
						fontSize: "15px",
						alignItems: "center",
					}}
				>
					<span>{row.label}</span>
					<span style={compareCell}>
						<CompareMark value />
					</span>
					{row.cells.map((cell, index) => (
						<span key={compareColumns[index]} style={compareCell}>
							<CompareMark value={cell} />
						</span>
					))}
				</div>
			))}
		</div>
	);
}

export function LandingPage() {
	const { user, repositoryTo } = useRepositoryCta();
	const ctaLabel = user ? "Open LixRay" : "Create a repository";
	const [installCopied, setInstallCopied] = useState(false);
	const copyInstall = async () => {
		await navigator.clipboard.writeText("npm install @lix-js/sdk");
		setInstallCopied(true);
		window.setTimeout(() => setInstallCopied(false), 1500);
	};
	const sdkExample = [
		'import { openLix } from "@lix-js/sdk";',
		"",
		"const lix = await openLix({",
		"  server: { url, headers },",
		"});",
		"",
		"const rows = await lix.execute(`",
		"  SELECT name, city, plan",
		"  FROM customers",
		"  ORDER BY name",
		"`);",
	];

	return (
		<div
			data-lr="landing-page"
			style={{
				minHeight: "100vh",
				colorScheme: "light",
				background: "var(--landing-bg)",
			}}
		>
			<style>{landingCss}</style>
			<SiteHeader />
			<main>
				<div
					data-lr="root"
					style={{
						background: "var(--landing-bg)",
						maxWidth: "1040px",
						margin: "0 auto",
						boxSizing: "border-box",
						fontFamily:
							"-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
						color: "var(--landing-fg)",
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
							{"Shared repository for you and every AI agent you use."}
						</h1>
						<p
							style={{
								margin: "0",
								fontSize: "19px",
								lineHeight: "1.6",
								color: "var(--landing-muted)",
								textWrap: "pretty",
								maxWidth: "680px",
							}}
						>
							{
								"Files and SQL tables in one open-source repo. Claude, ChatGPT, Codex, and your scripts read and write the same data."
							}
						</p>
						<div
							style={{
								display: "flex",
								flexWrap: "wrap",
								alignItems: "center",
								gap: "20px",
							}}
						>
							<a
								href={repositoryTo}
								style={{
									fontSize: "17px",
									fontWeight: "700",
									color: "var(--landing-panel)",
									background: "var(--atelier-accent-gradient)",
									boxShadow: "var(--atelier-shadow-accent)",
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
								style={{
									display: "inline-flex",
									alignItems: "center",
									gap: "8px",
									fontSize: "16px",
									fontWeight: "600",
								}}
							>
								<img
									src="/landing/brand-github.svg"
									alt=""
									style={{ width: "18px", height: "18px", flexShrink: 0 }}
								/>
								{"View on GitHub"}
							</a>
						</div>
					</div>
					<div
						style={{
							background: "var(--landing-panel)",
							border: "1px solid var(--landing-border)",
							borderRadius: "16px",
							boxShadow:
								"0 12px 32px color-mix(in srgb, var(--landing-fg) 7%, transparent)",
							overflow: "hidden",
						}}
					>
						<div
							style={{
								display: "flex",
								alignItems: "center",
								gap: "8px",
								padding: "12px 16px",
								background: "var(--landing-panel-muted)",
								borderBottom: "1px solid var(--landing-divider)",
							}}
						>
							<span
								style={{
									width: "11px",
									height: "11px",
									borderRadius: "50%",
									background: "var(--landing-border)",
								}}
							></span>
							<span
								style={{
									width: "11px",
									height: "11px",
									borderRadius: "50%",
									background: "var(--landing-border)",
								}}
							></span>
							<span
								style={{
									width: "11px",
									height: "11px",
									borderRadius: "50%",
									background: "var(--landing-border)",
									marginRight: "8px",
								}}
							></span>
							<span
								style={{
									fontFamily: "ui-monospace, Menlo, monospace",
									fontSize: "13.5px",
									color: "var(--landing-subtle)",
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
									borderRight: "1px solid var(--landing-divider)",
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
										background: "var(--landing-bg)",
										fontWeight: "600",
									}}
								>
									<svg
										width="16"
										height="16"
										viewBox="0 0 16 16"
										fill="none"
										stroke="var(--landing-fg)"
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
										color: "var(--landing-muted)",
									}}
								>
									<svg
										width="16"
										height="16"
										viewBox="0 0 16 16"
										fill="none"
										stroke="var(--landing-subtle)"
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
										color: "var(--landing-muted)",
									}}
								>
									<svg
										width="16"
										height="16"
										viewBox="0 0 16 16"
										fill="none"
										stroke="var(--landing-subtle)"
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
										color: "var(--landing-muted)",
									}}
								>
									<svg
										width="16"
										height="16"
										viewBox="0 0 16 16"
										fill="none"
										stroke="var(--landing-subtle)"
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
										color: "var(--landing-subtle)",
									}}
								>
									{"SOURCES"}
									<span
										style={{
											marginLeft: "8px",
											padding: "1px 7px",
											borderRadius: "99px",
											background: "var(--atelier-accent-subtle)",
											color: "var(--landing-accent)",
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
										<path
											d="M5.5 1.5h5l4.5 8h-5z"
											fill="#FBBC04" /* token-literal: Google Drive brand mark */
										/>
										<path
											d="M5.5 1.5L1 9.5l2.5 4.3L8 5.8z"
											fill="#0F9D58" /* token-literal: Google Drive brand mark */
										/>
										<path
											d="M3.5 13.8h9.5l2-4.3H5.8z"
											fill="#4285F4" /* token-literal: Google Drive brand mark */
										/>
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
											fill="var(--landing-panel)"
											stroke="var(--landing-fg)"
											strokeWidth="1.3"
										/>
										<path
											d="M5.2 11.5 V4.6 l5.8 6.9 V4.5"
											fill="none"
											stroke="var(--landing-fg)"
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
										color: "var(--landing-subtle)",
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
										color: "var(--landing-subtle)",
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
											background: "var(--landing-fg)",
											color: "var(--landing-panel)",
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
										borderBottom: "1px solid var(--landing-divider)",
										fontSize: "13.5px",
										color: "var(--landing-subtle)",
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
										borderBottom: "1px solid var(--landing-divider)",
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
											stroke="var(--landing-subtle)"
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
										{"You"}
									</span>
								</div>
								<div
									style={{
										display: "flex",
										justifyContent: "space-between",
										alignItems: "center",
										padding: "7px 0",
										borderBottom: "1px solid var(--landing-divider)",
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
											stroke="var(--landing-subtle)"
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
										{"You"}
									</span>
								</div>
								<div
									style={{
										display: "flex",
										justifyContent: "space-between",
										alignItems: "center",
										padding: "7px 0",
										borderBottom: "1px solid var(--landing-divider)",
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
										{"You"}
									</span>
								</div>
								<div
									style={{
										display: "flex",
										justifyContent: "space-between",
										alignItems: "center",
										padding: "7px 0",
										borderBottom: "1px solid var(--landing-divider)",
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
										{"You"}
									</span>
								</div>
								<div
									style={{
										display: "flex",
										justifyContent: "space-between",
										alignItems: "center",
										padding: "7px 0",
										borderBottom: "1px solid var(--landing-divider)",
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
												fill="#21A366" /* token-literal: Excel brand mark */
											/>
											<rect
												x="1"
												y="4"
												width="9"
												height="8"
												rx="1.3"
												fill="#107C41" /* token-literal: Excel brand mark */
											/>
											<path
												d="M3.3 6 l4 4 M7.3 6 l-4 4"
												stroke="var(--landing-panel)"
												strokeWidth="1.2"
												strokeLinecap="round"
											/>
										</svg>
										{"budget.xlsx"}
									</span>
									<span style={{ color: "var(--landing-muted)" }}>{"You"}</span>
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
									<span style={{ color: "var(--landing-muted)" }}>{"You"}</span>
								</div>
								<div
									style={{
										marginTop: "6px",
										border: "1px solid var(--landing-border)",
										borderRadius: "14px",
										background: "var(--landing-panel-muted)",
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
										<span>
											<b>{"You"}</b>
											{" changed 1 row in customers"}
										</span>
									</span>
									<div
										style={{
											flex: "1",
											minWidth: "150px",
											background: "var(--landing-panel)",
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
												color: "var(--landing-subtle)",
												paddingBottom: "4px",
												borderBottom: "1px solid var(--landing-divider)",
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
														background: "var(--atelier-danger-subtle)",
														color: "var(--atelier-danger)",
														textDecoration: "line-through",
														padding: "0 4px",
														borderRadius: "3px",
													}}
												>
													{"trial"}
												</span>{" "}
												<span
													style={{
														background: "var(--landing-success-bg)",
														color: "var(--landing-success-fg)",
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
												background: "var(--landing-fg)",
												color: "var(--landing-panel)",
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
												border: "1px solid var(--landing-border)",
												background: "var(--landing-panel)",
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
							<svg
								width="24"
								height="24"
								viewBox="0 0 20 20"
								fill="none"
								stroke="var(--landing-fg)"
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
									color: "var(--landing-muted)",
									textWrap: "pretty",
								}}
							>
								{"Self-host the Lix server, or embed Lix in your product."}
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
								stroke="var(--landing-fg)"
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
									color: "var(--landing-muted)",
									textWrap: "pretty",
								}}
							>
								{"Store any file as is. Markdown and CSV diff row by row."}
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
								stroke="var(--landing-fg)"
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
									color: "var(--landing-muted)",
									textWrap: "pretty",
								}}
							>
								{
									"Store customers, orders, or any other rows. Query them with SQL."
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
								stroke="var(--landing-fg)"
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
									color: "var(--landing-muted)",
									textWrap: "pretty",
								}}
							>
								{"Branch, diff, and roll back files and rows."}
							</span>
						</div>
						<div
							style={{
								gridColumn: "span 4",
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
									<path
										d="M5.5 1.5h5l4.5 8h-5z"
										fill="#FBBC04" /* token-literal: Google Drive brand mark */
									/>
									<path
										d="M5.5 1.5L1 9.5l2.5 4.3L8 5.8z"
										fill="#0F9D58" /* token-literal: Google Drive brand mark */
									/>
									<path
										d="M3.5 13.8h9.5l2-4.3H5.8z"
										fill="#4285F4" /* token-literal: Google Drive brand mark */
									/>
								</svg>
								<svg width="22" height="22" viewBox="0 0 16 16">
									<rect
										x="1.5"
										y="1.5"
										width="13"
										height="13"
										rx="2.5"
										fill="var(--landing-panel)"
										stroke="var(--landing-fg)"
										strokeWidth="1.3"
									/>
									<path
										d="M5.2 11.5 V4.6 l5.8 6.9 V4.5"
										fill="none"
										stroke="var(--landing-fg)"
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
								<span
									style={{
										fontSize: "14px",
										color: "var(--landing-subtle)",
									}}
								>
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
										color: "var(--landing-warning-fg)",
										background: "var(--landing-warning-bg)",
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
									color: "var(--landing-muted)",
									textWrap: "pretty",
								}}
							>
								{
									"Mount Drive, Notion, and Granola in the repo. Agents then work from one place."
								}
							</span>
						</div>
					</div>
					<div
						style={{
							display: "flex",
							flexDirection: "column",
							gap: "28px",
							paddingTop: "56px",
							borderTop: "1px solid var(--atelier-border-strong)",
						}}
					>
						<div
							style={{ display: "flex", flexDirection: "column", gap: "12px" }}
						>
							<h3
								style={{
									margin: "0",
									fontSize: "34px",
									lineHeight: "1.2",
									fontWeight: "700",
									letterSpacing: "-0.02em",
								}}
							>
								{"Build on top"}
							</h3>
							<p
								style={{
									margin: "0",
									fontSize: "18px",
									lineHeight: "1.65",
									color: "var(--landing-muted)",
									textWrap: "pretty",
									maxWidth: "740px",
								}}
							>
								{"LixRay is built on "}
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
											fill="#08B5D6" /* token-literal: Lix brand mark */
										/>
										<path
											d="M6.16211 17.5081V5.74805H9.42368V17.5081H6.16211Z"
											fill="#08B5D6" /* token-literal: Lix brand mark */
										/>
										<path
											d="M3.52112 0.393555V17.6416H0.287109V0.393555H3.52112Z"
											fill="#08B5D6" /* token-literal: Lix brand mark */
										/>
										<path
											d="M6.21582 0.393555H14.8399V3.08856H6.21582V0.393555Z"
											fill="#08B5D6" /* token-literal: Lix brand mark */
										/>
									</svg>
								</a>
								{
									", an open source engine for files, tables, and version control. Everything is queryable with SQL. The LixRay UI, agents, and your own code all use the same API."
								}
							</p>
						</div>
						<div
							data-lr="hack"
							style={{
								display: "grid",
								gridTemplateColumns: "minmax(0,1.44fr) 44px minmax(0,1fr)",
								gap: "14px",
								alignItems: "center",
							}}
						>
							<div
								style={{
									background: "var(--landing-code-bg)",
									borderRadius: "14px",
									overflow: "hidden",
									boxShadow: "0 16px 36px var(--landing-code-shadow)",
								}}
							>
								<div
									style={{
										display: "flex",
										alignItems: "center",
										justifyContent: "space-between",
										gap: "12px",
										flexWrap: "wrap",
										padding: "14px 20px",
										background: "var(--landing-code-header)",
										borderBottom: "1px solid var(--landing-code-border)",
									}}
								>
									<span
										style={{
											fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
											fontSize: "16px",
											lineHeight: "1.2",
											color: "var(--landing-code-text)",
										}}
									>
										<span style={{ color: "var(--landing-subtle)" }}>
											{"$ "}
										</span>
										{"npm install @lix-js/sdk"}
									</span>
									<button
										type="button"
										aria-label="Copy installation command"
										onClick={() => void copyInstall()}
										style={{
											fontSize: "13px",
											lineHeight: "1.2",
											border: 0,
											cursor: "pointer",
											fontWeight: "600",
											color: "var(--landing-code-bg)",
											background: "var(--landing-bg)",
											padding: "5px 12px",
											borderRadius: "7px",
										}}
									>
										{installCopied ? "Copied" : "Copy"}
									</button>
								</div>
								<pre
									className="landing-code"
									aria-label="Authenticated Lix SDK example"
									style={{
										margin: 0,
										padding: "18px 20px 20px 8px",
										overflowX: "auto",
										fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
										fontSize: "14px",
										lineHeight: "1.8",
										color: "var(--landing-code-text)",
									}}
								>
									<code>
										{sdkExample.map((line, index) => (
											<span
												key={index}
												className={`landing-code-row${index >= 7 && index <= 9 ? " landing-sql" : ""}`}
												data-emphasis={index === 8 ? "true" : undefined}
											>
												<span
													className="landing-line-number"
													aria-hidden="true"
												>
													{index + 1}
												</span>
												<span
													className="landing-source-line"
													dangerouslySetInnerHTML={{
														__html:
															index === 10
																? '<span class="tok-string">`</span>);'
																: highlightDocsCode(
																		line,
																		index >= 7 && index <= 9 ? "sql" : "js",
																	),
													}}
												/>
											</span>
										))}
									</code>
								</pre>
							</div>
							<svg
								width="44"
								height="24"
								viewBox="0 0 44 24"
								fill="none"
								stroke="var(--landing-code-sql)"
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
										background: "var(--landing-panel)",
										border: "1px solid var(--landing-border)",
										borderRadius: "14px",
										overflow: "hidden",
										boxShadow:
											"0 12px 28px color-mix(in srgb, var(--landing-fg) 6%, transparent)",
									}}
								>
									<div
										style={{
											display: "flex",
											alignItems: "center",
											gap: "8px",
											padding: "10px 14px",
											background: "var(--landing-panel-muted)",
											borderBottom: "1px solid var(--landing-divider)",
										}}
									>
										<span
											style={{
												width: "9px",
												height: "9px",
												borderRadius: "50%",
												background: "var(--landing-border)",
											}}
										></span>
										<span
											style={{
												width: "9px",
												height: "9px",
												borderRadius: "50%",
												background: "var(--landing-border)",
											}}
										></span>
										<span
											style={{
												width: "9px",
												height: "9px",
												borderRadius: "50%",
												background: "var(--landing-border)",
												marginRight: "6px",
											}}
										></span>
										<span
											style={{
												fontFamily: "ui-monospace, Menlo, monospace",
												lineHeight: "14px",
												fontSize: "12.5px",
												color: "var(--landing-subtle)",
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
											lineHeight: "1.2",
											fontWeight: "700",
										}}
									>
										<svg
											width="16"
											height="16"
											viewBox="0 0 16 16"
											fill="none"
											stroke="var(--landing-subtle)"
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
											borderTop: "1px solid var(--landing-divider)",
											fontSize: "12.5px",
											lineHeight: "14.5px",
											color: "var(--landing-subtle)",
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
											borderTop: "1px solid var(--landing-divider)",
											fontSize: "14px",
											lineHeight: "16.5px",
											alignItems: "center",
										}}
									>
										<span>{"Acme"}</span>
										<span style={{ color: "var(--landing-muted)" }}>
											{"Hamburg"}
										</span>
										<span
											style={{
												justifySelf: "start",
												background: "var(--landing-success-bg)",
												color: "var(--landing-success-fg)",
												padding: "1px 10px",
												borderRadius: "99px",
												lineHeight: "14.5px",
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
											borderTop: "1px solid var(--landing-divider)",
											fontSize: "14px",
											lineHeight: "16.5px",
											alignItems: "center",
										}}
									>
										<span>{"Bluebird Caf\u00e9"}</span>
										<span style={{ color: "var(--landing-muted)" }}>
											{"Lisbon"}
										</span>
										<span
											style={{
												justifySelf: "start",
												background: "var(--landing-warning-bg)",
												color: "var(--landing-warning-fg)",
												padding: "1px 10px",
												borderRadius: "99px",
												lineHeight: "14.5px",
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
											borderTop: "1px solid var(--landing-divider)",
											fontSize: "14px",
											lineHeight: "16.5px",
											alignItems: "center",
										}}
									>
										<span>{"Northwind"}</span>
										<span style={{ color: "var(--landing-muted)" }}>
											{"Berlin"}
										</span>
										<span
											style={{
												justifySelf: "start",
												background: "var(--landing-success-bg)",
												color: "var(--landing-success-fg)",
												padding: "1px 10px",
												borderRadius: "99px",
												lineHeight: "14.5px",
												fontSize: "12.5px",
											}}
										>
											{"paid"}
										</span>
									</div>
								</div>
							</div>
						</div>
						<p
							data-lr="sdk-connection-note"
							style={{
								margin: "-12px 0 0",
								fontSize: "12px",
								lineHeight: "1.5",
								color: "var(--landing-subtle)",
							}}
						>
							Set <code>url</code> and <code>headers</code> using your{" "}
							<a href="/docs/access-tokens">repository connection settings</a>.
						</p>
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
									color: "var(--landing-subtle)",
								}}
							>
								{"EXAMPLES"}
							</span>
							<div
								data-lr="cases"
								style={{
									display: "grid",
									gridTemplateColumns: "repeat(3, minmax(0,1fr))",
									gap: "16px",
								}}
							>
								<div
									style={{
										background: "var(--landing-panel)",
										border: "1px solid var(--landing-border)",
										borderRadius: "16px",
										overflow: "hidden",
										display: "flex",
										flexDirection: "column",
									}}
								>
									<div
										style={{
											background: "var(--atelier-accent-subtle)",
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
											<span style={{ display: "flex", gap: "4px" }}>
												<svg width="24" height="24" viewBox="0 0 28 28">
													<rect
														width="28"
														height="28"
														rx="7"
														fill="#FC4C02" /* token-literal: Lix brand mark */
													/>
													<path
														d="M11.5 6 L6.5 16 h3.2 l1.8 -3.6 l1.8 3.6 h3.2 z"
														fill="var(--landing-panel)"
													/>
													<path
														d="M16.5 16 l-1.6 3.2 l-1.6 -3.2 h-2 l3.6 7 l3.6 -7 z"
														fill="var(--landing-warning-bg)"
													/>
												</svg>
											</span>
											<span style={{ color: "var(--landing-faint)" }}>
												{"\u2192"}
											</span>
											<span
												style={{
													display: "flex",
													alignItems: "center",
													gap: "5px",
													background: "var(--landing-panel)",
													border: "1px solid var(--landing-border)",
													borderRadius: "99px",
													padding: "2px 9px",
													fontFamily: "ui-monospace, Menlo, monospace",
													fontSize: "12px",
												}}
											>
												<svg
													width="12"
													height="12"
													viewBox="0 0 16 16"
													fill="none"
													stroke="var(--landing-subtle)"
													strokeWidth="1.3"
												>
													<rect
														x="1.5"
														y="2.5"
														width="13"
														height="11"
														rx="1.8"
													/>
													<path d="M1.5 6.3 h13 M6 6.3 v7.2" />
												</svg>
												{"runs"}
											</span>
										</div>
										<div
											style={{
												flex: "1",
												display: "flex",
												alignItems: "flex-end",
												gap: "14px",
											}}
										>
											<svg
												width="72"
												height="66"
												viewBox="0 0 72 66"
												shapeRendering="crispEdges"
												style={{ display: "block", flexShrink: "0" }}
											>
												<rect
													x="24"
													y="0"
													width="6"
													height="6"
													fill="var(--landing-fg)"
												/>
												<rect
													x="30"
													y="0"
													width="6"
													height="6"
													fill="var(--landing-fg)"
												/>
												<rect
													x="36"
													y="0"
													width="6"
													height="6"
													fill="var(--landing-fg)"
												/>
												<rect
													x="24"
													y="6"
													width="6"
													height="6"
													fill="var(--landing-fg)"
												/>
												<rect
													x="30"
													y="6"
													width="6"
													height="6"
													fill="var(--landing-fg)"
												/>
												<rect
													x="36"
													y="6"
													width="6"
													height="6"
													fill="var(--landing-fg)"
												/>
												<rect
													x="30"
													y="12"
													width="6"
													height="6"
													fill="var(--atelier-tag-brown)"
												/>
												<rect
													x="18"
													y="18"
													width="6"
													height="6"
													fill="#FC4C02" /* token-literal: Lix brand mark */
												/>
												<rect
													x="24"
													y="18"
													width="6"
													height="6"
													fill="#FC4C02" /* token-literal: Lix brand mark */
												/>
												<rect
													x="30"
													y="18"
													width="6"
													height="6"
													fill="#FC4C02" /* token-literal: Lix brand mark */
												/>
												<rect
													x="36"
													y="18"
													width="6"
													height="6"
													fill="#FC4C02" /* token-literal: Lix brand mark */
												/>
												<rect
													x="12"
													y="24"
													width="6"
													height="6"
													fill="#FC4C02" /* token-literal: Lix brand mark */
												/>
												<rect
													x="24"
													y="24"
													width="6"
													height="6"
													fill="#FC4C02" /* token-literal: Lix brand mark */
												/>
												<rect
													x="30"
													y="24"
													width="6"
													height="6"
													fill="#FC4C02" /* token-literal: Lix brand mark */
												/>
												<rect
													x="36"
													y="24"
													width="6"
													height="6"
													fill="#FC4C02" /* token-literal: Lix brand mark */
												/>
												<rect
													x="48"
													y="24"
													width="6"
													height="6"
													fill="var(--atelier-tag-brown)"
												/>
												<rect
													x="6"
													y="30"
													width="6"
													height="6"
													fill="var(--atelier-tag-brown)"
												/>
												<rect
													x="24"
													y="30"
													width="6"
													height="6"
													fill="#FC4C02" /* token-literal: Lix brand mark */
												/>
												<rect
													x="30"
													y="30"
													width="6"
													height="6"
													fill="#FC4C02" /* token-literal: Lix brand mark */
												/>
												<rect
													x="36"
													y="30"
													width="6"
													height="6"
													fill="#FC4C02" /* token-literal: Lix brand mark */
												/>
												<rect
													x="24"
													y="36"
													width="6"
													height="6"
													fill="#FC4C02" /* token-literal: Lix brand mark */
												/>
												<rect
													x="30"
													y="36"
													width="6"
													height="6"
													fill="#FC4C02" /* token-literal: Lix brand mark */
												/>
												<rect
													x="36"
													y="36"
													width="6"
													height="6"
													fill="#FC4C02" /* token-literal: Lix brand mark */
												/>
												<rect
													x="24"
													y="42"
													width="6"
													height="6"
													fill="var(--landing-fg)"
												/>
												<rect
													x="30"
													y="42"
													width="6"
													height="6"
													fill="var(--landing-fg)"
												/>
												<rect
													x="36"
													y="42"
													width="6"
													height="6"
													fill="var(--landing-fg)"
												/>
												<rect
													x="42"
													y="42"
													width="6"
													height="6"
													fill="var(--landing-fg)"
												/>
												<rect
													x="18"
													y="48"
													width="6"
													height="6"
													fill="var(--landing-fg)"
												/>
												<rect
													x="24"
													y="48"
													width="6"
													height="6"
													fill="var(--landing-fg)"
												/>
												<rect
													x="42"
													y="48"
													width="6"
													height="6"
													fill="var(--landing-fg)"
												/>
												<rect
													x="48"
													y="48"
													width="6"
													height="6"
													fill="var(--landing-fg)"
												/>
												<rect
													x="12"
													y="54"
													width="6"
													height="6"
													fill="var(--landing-fg)"
												/>
												<rect
													x="18"
													y="54"
													width="6"
													height="6"
													fill="var(--landing-fg)"
												/>
												<rect
													x="48"
													y="54"
													width="6"
													height="6"
													fill="var(--landing-fg)"
												/>
												<rect
													x="6"
													y="60"
													width="6"
													height="6"
													fill="var(--landing-fg)"
												/>
												<rect
													x="12"
													y="60"
													width="6"
													height="6"
													fill="var(--landing-fg)"
												/>
												<rect
													x="48"
													y="60"
													width="6"
													height="6"
													fill="var(--landing-fg)"
												/>
												<rect
													x="54"
													y="60"
													width="6"
													height="6"
													fill="var(--landing-fg)"
												/>
											</svg>
											<div
												style={{
													flex: "1",
													display: "flex",
													alignItems: "flex-end",
													justifyContent: "center",
													gap: "10px",
												}}
											>
												<div
													style={{
														display: "flex",
														flexDirection: "column",
														alignItems: "center",
														gap: "4px",
													}}
												>
													<span
														style={{
															fontFamily: "ui-monospace, Menlo, monospace",
															fontSize: "11px",
														}}
													>
														{"8.2"}
													</span>
													<div
														style={{
															display: "flex",
															flexDirection: "column",
															gap: "2px",
														}}
													>
														<span
															style={{
																display: "block",
																width: "16px",
																height: "6px",
																background: "#FC4C02", // token-literal: Lix brand mark
															}}
														></span>
														<span
															style={{
																display: "block",
																width: "16px",
																height: "6px",
																background: "#FC4C02", // token-literal: Lix brand mark
															}}
														></span>
														<span
															style={{
																display: "block",
																width: "16px",
																height: "6px",
																background: "#FC4C02", // token-literal: Lix brand mark
															}}
														></span>
													</div>
													<span
														style={{
															fontFamily: "ui-monospace, Menlo, monospace",
															fontSize: "10.5px",
															color: "var(--landing-subtle)",
														}}
													>
														{"Mon"}
													</span>
												</div>
												<div
													style={{
														display: "flex",
														flexDirection: "column",
														alignItems: "center",
														gap: "4px",
													}}
												>
													<span
														style={{
															fontFamily: "ui-monospace, Menlo, monospace",
															fontSize: "11px",
														}}
													>
														{"10.1"}
													</span>
													<div
														style={{
															display: "flex",
															flexDirection: "column",
															gap: "2px",
														}}
													>
														<span
															style={{
																display: "block",
																width: "16px",
																height: "6px",
																background: "#FC4C02", // token-literal: Lix brand mark
															}}
														></span>
														<span
															style={{
																display: "block",
																width: "16px",
																height: "6px",
																background: "#FC4C02", // token-literal: Lix brand mark
															}}
														></span>
														<span
															style={{
																display: "block",
																width: "16px",
																height: "6px",
																background: "#FC4C02", // token-literal: Lix brand mark
															}}
														></span>
														<span
															style={{
																display: "block",
																width: "16px",
																height: "6px",
																background: "#FC4C02", // token-literal: Lix brand mark
															}}
														></span>
													</div>
													<span
														style={{
															fontFamily: "ui-monospace, Menlo, monospace",
															fontSize: "10.5px",
															color: "var(--landing-subtle)",
														}}
													>
														{"Wed"}
													</span>
												</div>
												<div
													style={{
														display: "flex",
														flexDirection: "column",
														alignItems: "center",
														gap: "4px",
													}}
												>
													<span
														style={{
															fontFamily: "ui-monospace, Menlo, monospace",
															fontSize: "11px",
														}}
													>
														{"21.0"}
													</span>
													<div
														style={{
															display: "flex",
															flexDirection: "column",
															gap: "2px",
														}}
													>
														<span
															style={{
																display: "block",
																width: "16px",
																height: "6px",
																background: "#FC4C02", // token-literal: Lix brand mark
															}}
														></span>
														<span
															style={{
																display: "block",
																width: "16px",
																height: "6px",
																background: "#FC4C02", // token-literal: Lix brand mark
															}}
														></span>
														<span
															style={{
																display: "block",
																width: "16px",
																height: "6px",
																background: "#FC4C02", // token-literal: Lix brand mark
															}}
														></span>
														<span
															style={{
																display: "block",
																width: "16px",
																height: "6px",
																background: "#FC4C02", // token-literal: Lix brand mark
															}}
														></span>
														<span
															style={{
																display: "block",
																width: "16px",
																height: "6px",
																background: "#FC4C02", // token-literal: Lix brand mark
															}}
														></span>
														<span
															style={{
																display: "block",
																width: "16px",
																height: "6px",
																background: "#FC4C02", // token-literal: Lix brand mark
															}}
														></span>
														<span
															style={{
																display: "block",
																width: "16px",
																height: "6px",
																background: "#FC4C02", // token-literal: Lix brand mark
															}}
														></span>
														<span
															style={{
																display: "block",
																width: "16px",
																height: "6px",
																background: "#FC4C02", // token-literal: Lix brand mark
															}}
														></span>
													</div>
													<span
														style={{
															fontFamily: "ui-monospace, Menlo, monospace",
															fontSize: "10.5px",
															color: "var(--landing-subtle)",
														}}
													>
														{"Sat"}
													</span>
												</div>
											</div>
										</div>
									</div>
									<div
										style={{
											padding: "14px 16px 16px",
											display: "flex",
											flexDirection: "column",
											gap: "5px",
											borderTop: "1px solid var(--landing-divider)",
											flex: "1",
										}}
									>
										<b style={{ fontSize: "16px" }}>{"Run log"}</b>
										<span
											style={{
												fontSize: "14px",
												lineHeight: "1.5",
												color: "var(--landing-muted)",
												textWrap: "pretty",
											}}
										>
											{
												"Your Strava runs in a table. Ask an agent how training is going."
											}
										</span>
									</div>
								</div>
								<div
									style={{
										background: "var(--landing-panel)",
										border: "1px solid var(--landing-border)",
										borderRadius: "16px",
										overflow: "hidden",
										display: "flex",
										flexDirection: "column",
									}}
								>
									<div
										style={{
											background: "var(--atelier-tag-blue)",
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
												gap: "6px",
											}}
										>
											<span
												style={{
													width: "24px",
													height: "24px",
													borderRadius: "6px",
													background: "var(--landing-panel)",
													border: "1px solid var(--landing-border)",
													display: "flex",
													alignItems: "center",
													justifyContent: "center",
													boxSizing: "border-box",
													flexShrink: "0",
												}}
											>
												<svg
													width="14"
													height="14"
													viewBox="0 0 16 16"
													fill="none"
													stroke="var(--landing-muted)"
													strokeWidth="1.3"
												>
													<circle cx="8" cy="8" r="6.2" />
													<path d="M1.8 8 h12.4 M8 1.8 c-2.8 3 -2.8 9.4 0 12.4 M8 1.8 c2.8 3 2.8 9.4 0 12.4" />
												</svg>
											</span>
											<span
												style={{
													display: "flex",
													alignItems: "center",
													gap: "5px",
													background: "var(--landing-panel)",
													border: "1px solid var(--landing-border)",
													borderRadius: "99px",
													padding: "2px 9px",
													fontFamily: "ui-monospace, Menlo, monospace",
													fontSize: "12px",
													whiteSpace: "nowrap",
												}}
											>
												{"listings"}
											</span>
											<span style={{ color: "var(--landing-faint)" }}>
												{"\u2192"}
											</span>
											<span
												style={{
													display: "flex",
													alignItems: "center",
													gap: "5px",
													background: "var(--landing-panel)",
													border: "1px solid var(--landing-border)",
													borderRadius: "99px",
													padding: "2px 9px",
													fontFamily: "ui-monospace, Menlo, monospace",
													fontSize: "12px",
													whiteSpace: "nowrap",
												}}
											>
												<svg
													width="12"
													height="12"
													viewBox="0 0 16 16"
													fill="none"
													stroke="var(--landing-subtle)"
													strokeWidth="1.3"
													style={{ flexShrink: "0" }}
												>
													<rect
														x="1.5"
														y="2.5"
														width="13"
														height="11"
														rx="1.8"
													/>
													<path d="M1.5 6.3 h13 M6 6.3 v7.2" />
												</svg>
												{"apartments"}
											</span>
										</div>
										<div
											style={{
												flex: "1",
												display: "flex",
												alignItems: "flex-end",
												justifyContent: "flex-start",
												gap: "14px",
											}}
										>
											<svg
												width="60"
												height="65"
												viewBox="0 0 60 65"
												shapeRendering="crispEdges"
												style={{ display: "block", flexShrink: "0" }}
											>
												<rect
													x="25"
													y="0"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="30"
													y="0"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="20"
													y="5"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="25"
													y="5"
													width="5"
													height="5"
													fill="var(--atelier-danger)"
												/>
												<rect
													x="30"
													y="5"
													width="5"
													height="5"
													fill="var(--atelier-danger)"
												/>
												<rect
													x="35"
													y="5"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="45"
													y="5"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="50"
													y="5"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="15"
													y="10"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="20"
													y="10"
													width="5"
													height="5"
													fill="var(--atelier-danger)"
												/>
												<rect
													x="25"
													y="10"
													width="5"
													height="5"
													fill="var(--atelier-danger)"
												/>
												<rect
													x="30"
													y="10"
													width="5"
													height="5"
													fill="var(--atelier-danger)"
												/>
												<rect
													x="35"
													y="10"
													width="5"
													height="5"
													fill="var(--atelier-danger)"
												/>
												<rect
													x="40"
													y="10"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="45"
													y="10"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="50"
													y="10"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="10"
													y="15"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="15"
													y="15"
													width="5"
													height="5"
													fill="var(--atelier-danger)"
												/>
												<rect
													x="20"
													y="15"
													width="5"
													height="5"
													fill="var(--atelier-danger)"
												/>
												<rect
													x="25"
													y="15"
													width="5"
													height="5"
													fill="var(--atelier-danger)"
												/>
												<rect
													x="30"
													y="15"
													width="5"
													height="5"
													fill="var(--atelier-danger)"
												/>
												<rect
													x="35"
													y="15"
													width="5"
													height="5"
													fill="var(--atelier-danger)"
												/>
												<rect
													x="40"
													y="15"
													width="5"
													height="5"
													fill="var(--atelier-danger)"
												/>
												<rect
													x="45"
													y="15"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="50"
													y="15"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="5"
													y="20"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="10"
													y="20"
													width="5"
													height="5"
													fill="var(--atelier-danger)"
												/>
												<rect
													x="15"
													y="20"
													width="5"
													height="5"
													fill="var(--atelier-danger)"
												/>
												<rect
													x="20"
													y="20"
													width="5"
													height="5"
													fill="var(--atelier-danger)"
												/>
												<rect
													x="25"
													y="20"
													width="5"
													height="5"
													fill="var(--atelier-danger)"
												/>
												<rect
													x="30"
													y="20"
													width="5"
													height="5"
													fill="var(--atelier-danger)"
												/>
												<rect
													x="35"
													y="20"
													width="5"
													height="5"
													fill="var(--atelier-danger)"
												/>
												<rect
													x="40"
													y="20"
													width="5"
													height="5"
													fill="var(--atelier-danger)"
												/>
												<rect
													x="45"
													y="20"
													width="5"
													height="5"
													fill="var(--atelier-danger)"
												/>
												<rect
													x="50"
													y="20"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="0"
													y="25"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="5"
													y="25"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="10"
													y="25"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="15"
													y="25"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="20"
													y="25"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="25"
													y="25"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="30"
													y="25"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="35"
													y="25"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="40"
													y="25"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="45"
													y="25"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="50"
													y="25"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="55"
													y="25"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="5"
													y="30"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="10"
													y="30"
													width="5"
													height="5"
													fill="var(--atelier-tag-brown)"
												/>
												<rect
													x="15"
													y="30"
													width="5"
													height="5"
													fill="var(--atelier-tag-brown)"
												/>
												<rect
													x="20"
													y="30"
													width="5"
													height="5"
													fill="var(--atelier-tag-brown)"
												/>
												<rect
													x="25"
													y="30"
													width="5"
													height="5"
													fill="var(--atelier-tag-brown)"
												/>
												<rect
													x="30"
													y="30"
													width="5"
													height="5"
													fill="var(--atelier-tag-brown)"
												/>
												<rect
													x="35"
													y="30"
													width="5"
													height="5"
													fill="var(--atelier-tag-brown)"
												/>
												<rect
													x="40"
													y="30"
													width="5"
													height="5"
													fill="var(--atelier-tag-brown)"
												/>
												<rect
													x="45"
													y="30"
													width="5"
													height="5"
													fill="var(--atelier-tag-brown)"
												/>
												<rect
													x="50"
													y="30"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="5"
													y="35"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="10"
													y="35"
													width="5"
													height="5"
													fill="var(--atelier-tag-brown)"
												/>
												<rect
													x="15"
													y="35"
													width="5"
													height="5"
													fill="var(--atelier-tag-blue)"
												/>
												<rect
													x="20"
													y="35"
													width="5"
													height="5"
													fill="var(--atelier-tag-blue)"
												/>
												<rect
													x="25"
													y="35"
													width="5"
													height="5"
													fill="var(--atelier-tag-brown)"
												/>
												<rect
													x="30"
													y="35"
													width="5"
													height="5"
													fill="var(--atelier-tag-brown)"
												/>
												<rect
													x="35"
													y="35"
													width="5"
													height="5"
													fill="var(--atelier-tag-brown)"
												/>
												<rect
													x="40"
													y="35"
													width="5"
													height="5"
													fill="var(--atelier-tag-blue)"
												/>
												<rect
													x="45"
													y="35"
													width="5"
													height="5"
													fill="var(--atelier-tag-blue)"
												/>
												<rect
													x="50"
													y="35"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="5"
													y="40"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="10"
													y="40"
													width="5"
													height="5"
													fill="var(--atelier-tag-brown)"
												/>
												<rect
													x="15"
													y="40"
													width="5"
													height="5"
													fill="var(--atelier-tag-blue)"
												/>
												<rect
													x="20"
													y="40"
													width="5"
													height="5"
													fill="var(--atelier-tag-blue)"
												/>
												<rect
													x="25"
													y="40"
													width="5"
													height="5"
													fill="var(--atelier-tag-brown)"
												/>
												<rect
													x="30"
													y="40"
													width="5"
													height="5"
													fill="var(--atelier-tag-brown)"
												/>
												<rect
													x="35"
													y="40"
													width="5"
													height="5"
													fill="var(--atelier-tag-brown)"
												/>
												<rect
													x="40"
													y="40"
													width="5"
													height="5"
													fill="var(--atelier-tag-blue)"
												/>
												<rect
													x="45"
													y="40"
													width="5"
													height="5"
													fill="var(--atelier-tag-blue)"
												/>
												<rect
													x="50"
													y="40"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="5"
													y="45"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="10"
													y="45"
													width="5"
													height="5"
													fill="var(--atelier-tag-brown)"
												/>
												<rect
													x="15"
													y="45"
													width="5"
													height="5"
													fill="var(--atelier-tag-brown)"
												/>
												<rect
													x="20"
													y="45"
													width="5"
													height="5"
													fill="var(--atelier-tag-brown)"
												/>
												<rect
													x="25"
													y="45"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="30"
													y="45"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="35"
													y="45"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="40"
													y="45"
													width="5"
													height="5"
													fill="var(--atelier-tag-brown)"
												/>
												<rect
													x="45"
													y="45"
													width="5"
													height="5"
													fill="var(--atelier-tag-brown)"
												/>
												<rect
													x="50"
													y="45"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="5"
													y="50"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="10"
													y="50"
													width="5"
													height="5"
													fill="var(--atelier-tag-brown)"
												/>
												<rect
													x="15"
													y="50"
													width="5"
													height="5"
													fill="var(--atelier-tag-brown)"
												/>
												<rect
													x="20"
													y="50"
													width="5"
													height="5"
													fill="var(--atelier-tag-brown)"
												/>
												<rect
													x="25"
													y="50"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="30"
													y="50"
													width="5"
													height="5"
													fill="var(--atelier-tag-yellow)"
												/>
												<rect
													x="35"
													y="50"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="40"
													y="50"
													width="5"
													height="5"
													fill="var(--atelier-tag-brown)"
												/>
												<rect
													x="45"
													y="50"
													width="5"
													height="5"
													fill="var(--atelier-tag-brown)"
												/>
												<rect
													x="50"
													y="50"
													width="5"
													height="5"
													fill="var(--atelier-tag-brown)"
												/>
												<rect
													x="55"
													y="50"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="5"
													y="55"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="10"
													y="55"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="15"
													y="55"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="20"
													y="55"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="25"
													y="55"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="30"
													y="55"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="35"
													y="55"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="40"
													y="55"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="45"
													y="55"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="50"
													y="55"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="55"
													y="55"
													width="5"
													height="5"
													fill="var(--landing-fg)"
												/>
												<rect
													x="0"
													y="60"
													width="5"
													height="5"
													fill="var(--atelier-success)"
												/>
												<rect
													x="5"
													y="60"
													width="5"
													height="5"
													fill="var(--atelier-success)"
												/>
												<rect
													x="10"
													y="60"
													width="5"
													height="5"
													fill="var(--atelier-success)"
												/>
												<rect
													x="15"
													y="60"
													width="5"
													height="5"
													fill="var(--atelier-success)"
												/>
												<rect
													x="20"
													y="60"
													width="5"
													height="5"
													fill="var(--atelier-success)"
												/>
												<rect
													x="25"
													y="60"
													width="5"
													height="5"
													fill="var(--atelier-success)"
												/>
												<rect
													x="30"
													y="60"
													width="5"
													height="5"
													fill="var(--atelier-success)"
												/>
												<rect
													x="35"
													y="60"
													width="5"
													height="5"
													fill="var(--atelier-success)"
												/>
												<rect
													x="40"
													y="60"
													width="5"
													height="5"
													fill="var(--atelier-success)"
												/>
												<rect
													x="45"
													y="60"
													width="5"
													height="5"
													fill="var(--atelier-success)"
												/>
												<rect
													x="50"
													y="60"
													width="5"
													height="5"
													fill="var(--atelier-success)"
												/>
												<rect
													x="55"
													y="60"
													width="5"
													height="5"
													fill="var(--atelier-success)"
												/>
											</svg>
											<div
												style={{
													flex: "1",
													minWidth: "0",
													background: "var(--landing-panel)",
													border: "1px solid var(--landing-border)",
													borderRadius: "9px",
													overflow: "hidden",
												}}
											>
												<div
													style={{
														display: "flex",
														justifyContent: "space-between",
														alignItems: "center",
														gap: "8px",
														padding: "5px 10px",
														fontFamily: "ui-monospace, Menlo, monospace",
														fontSize: "12px",
														whiteSpace: "nowrap",
													}}
												>
													<span>{"2BR \u00b7 18 min"}</span>
													<span
														style={{
															background: "var(--landing-success-bg)",
															color: "var(--landing-success-fg)",
															padding: "0 8px",
															borderRadius: "99px",
															fontSize: "11.5px",
														}}
													>
														{"new"}
													</span>
												</div>
												<div
													style={{
														display: "flex",
														justifyContent: "space-between",
														alignItems: "center",
														gap: "8px",
														padding: "5px 10px",
														borderTop: "1px solid var(--landing-divider)",
														fontFamily: "ui-monospace, Menlo, monospace",
														fontSize: "12px",
														whiteSpace: "nowrap",
													}}
												>
													<span>{"1BR \u00b7 25 min"}</span>
													<span
														style={{
															background: "var(--landing-success-bg)",
															color: "var(--landing-success-fg)",
															padding: "0 8px",
															borderRadius: "99px",
															fontSize: "11.5px",
														}}
													>
														{"new"}
													</span>
												</div>
												<div
													style={{
														display: "flex",
														justifyContent: "space-between",
														alignItems: "center",
														gap: "8px",
														padding: "5px 10px",
														borderTop: "1px solid var(--landing-divider)",
														fontFamily: "ui-monospace, Menlo, monospace",
														fontSize: "12px",
														whiteSpace: "nowrap",
													}}
												>
													<span>{"3BR \u00b7 41 min"}</span>
													<span
														style={{
															background: "var(--landing-divider)",
															color: "var(--landing-muted)",
															padding: "0 8px",
															borderRadius: "99px",
															fontSize: "11.5px",
														}}
													>
														{"far"}
													</span>
												</div>
											</div>
										</div>
									</div>
									<div
										style={{
											padding: "14px 16px 16px",
											display: "flex",
											flexDirection: "column",
											gap: "5px",
											borderTop: "1px solid var(--landing-divider)",
											flex: "1",
										}}
									>
										<b style={{ fontSize: "16px" }}>{"Apartment hunt"}</b>
										<span
											style={{
												fontSize: "14px",
												lineHeight: "1.5",
												color: "var(--landing-muted)",
												textWrap: "pretty",
											}}
										>
											{
												"A script adds new listings with your commute time. An agent flags the good ones."
											}
										</span>
									</div>
								</div>
								<div
									style={{
										background: "var(--landing-panel)",
										border: "1px solid var(--landing-border)",
										borderRadius: "16px",
										overflow: "hidden",
										display: "flex",
										flexDirection: "column",
									}}
								>
									<div
										style={{
											background: "var(--landing-panel-muted)",
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
												gap: "6px",
											}}
										>
											<span
												style={{
													width: "24px",
													height: "24px",
													borderRadius: "6px",
													background: "var(--landing-panel)",
													border: "1px solid var(--landing-border)",
													display: "flex",
													alignItems: "center",
													justifyContent: "center",
													boxSizing: "border-box",
													flexShrink: "0",
												}}
											>
												<img
													src="/landing/claude-spark.svg"
													alt=""
													style={{ width: "14px", height: "14px" }}
												/>
											</span>
											<span
												style={{
													display: "flex",
													alignItems: "center",
													gap: "5px",
													background: "var(--landing-panel)",
													border: "1px solid var(--landing-border)",
													borderRadius: "99px",
													padding: "2px 9px",
													fontFamily: "ui-monospace, Menlo, monospace",
													fontSize: "12px",
													whiteSpace: "nowrap",
												}}
											>
												<img
													src="/landing/icon-folder.svg"
													alt=""
													style={{ width: "12px", height: "12px" }}
												/>
												{"scripts"}
											</span>
											<span style={{ color: "var(--landing-faint)" }}>
												{"\u2192"}
											</span>
											<span
												style={{
													display: "flex",
													alignItems: "center",
													gap: "5px",
													background: "var(--landing-panel)",
													border: "1px solid var(--landing-border)",
													borderRadius: "99px",
													padding: "2px 9px",
													fontFamily: "ui-monospace, Menlo, monospace",
													fontSize: "12px",
													whiteSpace: "nowrap",
												}}
											>
												<svg
													width="12"
													height="12"
													viewBox="0 0 16 16"
													fill="none"
													stroke="var(--landing-subtle)"
													strokeWidth="1.3"
													style={{ flexShrink: "0" }}
												>
													<rect
														x="1.5"
														y="2.5"
														width="13"
														height="11"
														rx="1.8"
													/>
													<path d="M1.5 6.3 h13 M6 6.3 v7.2" />
												</svg>
												{"any table"}
											</span>
										</div>
										<div
											style={{
												flex: "1",
												display: "flex",
												alignItems: "flex-end",
												justifyContent: "flex-start",
												gap: "14px",
											}}
										>
											<div
												style={{
													flex: "1",
													minWidth: "0",
													display: "flex",
													flexDirection: "column",
													gap: "8px",
												}}
											>
												<div
													style={{
														background: "var(--landing-panel)",
														border: "1px solid var(--landing-border)",
														borderRadius: "9px",
														fontFamily: "ui-monospace, Menlo, monospace",
														fontSize: "12px",
														whiteSpace: "nowrap",
													}}
												>
													<div
														style={{
															display: "flex",
															justifyContent: "space-between",
															alignItems: "center",
															gap: "8px",
															padding: "7px 10px",
															borderTop: "none",
														}}
													>
														<span>{"digest.ts"}</span>
														<span
															style={{
																background: "var(--landing-success-bg)",
																color: "var(--landing-success-fg)",
																padding: "0 8px",
																borderRadius: "99px",
															}}
														>
															{"Mon 9:00"}
														</span>
													</div>
													<div
														style={{
															display: "flex",
															justifyContent: "space-between",
															alignItems: "center",
															gap: "8px",
															padding: "7px 10px",
															borderTop: "1px solid var(--landing-divider)",
														}}
													>
														<span>{"cleanup.ts"}</span>
														<span
															style={{
																background: "var(--landing-success-bg)",
																color: "var(--landing-success-fg)",
																padding: "0 8px",
																borderRadius: "99px",
															}}
														>
															{"daily"}
														</span>
													</div>
												</div>
											</div>
										</div>
									</div>
									<div
										style={{
											padding: "14px 16px 16px",
											display: "flex",
											flexDirection: "column",
											gap: "5px",
											borderTop: "1px solid var(--landing-divider)",
											flex: "1",
										}}
									>
										<b style={{ fontSize: "16px" }}>
											{"Automations"}
											<span
												style={{
													marginLeft: "8px",
													padding: "1px 7px",
													borderRadius: "99px",
													background: "var(--atelier-accent-subtle)",
													color: "var(--landing-accent)",
													fontSize: "11px",
													fontWeight: "600",
													verticalAlign: "middle",
												}}
											>
												{"Soon"}
											</span>
										</b>
										<span
											style={{
												fontSize: "14px",
												lineHeight: "1.5",
												color: "var(--landing-muted)",
												textWrap: "pretty",
											}}
										>
											{
												"Keep scripts next to your data. Scheduled runs are coming soon."
											}
										</span>
									</div>
								</div>
							</div>
							<div
								data-lr="cases"
								style={{
									display: "grid",
									gridTemplateColumns: "repeat(3, minmax(0,1fr))",
									gap: "16px",
								}}
							>
								<div
									style={{
										background: "var(--landing-panel)",
										border: "1px solid var(--landing-border)",
										borderRadius: "16px",
										overflow: "hidden",
										display: "flex",
										flexDirection: "column",
									}}
								>
									<div
										style={{
											background: "var(--landing-warning-bg)",
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
												gap: "6px",
											}}
										>
											<span
												style={{
													width: "24px",
													height: "24px",
													borderRadius: "6px",
													background: "var(--landing-panel)",
													border: "1px solid var(--landing-border)",
													display: "flex",
													alignItems: "center",
													justifyContent: "center",
													boxSizing: "border-box",
													flexShrink: "0",
												}}
											>
												<img
													src="/lixray-mark.svg"
													alt=""
													style={{ width: "14px", height: "14px" }}
												/>
											</span>
											<span
												style={{
													display: "flex",
													alignItems: "center",
													gap: "5px",
													background: "var(--landing-panel)",
													border: "1px solid var(--landing-border)",
													borderRadius: "99px",
													padding: "2px 9px",
													fontFamily: "ui-monospace, Menlo, monospace",
													fontSize: "12px",
													whiteSpace: "nowrap",
												}}
											>
												<svg
													width="12"
													height="12"
													viewBox="0 0 16 16"
													fill="none"
													stroke="var(--landing-subtle)"
													strokeWidth="1.3"
													style={{ flexShrink: "0" }}
												>
													<rect
														x="1.5"
														y="2.5"
														width="13"
														height="11"
														rx="1.8"
													/>
													<path d="M1.5 6.3 h13 M6 6.3 v7.2" />
												</svg>
												{"posts"}
											</span>
											<span style={{ color: "var(--landing-faint)" }}>
												{"\u2192"}
											</span>
											<span
												style={{
													display: "flex",
													alignItems: "center",
													gap: "5px",
													background: "var(--landing-panel)",
													border: "1px solid var(--landing-border)",
													borderRadius: "99px",
													padding: "2px 9px",
													fontFamily: "ui-monospace, Menlo, monospace",
													fontSize: "12px",
													whiteSpace: "nowrap",
												}}
											>
												{"this week"}
											</span>
										</div>
										<div
											style={{
												flex: "1",
												display: "flex",
												alignItems: "flex-end",
												justifyContent: "center",
											}}
										>
											<div
												style={{ display: "flex", gap: "5px", width: "100%" }}
											>
												<div
													style={{
														flex: "1",
														background: "var(--landing-panel)",
														border: "1px solid var(--landing-border)",
														borderRadius: "8px",
														height: "92px",
														padding: "6px 5px",
														display: "flex",
														flexDirection: "column",
														gap: "6px",
														boxSizing: "border-box",
														minWidth: "0",
													}}
												>
													<span
														style={{
															fontFamily: "ui-monospace, Menlo, monospace",
															fontSize: "10.5px",
															color: "var(--landing-subtle)",
														}}
													>
														{"Mon"}
													</span>
													<span
														style={{
															background: "var(--landing-success-bg)",
															color: "var(--landing-success-fg)",
															borderRadius: "4px",
															padding: "3px 4px",
															fontSize: "10.5px",
															fontWeight: "600",
															lineHeight: "1.2",
															overflow: "hidden",
															whiteSpace: "nowrap",
															textOverflow: "ellipsis",
														}}
													>
														{"\u2713 Blog"}
													</span>
												</div>
												<div
													style={{
														flex: "1",
														background: "var(--landing-panel)",
														border: "1px solid var(--landing-border)",
														borderRadius: "8px",
														height: "92px",
														padding: "6px 5px",
														display: "flex",
														flexDirection: "column",
														gap: "6px",
														boxSizing: "border-box",
														minWidth: "0",
													}}
												>
													<span
														style={{
															fontFamily: "ui-monospace, Menlo, monospace",
															fontSize: "10.5px",
															color: "var(--landing-subtle)",
														}}
													>
														{"Tue"}
													</span>
												</div>
												<div
													style={{
														flex: "1",
														background: "var(--landing-panel)",
														border: "1px solid var(--landing-border)",
														borderRadius: "8px",
														height: "92px",
														padding: "6px 5px",
														display: "flex",
														flexDirection: "column",
														gap: "6px",
														boxSizing: "border-box",
														minWidth: "0",
													}}
												>
													<span
														style={{
															fontFamily: "ui-monospace, Menlo, monospace",
															fontSize: "10.5px",
															color: "var(--landing-subtle)",
														}}
													>
														{"Wed"}
													</span>
													<span
														style={{
															background: "var(--landing-warning-bg)",
															color: "var(--landing-warning-fg)",
															borderRadius: "4px",
															padding: "3px 4px",
															fontSize: "10.5px",
															fontWeight: "600",
															lineHeight: "1.2",
															overflow: "hidden",
															whiteSpace: "nowrap",
															textOverflow: "ellipsis",
														}}
													>
														{"Launch"}
													</span>
												</div>
												<div
													style={{
														flex: "1",
														background: "var(--landing-panel)",
														border: "1px solid var(--landing-border)",
														borderRadius: "8px",
														height: "92px",
														padding: "6px 5px",
														display: "flex",
														flexDirection: "column",
														gap: "6px",
														boxSizing: "border-box",
														minWidth: "0",
													}}
												>
													<span
														style={{
															fontFamily: "ui-monospace, Menlo, monospace",
															fontSize: "10.5px",
															color: "var(--landing-subtle)",
														}}
													>
														{"Thu"}
													</span>
													<span
														style={{
															background: "var(--atelier-tag-purple)",
															color: "var(--atelier-tag-blue-fg)",
															borderRadius: "4px",
															padding: "3px 4px",
															fontSize: "10.5px",
															fontWeight: "600",
															lineHeight: "1.2",
															overflow: "hidden",
															whiteSpace: "nowrap",
															textOverflow: "ellipsis",
														}}
													>
														{"News"}
													</span>
												</div>
											</div>
										</div>
									</div>
									<div
										style={{
											padding: "14px 16px 16px",
											display: "flex",
											flexDirection: "column",
											gap: "5px",
											borderTop: "1px solid var(--landing-divider)",
											flex: "1",
										}}
									>
										<b style={{ fontSize: "16px" }}>{"Content calendar"}</b>
										<span
											style={{
												fontSize: "14px",
												lineHeight: "1.5",
												color: "var(--landing-muted)",
												textWrap: "pretty",
											}}
										>
											{
												"See this week's posts. Ask an agent to mark them as published."
											}
										</span>
									</div>
								</div>
								<div
									style={{
										background: "var(--landing-panel)",
										border: "1px solid var(--landing-border)",
										borderRadius: "16px",
										overflow: "hidden",
										display: "flex",
										flexDirection: "column",
									}}
								>
									<div
										style={{
											background: "var(--atelier-tag-red)",
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
												gap: "6px",
											}}
										>
											<img
												src="/landing/brand-granola.svg"
												alt="Granola"
												style={{
													width: "24px",
													height: "24px",
													display: "block",
													flexShrink: "0",
												}}
											/>
											<span
												style={{
													display: "flex",
													alignItems: "center",
													gap: "5px",
													background: "var(--landing-panel)",
													border: "1px solid var(--landing-border)",
													borderRadius: "99px",
													padding: "2px 9px",
													fontFamily: "ui-monospace, Menlo, monospace",
													fontSize: "12px",
													whiteSpace: "nowrap",
												}}
											>
												<svg
													width="12"
													height="12"
													viewBox="0 0 16 16"
													fill="none"
													stroke="var(--landing-subtle)"
													strokeWidth="1.3"
													style={{ flexShrink: "0" }}
												>
													<rect
														x="1.5"
														y="2.5"
														width="13"
														height="11"
														rx="1.8"
													/>
													<path d="M1.5 6.3 h13 M6 6.3 v7.2" />
												</svg>
												{"meetings"}
											</span>
											<span style={{ color: "var(--landing-faint)" }}>
												{"\u2192"}
											</span>
											<span
												style={{
													display: "flex",
													alignItems: "center",
													gap: "5px",
													background: "var(--landing-panel)",
													border: "1px solid var(--landing-border)",
													borderRadius: "99px",
													padding: "2px 9px",
													fontFamily: "ui-monospace, Menlo, monospace",
													fontSize: "12px",
													whiteSpace: "nowrap",
												}}
											>
												<svg
													width="12"
													height="12"
													viewBox="0 0 16 16"
													style={{ flexShrink: "0" }}
												>
													<rect
														x="4"
														y="1"
														width="11"
														height="14"
														rx="1.6"
														fill="var(--landing-accent)"
													/>
													<rect
														x="1"
														y="4"
														width="9"
														height="8"
														rx="1.3"
														fill="var(--atelier-tag-red-fg)"
													/>
												</svg>
												{"decks"}
											</span>
										</div>
										<div
											style={{
												flex: "1",
												display: "flex",
												alignItems: "flex-end",
												justifyContent: "center",
											}}
										>
											<div
												style={{
													position: "relative",
													width: "236px",
													height: "92px",
												}}
											>
												<div
													style={{
														position: "absolute",
														left: "6px",
														bottom: "0",
														width: "108px",
														height: "72px",
														background: "var(--landing-panel)",
														border: "1px solid var(--landing-border)",
														borderRadius: "6px",
														boxShadow:
															"0 6px 14px color-mix(in srgb, var(--landing-fg) 10%, transparent)",
														transform: "rotate(-8deg)",
														transformOrigin: "bottom center",
														zIndex: "1",
														overflow: "hidden",
														display: "flex",
														flexDirection: "column",
													}}
												>
													<div
														style={{
															height: "14px",
															background: "var(--landing-accent)",
														}}
													></div>
													<div
														style={{
															padding: "6px 8px",
															display: "flex",
															flexDirection: "column",
															gap: "4px",
														}}
													>
														<b style={{ fontSize: "11px" }}>{"Globex"}</b>
														<div
															style={{
																display: "flex",
																alignItems: "flex-end",
																gap: "3px",
																height: "22px",
															}}
														>
															<span
																style={{
																	width: "8px",
																	height: "9px",
																	background: "var(--atelier-tag-red)",
																}}
															></span>
															<span
																style={{
																	width: "8px",
																	height: "15px",
																	background: "var(--atelier-tag-red)",
																}}
															></span>
															<span
																style={{
																	width: "8px",
																	height: "22px",
																	background: "var(--landing-accent)",
																}}
															></span>
															<span style={{ flex: "1" }}></span>
															<span
																style={{
																	width: "30px",
																	height: "3px",
																	background: "var(--landing-border)",
																	alignSelf: "center",
																}}
															></span>
														</div>
													</div>
												</div>
												<div
													style={{
														position: "absolute",
														left: "122px",
														bottom: "0",
														width: "108px",
														height: "72px",
														background: "var(--landing-panel)",
														border: "1px solid var(--landing-border)",
														borderRadius: "6px",
														boxShadow:
															"0 6px 14px color-mix(in srgb, var(--landing-fg) 10%, transparent)",
														transform: "rotate(8deg)",
														transformOrigin: "bottom center",
														zIndex: "1",
														overflow: "hidden",
														display: "flex",
														flexDirection: "column",
													}}
												>
													<div
														style={{
															height: "14px",
															background: "var(--landing-accent)",
														}}
													></div>
													<div
														style={{
															padding: "6px 8px",
															display: "flex",
															flexDirection: "column",
															gap: "4px",
														}}
													>
														<b
															style={{
																fontSize: "11px",
																alignSelf: "flex-end",
															}}
														>
															{"Nexa"}
														</b>
														<div
															style={{
																display: "flex",
																alignItems: "flex-end",
																gap: "3px",
																height: "22px",
															}}
														>
															<span
																style={{
																	width: "8px",
																	height: "9px",
																	background: "var(--atelier-tag-red)",
																}}
															></span>
															<span
																style={{
																	width: "8px",
																	height: "15px",
																	background: "var(--atelier-tag-red)",
																}}
															></span>
															<span
																style={{
																	width: "8px",
																	height: "22px",
																	background: "var(--landing-accent)",
																}}
															></span>
															<span style={{ flex: "1" }}></span>
															<span
																style={{
																	width: "30px",
																	height: "3px",
																	background: "var(--landing-border)",
																	alignSelf: "center",
																}}
															></span>
														</div>
													</div>
												</div>
												<div
													style={{
														position: "absolute",
														left: "64px",
														bottom: "0",
														width: "108px",
														height: "72px",
														background: "var(--landing-panel)",
														border: "1px solid var(--landing-border)",
														borderRadius: "6px",
														boxShadow:
															"0 6px 14px color-mix(in srgb, var(--landing-fg) 10%, transparent)",
														transform: "rotate(0deg)",
														transformOrigin: "bottom center",
														zIndex: "2",
														overflow: "hidden",
														display: "flex",
														flexDirection: "column",
													}}
												>
													<div
														style={{
															height: "14px",
															background: "var(--landing-accent)",
														}}
													></div>
													<div
														style={{
															padding: "6px 8px",
															display: "flex",
															flexDirection: "column",
															gap: "4px",
														}}
													>
														<b style={{ fontSize: "11px" }}>{"Acme"}</b>
														<div
															style={{
																display: "flex",
																alignItems: "flex-end",
																gap: "3px",
																height: "22px",
															}}
														>
															<span
																style={{
																	width: "8px",
																	height: "9px",
																	background: "var(--atelier-tag-red)",
																}}
															></span>
															<span
																style={{
																	width: "8px",
																	height: "15px",
																	background: "var(--atelier-tag-red)",
																}}
															></span>
															<span
																style={{
																	width: "8px",
																	height: "22px",
																	background: "var(--landing-accent)",
																}}
															></span>
															<span style={{ flex: "1" }}></span>
															<span
																style={{
																	width: "30px",
																	height: "3px",
																	background: "var(--landing-border)",
																	alignSelf: "center",
																}}
															></span>
														</div>
													</div>
												</div>
											</div>
										</div>
									</div>
									<div
										style={{
											padding: "14px 16px 16px",
											display: "flex",
											flexDirection: "column",
											gap: "5px",
											borderTop: "1px solid var(--landing-divider)",
											flex: "1",
										}}
									>
										<b style={{ fontSize: "16px" }}>
											{"Per-customer pitch decks"}
										</b>
										<span
											style={{
												fontSize: "14px",
												lineHeight: "1.5",
												color: "var(--landing-muted)",
												textWrap: "pretty",
											}}
										>
											{
												"Ask an agent to build a deck from a customer's meeting notes."
											}
										</span>
									</div>
								</div>
								<div
									style={{
										background: "var(--landing-panel)",
										border: "1px solid var(--landing-border)",
										borderRadius: "16px",
										overflow: "hidden",
										display: "flex",
										flexDirection: "column",
									}}
								>
									<div
										style={{
											background: "var(--atelier-tag-green)",
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
												gap: "6px",
											}}
										>
											<span
												style={{
													display: "flex",
													alignItems: "center",
													gap: "5px",
													background: "var(--landing-panel)",
													border: "1px solid var(--landing-border)",
													borderRadius: "99px",
													padding: "2px 9px",
													fontFamily: "ui-monospace, Menlo, monospace",
													fontSize: "12px",
													whiteSpace: "nowrap",
												}}
											>
												<img
													src="/landing/icon-folder.svg"
													alt=""
													style={{ width: "12px", height: "12px" }}
												/>
												{"skills"}
											</span>
											<span style={{ color: "var(--landing-faint)" }}>
												{"\u2192"}
											</span>
											<span
												style={{
													display: "flex",
													alignItems: "center",
													gap: "5px",
													background: "var(--landing-panel)",
													border: "1px solid var(--landing-border)",
													borderRadius: "99px",
													padding: "2px 9px",
													fontFamily: "ui-monospace, Menlo, monospace",
													fontSize: "12px",
													whiteSpace: "nowrap",
												}}
											>
												{"every agent"}
											</span>
										</div>
										<div
											style={{
												flex: "1",
												display: "flex",
												alignItems: "flex-end",
												justifyContent: "center",
											}}
										>
											<div
												style={{
													display: "flex",
													alignItems: "center",
													gap: "0",
												}}
											>
												<div
													style={{
														background: "var(--landing-panel)",
														border: "1px solid var(--landing-border)",
														borderRadius: "8px",
														width: "108px",
														padding: "9px 10px",
														display: "flex",
														flexDirection: "column",
														gap: "6px",
														boxShadow:
															"0 6px 14px color-mix(in srgb, var(--landing-fg) 8%, transparent)",
													}}
												>
													<span
														style={{
															display: "flex",
															alignItems: "center",
															gap: "5px",
															fontFamily: "ui-monospace, Menlo, monospace",
															fontSize: "11.5px",
															fontWeight: "600",
														}}
													>
														<img
															src="/landing/icon-sq-md.svg"
															alt=""
															style={{
																width: "12px",
																height: "12px",
																flexShrink: "0",
															}}
														/>
														{"tone.md"}
													</span>
													<span
														style={{
															height: "3px",
															background: "var(--landing-border)",
															width: "90%",
														}}
													></span>
													<span
														style={{
															height: "3px",
															background: "var(--landing-border)",
															width: "70%",
														}}
													></span>
													<span
														style={{
															height: "3px",
															background: "var(--landing-border)",
															width: "80%",
														}}
													></span>
												</div>
												<svg
													width="56"
													height="92"
													viewBox="0 0 56 92"
													fill="none"
													stroke="var(--landing-faint)"
													strokeWidth="1.5"
												>
													<path d="M0 46 C28 46 28 12 56 12" />
													<path d="M0 46 H56" />
													<path d="M0 46 C28 46 28 80 56 80" />
												</svg>
												<div
													style={{
														display: "flex",
														flexDirection: "column",
														gap: "10px",
													}}
												>
													<span
														style={{
															width: "24px",
															height: "24px",
															borderRadius: "6px",
															background: "var(--landing-panel)",
															border: "1px solid var(--landing-border)",
															display: "flex",
															alignItems: "center",
															justifyContent: "center",
															boxSizing: "border-box",
															flexShrink: "0",
														}}
													>
														<img
															src="/landing/claude-spark.svg"
															alt=""
															style={{ width: "14px", height: "14px" }}
														/>
													</span>
													<span
														style={{
															width: "24px",
															height: "24px",
															borderRadius: "6px",
															background: "var(--landing-panel)",
															border: "1px solid var(--landing-border)",
															display: "flex",
															alignItems: "center",
															justifyContent: "center",
															boxSizing: "border-box",
															flexShrink: "0",
														}}
													>
														<img
															src="/landing/brand-openai.svg"
															alt=""
															style={{ width: "14px", height: "14px" }}
														/>
													</span>
													<span
														style={{
															width: "24px",
															height: "24px",
															borderRadius: "6px",
															background: "var(--landing-panel)",
															border: "1px solid var(--landing-border)",
															display: "flex",
															alignItems: "center",
															justifyContent: "center",
															boxSizing: "border-box",
															flexShrink: "0",
														}}
													>
														<img
															src="/landing/brand-gemini.svg"
															alt=""
															style={{ width: "14px", height: "14px" }}
														/>
													</span>
												</div>
											</div>
										</div>
									</div>
									<div
										style={{
											padding: "14px 16px 16px",
											display: "flex",
											flexDirection: "column",
											gap: "5px",
											borderTop: "1px solid var(--landing-divider)",
											flex: "1",
										}}
									>
										<b style={{ fontSize: "16px" }}>{"Sharing skills"}</b>
										<span
											style={{
												fontSize: "14px",
												lineHeight: "1.5",
												color: "var(--landing-muted)",
												textWrap: "pretty",
											}}
										>
											{
												"Write down how your team does a task, once. Every agent can read it."
											}
										</span>
									</div>
								</div>
							</div>
						</div>
					</div>
					<div
						style={{
							display: "flex",
							flexDirection: "column",
							gap: "20px",
							paddingTop: "56px",
							borderTop: "1px solid var(--atelier-border-strong)",
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
							{"How it compares"}
						</h3>
						<CompareTable />
					</div>
				</div>
			</main>
			<SiteFooter />
		</div>
	);
}
