// Minimal Node types for the isolated tsc gate. CI has no @types/node on
// the module path; a developer machine often has one via a global pi install,
// which is why this check can pass locally and fail on the release runner.
declare module "node:fs" {
	export function readFileSync(path: string, encoding?: string): string;
	export function readdirSync(path: string): string[];
	export function existsSync(path: string): boolean;
}

declare module "node:path" {
	export function join(...parts: string[]): string;
}

declare const process: {
	env: Record<string, string | undefined>;
};
