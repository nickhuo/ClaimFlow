import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import {
  BUSINESS_TOOL_SCHEMAS,
  type BusinessToolContracts,
  type BusinessToolName,
} from "../../application/tool-contracts.ts";

const guardedTool = Symbol("guarded-business-tool");
const definitions = new WeakSet<BusinessTool>();

export type BusinessTool = ToolDefinition & {
  readonly name: BusinessToolName;
  readonly [guardedTool]: true;
};

export interface BusinessToolDefinition<Name extends BusinessToolName> {
  readonly name: Name;
  readonly label: string;
  readonly description: string;
  readonly authorize: (
    input: BusinessToolContracts[NoInfer<Name>]["input"],
    signal: AbortSignal | undefined,
  ) => void | Promise<void>;
  readonly execute: (
    input: BusinessToolContracts[NoInfer<Name>]["input"],
    signal: AbortSignal | undefined,
  ) => Promise<BusinessToolContracts[NoInfer<Name>]["output"]>;
}

export class BusinessToolContractError extends Error {
  constructor(
    readonly toolName: BusinessToolName,
    readonly direction: "input" | "output",
  ) {
    super(`Invalid ${toolName} ${direction}`);
    this.name = "BusinessToolContractError";
  }
}

export function defineBusinessTool<const Name extends BusinessToolName>(
  definition: BusinessToolDefinition<Name>,
): BusinessTool {
  const { name, label, description, authorize, execute } = definition;
  if (!Object.hasOwn(BUSINESS_TOOL_SCHEMAS, name))
    throw new Error("Only registered business tool names are allowed");
  if ("parameters" in definition || "outputSchema" in definition)
    throw new Error("Business tool schemas are owned by the contract");
  const contract = BUSINESS_TOOL_SCHEMAS[name];
  const snapshot = (value: unknown, direction: "input" | "output") => {
    try {
      const copy: unknown = structuredClone(value);
      if (Check(contract[direction], copy)) return copy;
    } catch {
      // Clone and validator diagnostics can contain rejected PII; expose only the contract name.
    }
    throw new BusinessToolContractError(name, direction);
  };
  const registered = defineTool({
    name,
    label,
    description,
    parameters: contract.input,
    outputSchema: contract.output,
    exposure: "direct",
    executionMode: "sequential",
    async execute(_id, rawInput, signal) {
      signal?.throwIfAborted();
      // This cast follows the runtime check against the same schema that derives the type.
      const input = snapshot(rawInput, "input") as BusinessToolContracts[Name]["input"];
      await authorize(input, signal);
      signal?.throwIfAborted();
      const output = snapshot(await execute(input, signal), "output");
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        details: output,
        structuredContent: output,
      };
    },
  });
  const tool = Object.freeze(Object.assign(registered, { name, [guardedTool]: true as const }));
  definitions.add(tool);
  return tool;
}

export function registerBusinessTools(tools: readonly BusinessTool[]) {
  const names = new Set<BusinessToolName>();
  for (const tool of tools) {
    if (!Object.hasOwn(BUSINESS_TOOL_SCHEMAS, tool.name)) {
      throw new Error("Only registered business tool names are allowed");
    }
    if (!definitions.has(tool))
      throw new Error("Business tools must use defineBusinessTool authorization");
    if (names.has(tool.name)) throw new Error(`Duplicate business tool: ${tool.name}`);
    if (tool.reachesTools) throw new Error("Business tools cannot expose a tool dispatcher");
    names.add(tool.name);
  }
  return {
    names: [...names],
    tools: tools.map((tool) => ({
      ...tool,
      exposure: "direct" as const,
      executionMode: "sequential" as const,
    })),
  };
}
