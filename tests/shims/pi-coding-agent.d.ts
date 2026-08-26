// Mirror of @earendil-works/pi-coding-agent extension types used by pipeline-guard.
// smoke.sh typechecks against the real package when npm can install it; this
// file is the offline fallback and must keep the same overloads.

export interface ToolCallEventBase {
	type: "tool_call";
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
}

export interface BashToolCallEvent extends ToolCallEventBase {
	toolName: "bash";
	input: { command?: string; timeout?: number };
}

export interface PowerShellToolCallEvent extends ToolCallEventBase {
	toolName: "powershell";
	input: { command?: string; timeout?: number };
}

export interface WriteToolCallEvent extends ToolCallEventBase {
	toolName: "write";
	input: { path?: string; content?: string };
}

export interface EditToolCallEvent extends ToolCallEventBase {
	toolName: "edit";
	input: { path?: string; oldText?: string; newText?: string };
}

export type ToolCallEvent =
	| BashToolCallEvent
	| PowerShellToolCallEvent
	| WriteToolCallEvent
	| EditToolCallEvent
	| (ToolCallEventBase & { toolName: string });

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

export function isToolCallEventType(toolName: "bash", event: ToolCallEvent): event is BashToolCallEvent;
export function isToolCallEventType(
	toolName: "powershell",
	event: ToolCallEvent,
): event is PowerShellToolCallEvent;
export function isToolCallEventType(toolName: "write", event: ToolCallEvent): event is WriteToolCallEvent;
export function isToolCallEventType(toolName: "edit", event: ToolCallEvent): event is EditToolCallEvent;
export function isToolCallEventType(toolName: string, event: ToolCallEvent): boolean;
