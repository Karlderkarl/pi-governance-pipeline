export function readStates(pipelineDir: string): Record<string, unknown>;
export function formatStatus(states: Record<string, unknown>): string;
export function statusText(pipelineDir: string): string;
export function statusCommand(argv: string[], options?: { root?: string }): Promise<number>;
