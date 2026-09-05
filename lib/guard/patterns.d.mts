export const DESTRUCTIVE: Array<{ pattern: RegExp; reason: string }>;
export const PRIVILEGED: Array<{ pattern: RegExp; reason: string }>;
export const WRITE_PATTERNS: RegExp[];
export function shellWritesGovernance(command: string): string | undefined;
export function governancePath(path: string): string | undefined;
