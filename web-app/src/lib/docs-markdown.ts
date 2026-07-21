/**
 * Minimal markdown renderer for the LixRay docs site. Supports h1-h4,
 * paragraphs, fenced code, inline code, bold, italic, links, ul/ol, tables,
 * blockquotes, and hr. Strips YAML frontmatter and emits heading ids for deep
 * links. Relative *.md links resolve to their /docs/<slug> route.
 */

export interface DocsHeading {
	level: number;
	text: string;
	id: string;
}

export interface RenderedDocs {
	html: string;
	headings: DocsHeading[];
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function headingId(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\w\s-]/g, "")
		.trim()
		.replace(/\s+/g, "-");
}

function renderInline(markdown: string): string {
	let out = escapeHtml(markdown);
	out = out.replace(/`([^`]+)`/g, (_, code: string) => `<code>${code}</code>`);
	out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
	out = out.replace(
		/\[([^\]]+)\]\(([^)\s]+)\)/g,
		(_, label: string, href: string) => {
			if (/^https?:/.test(href)) {
				return `<a href="${href}" target="_blank" rel="noopener">${label}</a>`;
			}
			const docLink = href.match(/^(?:\.\/)?([\w./-]+)\.md(#.*)?$/);
			if (docLink) {
				return `<a href="/docs/${docLink[1]}${docLink[2] ?? ""}">${label}</a>`;
			}
			return `<a href="${href}">${label}</a>`;
		},
	);
	return out;
}

export function renderDocsMarkdown(markdown: string): RenderedDocs {
	const source = markdown.replace(/^---\n[\s\S]*?\n---\n/, "");
	const lines = source.split("\n");
	const out: string[] = [];
	const headings: DocsHeading[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (/^```/.test(line)) {
			const lang = line.slice(3).trim();
			const buf: string[] = [];
			i++;
			while (i < lines.length && !/^```/.test(lines[i])) {
				buf.push(lines[i]);
				i++;
			}
			i++;
			out.push(
				`<pre data-lang="${escapeHtml(lang)}"><code>${escapeHtml(buf.join("\n"))}</code></pre>`,
			);
			continue;
		}
		const heading = line.match(/^(#{1,4})\s+(.*)$/);
		if (heading) {
			const level = heading[1].length;
			const text = heading[2].replace(/\s*\{#.*\}$/, "");
			const id = headingId(text.replace(/`/g, ""));
			if (level >= 2 && level <= 3) {
				headings.push({ level, text: text.replace(/`/g, ""), id });
			}
			out.push(
				`<h${level} id="${id}">${renderInline(text)}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${level}>`,
			);
			i++;
			continue;
		}
		if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
			out.push("<hr>");
			i++;
			continue;
		}
		if (/^>/.test(line)) {
			const buf: string[] = [];
			while (i < lines.length && /^>/.test(lines[i])) {
				buf.push(lines[i].replace(/^>\s?/, ""));
				i++;
			}
			out.push(
				`<blockquote>${renderDocsMarkdown(buf.join("\n")).html}</blockquote>`,
			);
			continue;
		}
		if (
			/^\s*\|/.test(line) &&
			i + 1 < lines.length &&
			/^\s*\|[\s:|-]+\|?\s*$/.test(lines[i + 1])
		) {
			const headCells = line
				.split("|")
				.slice(1, -1)
				.map((cell) => cell.trim());
			i += 2;
			const rows: string[][] = [];
			while (i < lines.length && /^\s*\|/.test(lines[i])) {
				rows.push(
					lines[i]
						.split("|")
						.slice(1, -1)
						.map((cell) => cell.trim()),
				);
				i++;
			}
			out.push(
				`<table><thead><tr>${headCells
					.map((cell) => `<th>${renderInline(cell)}</th>`)
					.join("")}</tr></thead><tbody>${rows
					.map(
						(row) =>
							`<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`,
					)
					.join("")}</tbody></table>`,
			);
			continue;
		}
		const listItem = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
		if (listItem) {
			const tag = /\d/.test(listItem[2]) ? "ol" : "ul";
			const items: string[] = [];
			while (i < lines.length) {
				const match = lines[i].match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
				if (!match) {
					if (/^\s{2,}\S/.test(lines[i]) && items.length > 0) {
						items[items.length - 1] += ` ${lines[i].trim()}`;
						i++;
						continue;
					}
					break;
				}
				items.push(match[3]);
				i++;
			}
			out.push(
				`<${tag}>${items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</${tag}>`,
			);
			continue;
		}
		if (line.trim() === "") {
			i++;
			continue;
		}
		const buf = [line];
		i++;
		while (
			i < lines.length &&
			lines[i].trim() !== "" &&
			!/^(#{1,4}\s|```|>|\s*\||\s*([-*]|\d+\.)\s|\s*(---|\*\*\*)\s*$)/.test(
				lines[i],
			)
		) {
			buf.push(lines[i]);
			i++;
		}
		out.push(`<p>${renderInline(buf.join(" "))}</p>`);
	}
	return { html: out.join("\n"), headings };
}
