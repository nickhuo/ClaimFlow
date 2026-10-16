import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { BUSINESS_TOOL_NAMES, type BusinessToolName } from "../../tools/contracts.ts";

const guardedTool = Symbol("guarded-business-tool");

export type BusinessTool = ToolDefinition & {
  name: BusinessToolName;
  [guardedTool]: true;
};

export function defineBusinessTool<Params extends TSchema, Details = unknown>(
  definition: ToolDefinition<Params, Details> & {
    name: BusinessToolName;
    authorize: (input: Static<Params>, signal: AbortSignal | undefined) => void | Promise<void>;
  },
) {
  const { authorize, execute, ...tool } = definition;
  const registered = defineTool({
    ...tool,
    exposure: "direct",
    executionMode: "sequential",
    async execute(...args: Parameters<typeof execute>) {
      args[2]?.throwIfAborted();
      await authorize(args[1], args[2]);
      args[2]?.throwIfAborted();
      return execute(...args);
    },
  });
  return Object.assign(registered, { name: definition.name, [guardedTool]: true as const });
}

export function registerBusinessTools(tools: readonly BusinessTool[]) {
  const names = new Set<BusinessToolName>();
  for (const tool of tools) {
    if (!(BUSINESS_TOOL_NAMES as readonly string[]).includes(tool.name)) {
      throw new Error("Only registered business tool names are allowed");
    }
    if (tool[guardedTool] !== true) throw new Error("Business tools must use defineBusinessTool authorization");
    if (names.has(tool.name)) throw new Error(`Duplicate business tool: ${tool.name}`);
    if (tool.reachesTools) throw new Error("Business tools cannot expose a tool dispatcher");
    names.add(tool.name);
  }
  return {
    names: [...names],
    tools: tools.map((tool) => ({ ...tool, exposure: "direct" as const, executionMode: "sequential" as const })),
  };
}
