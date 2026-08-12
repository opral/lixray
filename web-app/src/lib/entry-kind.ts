/** The two persisted workspace entry surfaces. */
export const EntryKind = {
	File: "file",
	Directory: "directory",
} as const;

export type EntryKind = (typeof EntryKind)[keyof typeof EntryKind];
