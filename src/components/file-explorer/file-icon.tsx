import {
	File,
	FileArchive,
	FileAudio,
	FileCode,
	FileImage,
	FileSpreadsheet,
	FileText,
	FileVideo,
	Folder,
	type LucideIcon,
} from "lucide-react";
import { cn } from "~/lib/utils";

const EXTENSION_ICONS: Record<string, LucideIcon> = {
	png: FileImage,
	jpg: FileImage,
	jpeg: FileImage,
	gif: FileImage,
	webp: FileImage,
	svg: FileImage,
	avif: FileImage,
	ico: FileImage,
	bmp: FileImage,
	heic: FileImage,
	mp4: FileVideo,
	mov: FileVideo,
	webm: FileVideo,
	mkv: FileVideo,
	avi: FileVideo,
	mp3: FileAudio,
	wav: FileAudio,
	ogg: FileAudio,
	flac: FileAudio,
	m4a: FileAudio,
	aac: FileAudio,
	zip: FileArchive,
	tar: FileArchive,
	gz: FileArchive,
	tgz: FileArchive,
	rar: FileArchive,
	"7z": FileArchive,
	bz2: FileArchive,
	zst: FileArchive,
	js: FileCode,
	mjs: FileCode,
	cjs: FileCode,
	ts: FileCode,
	jsx: FileCode,
	tsx: FileCode,
	py: FileCode,
	rs: FileCode,
	go: FileCode,
	java: FileCode,
	c: FileCode,
	cpp: FileCode,
	h: FileCode,
	css: FileCode,
	html: FileCode,
	json: FileCode,
	yaml: FileCode,
	yml: FileCode,
	toml: FileCode,
	sh: FileCode,
	sql: FileCode,
	xls: FileSpreadsheet,
	xlsx: FileSpreadsheet,
	csv: FileSpreadsheet,
	ods: FileSpreadsheet,
	txt: FileText,
	md: FileText,
	pdf: FileText,
	doc: FileText,
	docx: FileText,
	rtf: FileText,
	odt: FileText,
};

export function EntryIcon({
	kind,
	name,
	className,
}: {
	kind: "dir" | "file";
	name: string;
	className?: string;
}) {
	if (kind === "dir") {
		return (
			<Folder
				aria-hidden="true"
				className={cn("size-4 shrink-0 fill-muted-foreground/20 text-muted-foreground", className)}
			/>
		);
	}
	const extension = name.includes(".") ? name.split(".").pop()?.toLowerCase() : undefined;
	const Icon = (extension && EXTENSION_ICONS[extension]) || File;
	return (
		<Icon
			aria-hidden="true"
			className={cn("size-4 shrink-0 text-muted-foreground", className)}
		/>
	);
}
