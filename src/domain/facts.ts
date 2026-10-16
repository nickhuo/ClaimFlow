/** Caller statements are hints, not identity evidence, authorization or case facts. */
export interface UserStatement<Value> {
  readonly origin: "user";
  readonly turnId: string;
  readonly value: Value;
}

export interface FactSource {
  readonly adapter: string;
  readonly resource: string;
  readonly pointer: string;
}

export interface DataFact<Value> {
  readonly sources: readonly FactSource[];
  readonly observedAt: number;
  readonly value: Value;
}

/** A trusted business operation adds attribution; it does not grant permissions. */
export interface ToolFact<Value> extends DataFact<Value> {
  readonly origin: "tool";
  readonly toolName: string;
  readonly operationId: string;
}
