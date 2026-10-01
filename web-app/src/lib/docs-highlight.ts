/**
 * Static syntax highlighting for docs code blocks. Uses the Lezer parsers
 * Atelier's editor already ships, so the docs and the editor tokenize code the
 * same way. Output is HTML with `tok-*` classes (styled in styles.css);
 * unknown languages fall back to plain escaped text.
 */
import { PostgreSQL } from "@codemirror/lang-sql";
import { classHighlighter, highlightCode } from "@lezer/highlight";
import { parser as javascriptParser } from "@lezer/javascript";
import { parser as jsonParser } from "@lezer/json";

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

const typescriptParser = javascriptParser.configure({ dialect: "ts" });

type SyntaxTree = Parameters<typeof highlightCode>[1];
type CodeParser = { parse: (code: string) => SyntaxTree };

const parsers: Record<string, () => CodeParser> = {
	js: () => javascriptParser,
	javascript: () => javascriptParser,
	ts: () => typescriptParser,
	typescript: () => typescriptParser,
	json: () => jsonParser,
	sql: () => PostgreSQL.language.parser,
};

/** Shell has no Lezer grammar here; mark comments, strings, flags, and the command. */
function highlightShell(code: string): string {
	return code
		.split("\n")
		.map((line) => {
			if (/^\s*#/.test(line)) {
				return `<span class="tok-comment">${escapeHtml(line)}</span>`;
			}
			let first = true;
			return line
				.split(/("[^"]*"|'[^']*'|\s+)/)
				.map((part) => {
					if (part === "" || /^\s+$/.test(part)) return part;
					const html = escapeHtml(part);
					if (/^["']/.test(part))
						return `<span class="tok-string">${html}</span>`;
					if (first) {
						first = false;
						return `<span class="tok-keyword">${html}</span>`;
					}
					if (/^--?[\w-]/.test(part)) {
						return `<span class="tok-propertyName">${html}</span>`;
					}
					return html;
				})
				.join("");
		})
		.join("\n");
}

export function highlightDocsCode(code: string, lang: string): string {
	const language = lang.toLowerCase();
	if (language === "sh" || language === "bash" || language === "shell") {
		return highlightShell(code);
	}
	const parser = parsers[language]?.();
	if (!parser) return escapeHtml(code);
	let html = "";
	highlightCode(
		code,
		parser.parse(code),
		classHighlighter,
		(text, classes) => {
			const escaped = escapeHtml(text);
			html += classes ? `<span class="${classes}">${escaped}</span>` : escaped;
		},
		() => {
			html += "\n";
		},
	);
	return html;
}
