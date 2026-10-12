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
				<circle cx="11" cy="11" r="11" fill="#2F8F57" />
				<path
					d="M6.6 11.3 l3 3 l5.8 -6.3"
					fill="none"
					stroke="#FFFFFF"
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
				style={{ color: "#A8A29E", fontSize: "18px", lineHeight: "1" }}
			>
				{"\u2013"}
			</span>
		);
	}
	return <span style={{ fontSize: "13.5px", color: "#78716C" }}>{value}</span>;
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
								"Files and SQL tables in one open-source repo. Claude, ChatGPT, Codex, and your scripts read and write the same data."
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
								{"Hackable"}
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
								</a>
								{
									", an open-source engine for files, tables, and version control. You query it with SQL. Agents and your own code use the same API."
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
												{"url: "}
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
											background: "#FFF1EA",
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
													<rect width="28" height="28" rx="7" fill="#FC4C02" />
													<path
														d="M11.5 6 L6.5 16 h3.2 l1.8 -3.6 l1.8 3.6 h3.2 z"
														fill="#FFFFFF"
													/>
													<path
														d="M16.5 16 l-1.6 3.2 l-1.6 -3.2 h-2 l3.6 7 l3.6 -7 z"
														fill="#FFC4A8"
													/>
												</svg>
											</span>
											<span style={{ color: "#A8A29E" }}>{"\u2192"}</span>
											<span
												style={{
													display: "flex",
													alignItems: "center",
													gap: "5px",
													background: "#FFFFFF",
													border: "1px solid #E2DCD3",
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
													stroke="#78716C"
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
													fill="#1C1917"
												/>
												<rect
													x="30"
													y="0"
													width="6"
													height="6"
													fill="#1C1917"
												/>
												<rect
													x="36"
													y="0"
													width="6"
													height="6"
													fill="#1C1917"
												/>
												<rect
													x="24"
													y="6"
													width="6"
													height="6"
													fill="#1C1917"
												/>
												<rect
													x="30"
													y="6"
													width="6"
													height="6"
													fill="#1C1917"
												/>
												<rect
													x="36"
													y="6"
													width="6"
													height="6"
													fill="#1C1917"
												/>
												<rect
													x="30"
													y="12"
													width="6"
													height="6"
													fill="#E8B48A"
												/>
												<rect
													x="18"
													y="18"
													width="6"
													height="6"
													fill="#FC4C02"
												/>
												<rect
													x="24"
													y="18"
													width="6"
													height="6"
													fill="#FC4C02"
												/>
												<rect
													x="30"
													y="18"
													width="6"
													height="6"
													fill="#FC4C02"
												/>
												<rect
													x="36"
													y="18"
													width="6"
													height="6"
													fill="#FC4C02"
												/>
												<rect
													x="12"
													y="24"
													width="6"
													height="6"
													fill="#FC4C02"
												/>
												<rect
													x="24"
													y="24"
													width="6"
													height="6"
													fill="#FC4C02"
												/>
												<rect
													x="30"
													y="24"
													width="6"
													height="6"
													fill="#FC4C02"
												/>
												<rect
													x="36"
													y="24"
													width="6"
													height="6"
													fill="#FC4C02"
												/>
												<rect
													x="48"
													y="24"
													width="6"
													height="6"
													fill="#E8B48A"
												/>
												<rect
													x="6"
													y="30"
													width="6"
													height="6"
													fill="#E8B48A"
												/>
												<rect
													x="24"
													y="30"
													width="6"
													height="6"
													fill="#FC4C02"
												/>
												<rect
													x="30"
													y="30"
													width="6"
													height="6"
													fill="#FC4C02"
												/>
												<rect
													x="36"
													y="30"
													width="6"
													height="6"
													fill="#FC4C02"
												/>
												<rect
													x="24"
													y="36"
													width="6"
													height="6"
													fill="#FC4C02"
												/>
												<rect
													x="30"
													y="36"
													width="6"
													height="6"
													fill="#FC4C02"
												/>
												<rect
													x="36"
													y="36"
													width="6"
													height="6"
													fill="#FC4C02"
												/>
												<rect
													x="24"
													y="42"
													width="6"
													height="6"
													fill="#1C1917"
												/>
												<rect
													x="30"
													y="42"
													width="6"
													height="6"
													fill="#1C1917"
												/>
												<rect
													x="36"
													y="42"
													width="6"
													height="6"
													fill="#1C1917"
												/>
												<rect
													x="42"
													y="42"
													width="6"
													height="6"
													fill="#1C1917"
												/>
												<rect
													x="18"
													y="48"
													width="6"
													height="6"
													fill="#1C1917"
												/>
												<rect
													x="24"
													y="48"
													width="6"
													height="6"
													fill="#1C1917"
												/>
												<rect
													x="42"
													y="48"
													width="6"
													height="6"
													fill="#1C1917"
												/>
												<rect
													x="48"
													y="48"
													width="6"
													height="6"
													fill="#1C1917"
												/>
												<rect
													x="12"
													y="54"
													width="6"
													height="6"
													fill="#1C1917"
												/>
												<rect
													x="18"
													y="54"
													width="6"
													height="6"
													fill="#1C1917"
												/>
												<rect
													x="48"
													y="54"
													width="6"
													height="6"
													fill="#1C1917"
												/>
												<rect
													x="6"
													y="60"
													width="6"
													height="6"
													fill="#1C1917"
												/>
												<rect
													x="12"
													y="60"
													width="6"
													height="6"
													fill="#1C1917"
												/>
												<rect
													x="48"
													y="60"
													width="6"
													height="6"
													fill="#1C1917"
												/>
												<rect
													x="54"
													y="60"
													width="6"
													height="6"
													fill="#1C1917"
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
																background: "#FC4C02",
															}}
														></span>
														<span
															style={{
																display: "block",
																width: "16px",
																height: "6px",
																background: "#FC4C02",
															}}
														></span>
														<span
															style={{
																display: "block",
																width: "16px",
																height: "6px",
																background: "#FC4C02",
															}}
														></span>
													</div>
													<span
														style={{
															fontFamily: "ui-monospace, Menlo, monospace",
															fontSize: "10.5px",
															color: "#78716C",
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
																background: "#FC4C02",
															}}
														></span>
														<span
															style={{
																display: "block",
																width: "16px",
																height: "6px",
																background: "#FC4C02",
															}}
														></span>
														<span
															style={{
																display: "block",
																width: "16px",
																height: "6px",
																background: "#FC4C02",
															}}
														></span>
														<span
															style={{
																display: "block",
																width: "16px",
																height: "6px",
																background: "#FC4C02",
															}}
														></span>
													</div>
													<span
														style={{
															fontFamily: "ui-monospace, Menlo, monospace",
															fontSize: "10.5px",
															color: "#78716C",
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
																background: "#FC4C02",
															}}
														></span>
														<span
															style={{
																display: "block",
																width: "16px",
																height: "6px",
																background: "#FC4C02",
															}}
														></span>
														<span
															style={{
																display: "block",
																width: "16px",
																height: "6px",
																background: "#FC4C02",
															}}
														></span>
														<span
															style={{
																display: "block",
																width: "16px",
																height: "6px",
																background: "#FC4C02",
															}}
														></span>
														<span
															style={{
																display: "block",
																width: "16px",
																height: "6px",
																background: "#FC4C02",
															}}
														></span>
														<span
															style={{
																display: "block",
																width: "16px",
																height: "6px",
																background: "#FC4C02",
															}}
														></span>
														<span
															style={{
																display: "block",
																width: "16px",
																height: "6px",
																background: "#FC4C02",
															}}
														></span>
														<span
															style={{
																display: "block",
																width: "16px",
																height: "6px",
																background: "#FC4C02",
															}}
														></span>
													</div>
													<span
														style={{
															fontFamily: "ui-monospace, Menlo, monospace",
															fontSize: "10.5px",
															color: "#78716C",
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
											borderTop: "1px solid #EDEAE6",
											flex: "1",
										}}
									>
										<b style={{ fontSize: "16px" }}>{"Run log"}</b>
										<span
											style={{
												fontSize: "14px",
												lineHeight: "1.5",
												color: "#57534E",
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
											background: "#EEF4F9",
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
													background: "#FFFFFF",
													border: "1px solid #E2DCD3",
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
													stroke="#57534E"
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
													background: "#FFFFFF",
													border: "1px solid #E2DCD3",
													borderRadius: "99px",
													padding: "2px 9px",
													fontFamily: "ui-monospace, Menlo, monospace",
													fontSize: "12px",
													whiteSpace: "nowrap",
												}}
											>
												{"listings"}
											</span>
											<span style={{ color: "#A8A29E" }}>{"\u2192"}</span>
											<span
												style={{
													display: "flex",
													alignItems: "center",
													gap: "5px",
													background: "#FFFFFF",
													border: "1px solid #E2DCD3",
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
													stroke="#78716C"
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
													fill="#1C1917"
												/>
												<rect
													x="30"
													y="0"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="20"
													y="5"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="25"
													y="5"
													width="5"
													height="5"
													fill="#D9534F"
												/>
												<rect
													x="30"
													y="5"
													width="5"
													height="5"
													fill="#D9534F"
												/>
												<rect
													x="35"
													y="5"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="45"
													y="5"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="50"
													y="5"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="15"
													y="10"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="20"
													y="10"
													width="5"
													height="5"
													fill="#D9534F"
												/>
												<rect
													x="25"
													y="10"
													width="5"
													height="5"
													fill="#D9534F"
												/>
												<rect
													x="30"
													y="10"
													width="5"
													height="5"
													fill="#D9534F"
												/>
												<rect
													x="35"
													y="10"
													width="5"
													height="5"
													fill="#D9534F"
												/>
												<rect
													x="40"
													y="10"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="45"
													y="10"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="50"
													y="10"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="10"
													y="15"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="15"
													y="15"
													width="5"
													height="5"
													fill="#D9534F"
												/>
												<rect
													x="20"
													y="15"
													width="5"
													height="5"
													fill="#D9534F"
												/>
												<rect
													x="25"
													y="15"
													width="5"
													height="5"
													fill="#D9534F"
												/>
												<rect
													x="30"
													y="15"
													width="5"
													height="5"
													fill="#D9534F"
												/>
												<rect
													x="35"
													y="15"
													width="5"
													height="5"
													fill="#D9534F"
												/>
												<rect
													x="40"
													y="15"
													width="5"
													height="5"
													fill="#D9534F"
												/>
												<rect
													x="45"
													y="15"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="50"
													y="15"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="5"
													y="20"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="10"
													y="20"
													width="5"
													height="5"
													fill="#D9534F"
												/>
												<rect
													x="15"
													y="20"
													width="5"
													height="5"
													fill="#D9534F"
												/>
												<rect
													x="20"
													y="20"
													width="5"
													height="5"
													fill="#D9534F"
												/>
												<rect
													x="25"
													y="20"
													width="5"
													height="5"
													fill="#D9534F"
												/>
												<rect
													x="30"
													y="20"
													width="5"
													height="5"
													fill="#D9534F"
												/>
												<rect
													x="35"
													y="20"
													width="5"
													height="5"
													fill="#D9534F"
												/>
												<rect
													x="40"
													y="20"
													width="5"
													height="5"
													fill="#D9534F"
												/>
												<rect
													x="45"
													y="20"
													width="5"
													height="5"
													fill="#D9534F"
												/>
												<rect
													x="50"
													y="20"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="0"
													y="25"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="5"
													y="25"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="10"
													y="25"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="15"
													y="25"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="20"
													y="25"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="25"
													y="25"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="30"
													y="25"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="35"
													y="25"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="40"
													y="25"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="45"
													y="25"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="50"
													y="25"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="55"
													y="25"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="5"
													y="30"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="10"
													y="30"
													width="5"
													height="5"
													fill="#E8D9C0"
												/>
												<rect
													x="15"
													y="30"
													width="5"
													height="5"
													fill="#E8D9C0"
												/>
												<rect
													x="20"
													y="30"
													width="5"
													height="5"
													fill="#E8D9C0"
												/>
												<rect
													x="25"
													y="30"
													width="5"
													height="5"
													fill="#E8D9C0"
												/>
												<rect
													x="30"
													y="30"
													width="5"
													height="5"
													fill="#E8D9C0"
												/>
												<rect
													x="35"
													y="30"
													width="5"
													height="5"
													fill="#E8D9C0"
												/>
												<rect
													x="40"
													y="30"
													width="5"
													height="5"
													fill="#E8D9C0"
												/>
												<rect
													x="45"
													y="30"
													width="5"
													height="5"
													fill="#E8D9C0"
												/>
												<rect
													x="50"
													y="30"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="5"
													y="35"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="10"
													y="35"
													width="5"
													height="5"
													fill="#E8D9C0"
												/>
												<rect
													x="15"
													y="35"
													width="5"
													height="5"
													fill="#7FB3E6"
												/>
												<rect
													x="20"
													y="35"
													width="5"
													height="5"
													fill="#7FB3E6"
												/>
												<rect
													x="25"
													y="35"
													width="5"
													height="5"
													fill="#E8D9C0"
												/>
												<rect
													x="30"
													y="35"
													width="5"
													height="5"
													fill="#E8D9C0"
												/>
												<rect
													x="35"
													y="35"
													width="5"
													height="5"
													fill="#E8D9C0"
												/>
												<rect
													x="40"
													y="35"
													width="5"
													height="5"
													fill="#7FB3E6"
												/>
												<rect
													x="45"
													y="35"
													width="5"
													height="5"
													fill="#7FB3E6"
												/>
												<rect
													x="50"
													y="35"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="5"
													y="40"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="10"
													y="40"
													width="5"
													height="5"
													fill="#E8D9C0"
												/>
												<rect
													x="15"
													y="40"
													width="5"
													height="5"
													fill="#7FB3E6"
												/>
												<rect
													x="20"
													y="40"
													width="5"
													height="5"
													fill="#7FB3E6"
												/>
												<rect
													x="25"
													y="40"
													width="5"
													height="5"
													fill="#E8D9C0"
												/>
												<rect
													x="30"
													y="40"
													width="5"
													height="5"
													fill="#E8D9C0"
												/>
												<rect
													x="35"
													y="40"
													width="5"
													height="5"
													fill="#E8D9C0"
												/>
												<rect
													x="40"
													y="40"
													width="5"
													height="5"
													fill="#7FB3E6"
												/>
												<rect
													x="45"
													y="40"
													width="5"
													height="5"
													fill="#7FB3E6"
												/>
												<rect
													x="50"
													y="40"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="5"
													y="45"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="10"
													y="45"
													width="5"
													height="5"
													fill="#E8D9C0"
												/>
												<rect
													x="15"
													y="45"
													width="5"
													height="5"
													fill="#E8D9C0"
												/>
												<rect
													x="20"
													y="45"
													width="5"
													height="5"
													fill="#E8D9C0"
												/>
												<rect
													x="25"
													y="45"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="30"
													y="45"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="35"
													y="45"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="40"
													y="45"
													width="5"
													height="5"
													fill="#E8D9C0"
												/>
												<rect
													x="45"
													y="45"
													width="5"
													height="5"
													fill="#E8D9C0"
												/>
												<rect
													x="50"
													y="45"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="5"
													y="50"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="10"
													y="50"
													width="5"
													height="5"
													fill="#E8D9C0"
												/>
												<rect
													x="15"
													y="50"
													width="5"
													height="5"
													fill="#E8D9C0"
												/>
												<rect
													x="20"
													y="50"
													width="5"
													height="5"
													fill="#E8D9C0"
												/>
												<rect
													x="25"
													y="50"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="30"
													y="50"
													width="5"
													height="5"
													fill="#F2C94C"
												/>
												<rect
													x="35"
													y="50"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="40"
													y="50"
													width="5"
													height="5"
													fill="#E8D9C0"
												/>
												<rect
													x="45"
													y="50"
													width="5"
													height="5"
													fill="#E8D9C0"
												/>
												<rect
													x="50"
													y="50"
													width="5"
													height="5"
													fill="#E8D9C0"
												/>
												<rect
													x="55"
													y="50"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="5"
													y="55"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="10"
													y="55"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="15"
													y="55"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="20"
													y="55"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="25"
													y="55"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="30"
													y="55"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="35"
													y="55"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="40"
													y="55"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="45"
													y="55"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="50"
													y="55"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="55"
													y="55"
													width="5"
													height="5"
													fill="#1C1917"
												/>
												<rect
													x="0"
													y="60"
													width="5"
													height="5"
													fill="#3E9B6A"
												/>
												<rect
													x="5"
													y="60"
													width="5"
													height="5"
													fill="#3E9B6A"
												/>
												<rect
													x="10"
													y="60"
													width="5"
													height="5"
													fill="#3E9B6A"
												/>
												<rect
													x="15"
													y="60"
													width="5"
													height="5"
													fill="#3E9B6A"
												/>
												<rect
													x="20"
													y="60"
													width="5"
													height="5"
													fill="#3E9B6A"
												/>
												<rect
													x="25"
													y="60"
													width="5"
													height="5"
													fill="#3E9B6A"
												/>
												<rect
													x="30"
													y="60"
													width="5"
													height="5"
													fill="#3E9B6A"
												/>
												<rect
													x="35"
													y="60"
													width="5"
													height="5"
													fill="#3E9B6A"
												/>
												<rect
													x="40"
													y="60"
													width="5"
													height="5"
													fill="#3E9B6A"
												/>
												<rect
													x="45"
													y="60"
													width="5"
													height="5"
													fill="#3E9B6A"
												/>
												<rect
													x="50"
													y="60"
													width="5"
													height="5"
													fill="#3E9B6A"
												/>
												<rect
													x="55"
													y="60"
													width="5"
													height="5"
													fill="#3E9B6A"
												/>
											</svg>
											<div
												style={{
													flex: "1",
													minWidth: "0",
													background: "#FFFFFF",
													border: "1px solid #E2DCD3",
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
															background: "#E7F3EB",
															color: "#1F6B40",
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
														borderTop: "1px solid #EDEAE6",
														fontFamily: "ui-monospace, Menlo, monospace",
														fontSize: "12px",
														whiteSpace: "nowrap",
													}}
												>
													<span>{"1BR \u00b7 25 min"}</span>
													<span
														style={{
															background: "#E7F3EB",
															color: "#1F6B40",
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
														borderTop: "1px solid #EDEAE6",
														fontFamily: "ui-monospace, Menlo, monospace",
														fontSize: "12px",
														whiteSpace: "nowrap",
													}}
												>
													<span>{"3BR \u00b7 41 min"}</span>
													<span
														style={{
															background: "#EDEAE6",
															color: "#57534E",
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
											borderTop: "1px solid #EDEAE6",
											flex: "1",
										}}
									>
										<b style={{ fontSize: "16px" }}>{"Apartment hunt"}</b>
										<span
											style={{
												fontSize: "14px",
												lineHeight: "1.5",
												color: "#57534E",
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
											background: "#F1F0EC",
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
													background: "#FFFFFF",
													border: "1px solid #E2DCD3",
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
													background: "#FFFFFF",
													border: "1px solid #E2DCD3",
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
											<span style={{ color: "#A8A29E" }}>{"\u2192"}</span>
											<span
												style={{
													display: "flex",
													alignItems: "center",
													gap: "5px",
													background: "#FFFFFF",
													border: "1px solid #E2DCD3",
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
													stroke="#78716C"
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
														background: "#FFFFFF",
														border: "1px solid #E2DCD3",
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
																background: "#E7F3EB",
																color: "#1F6B40",
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
															borderTop: "1px solid #EDEAE6",
														}}
													>
														<span>{"cleanup.ts"}</span>
														<span
															style={{
																background: "#E7F3EB",
																color: "#1F6B40",
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
											borderTop: "1px solid #EDEAE6",
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
													background: "#FFF4EC",
													color: "#C2410C",
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
												color: "#57534E",
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
											background: "#FFF4E8",
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
													background: "#FFFFFF",
													border: "1px solid #E2DCD3",
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
													background: "#FFFFFF",
													border: "1px solid #E2DCD3",
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
													stroke="#78716C"
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
											<span style={{ color: "#A8A29E" }}>{"\u2192"}</span>
											<span
												style={{
													display: "flex",
													alignItems: "center",
													gap: "5px",
													background: "#FFFFFF",
													border: "1px solid #E2DCD3",
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
														background: "#FFFFFF",
														border: "1px solid #E2DCD3",
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
															color: "#78716C",
														}}
													>
														{"Mon"}
													</span>
													<span
														style={{
															background: "#E7F3EB",
															color: "#1F6B40",
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
														background: "#FFFFFF",
														border: "1px solid #E2DCD3",
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
															color: "#78716C",
														}}
													>
														{"Tue"}
													</span>
												</div>
												<div
													style={{
														flex: "1",
														background: "#FFFFFF",
														border: "1px solid #E2DCD3",
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
															color: "#78716C",
														}}
													>
														{"Wed"}
													</span>
													<span
														style={{
															background: "#FDEBD3",
															color: "#B54708",
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
														background: "#FFFFFF",
														border: "1px solid #E2DCD3",
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
															color: "#78716C",
														}}
													>
														{"Thu"}
													</span>
													<span
														style={{
															background: "#EDF0FA",
															color: "#2F5DA8",
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
											borderTop: "1px solid #EDEAE6",
											flex: "1",
										}}
									>
										<b style={{ fontSize: "16px" }}>{"Content calendar"}</b>
										<span
											style={{
												fontSize: "14px",
												lineHeight: "1.5",
												color: "#57534E",
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
											background: "#FDF0EA",
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
													background: "#FFFFFF",
													border: "1px solid #E2DCD3",
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
													stroke="#78716C"
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
											<span style={{ color: "#A8A29E" }}>{"\u2192"}</span>
											<span
												style={{
													display: "flex",
													alignItems: "center",
													gap: "5px",
													background: "#FFFFFF",
													border: "1px solid #E2DCD3",
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
														fill="#ED6C47"
													/>
													<rect
														x="1"
														y="4"
														width="9"
														height="8"
														rx="1.3"
														fill="#C43E1C"
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
														background: "#FFFFFF",
														border: "1px solid #E2DCD3",
														borderRadius: "6px",
														boxShadow: "0 6px 14px rgba(28,25,23,0.10)",
														transform: "rotate(-8deg)",
														transformOrigin: "bottom center",
														zIndex: "1",
														overflow: "hidden",
														display: "flex",
														flexDirection: "column",
													}}
												>
													<div
														style={{ height: "14px", background: "#ED6C47" }}
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
																	background: "#F4B9A6",
																}}
															></span>
															<span
																style={{
																	width: "8px",
																	height: "15px",
																	background: "#F4B9A6",
																}}
															></span>
															<span
																style={{
																	width: "8px",
																	height: "22px",
																	background: "#ED6C47",
																}}
															></span>
															<span style={{ flex: "1" }}></span>
															<span
																style={{
																	width: "30px",
																	height: "3px",
																	background: "#E2DCD3",
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
														background: "#FFFFFF",
														border: "1px solid #E2DCD3",
														borderRadius: "6px",
														boxShadow: "0 6px 14px rgba(28,25,23,0.10)",
														transform: "rotate(8deg)",
														transformOrigin: "bottom center",
														zIndex: "1",
														overflow: "hidden",
														display: "flex",
														flexDirection: "column",
													}}
												>
													<div
														style={{ height: "14px", background: "#ED6C47" }}
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
																	background: "#F4B9A6",
																}}
															></span>
															<span
																style={{
																	width: "8px",
																	height: "15px",
																	background: "#F4B9A6",
																}}
															></span>
															<span
																style={{
																	width: "8px",
																	height: "22px",
																	background: "#ED6C47",
																}}
															></span>
															<span style={{ flex: "1" }}></span>
															<span
																style={{
																	width: "30px",
																	height: "3px",
																	background: "#E2DCD3",
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
														background: "#FFFFFF",
														border: "1px solid #E2DCD3",
														borderRadius: "6px",
														boxShadow: "0 6px 14px rgba(28,25,23,0.10)",
														transform: "rotate(0deg)",
														transformOrigin: "bottom center",
														zIndex: "2",
														overflow: "hidden",
														display: "flex",
														flexDirection: "column",
													}}
												>
													<div
														style={{ height: "14px", background: "#ED6C47" }}
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
																	background: "#F4B9A6",
																}}
															></span>
															<span
																style={{
																	width: "8px",
																	height: "15px",
																	background: "#F4B9A6",
																}}
															></span>
															<span
																style={{
																	width: "8px",
																	height: "22px",
																	background: "#ED6C47",
																}}
															></span>
															<span style={{ flex: "1" }}></span>
															<span
																style={{
																	width: "30px",
																	height: "3px",
																	background: "#E2DCD3",
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
											borderTop: "1px solid #EDEAE6",
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
												color: "#57534E",
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
											background: "#F1F5EE",
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
													background: "#FFFFFF",
													border: "1px solid #E2DCD3",
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
											<span style={{ color: "#A8A29E" }}>{"\u2192"}</span>
											<span
												style={{
													display: "flex",
													alignItems: "center",
													gap: "5px",
													background: "#FFFFFF",
													border: "1px solid #E2DCD3",
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
														background: "#FFFFFF",
														border: "1px solid #E2DCD3",
														borderRadius: "8px",
														width: "108px",
														padding: "9px 10px",
														display: "flex",
														flexDirection: "column",
														gap: "6px",
														boxShadow: "0 6px 14px rgba(28,25,23,0.08)",
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
															background: "#E2DCD3",
															width: "90%",
														}}
													></span>
													<span
														style={{
															height: "3px",
															background: "#E2DCD3",
															width: "70%",
														}}
													></span>
													<span
														style={{
															height: "3px",
															background: "#E2DCD3",
															width: "80%",
														}}
													></span>
												</div>
												<svg
													width="56"
													height="92"
													viewBox="0 0 56 92"
													fill="none"
													stroke="#A8A29E"
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
															background: "#FFFFFF",
															border: "1px solid #E2DCD3",
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
															background: "#FFFFFF",
															border: "1px solid #E2DCD3",
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
															background: "#FFFFFF",
															border: "1px solid #E2DCD3",
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
											borderTop: "1px solid #EDEAE6",
											flex: "1",
										}}
									>
										<b style={{ fontSize: "16px" }}>{"Sharing skills"}</b>
										<span
											style={{
												fontSize: "14px",
												lineHeight: "1.5",
												color: "#57534E",
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
