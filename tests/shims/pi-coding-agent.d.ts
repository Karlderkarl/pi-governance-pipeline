export type ToolCallEvent = {
	toolName: string;
	input: { command?: string; path?: string };
};

export type ToolContext = {
	hasUI: boolean;
	cwd: string;
	ui: {
		confirm(title: string, body: string): Promise<boolean>;
		notify(message: string, level: string): void;
	};
};

export type ExtensionAPI = {
	on(
		event: "tool_call",
		handler: (event: ToolCallEvent, ctx: ToolContext) => Promise<unknown>,
	): void;
	registerCommand(
		name: string,
		spec: {
			description: string;
			handler: (args: unknown, ctx: ToolContext) => Promise<void>;
		},
	): void;
	registerTool(spec: {
		name: string;
		label: string;
		description: string;
		parameters: unknown;
		execute: (
			toolCallId: string,
			params: { root_id?: string },
			signal: unknown,
			onUpdate: unknown,
			ctx: ToolContext,
		) => Promise<unknown>;
	}): void;
};

export function isToolCallEventType(name: string, event: ToolCallEvent): boolean;
