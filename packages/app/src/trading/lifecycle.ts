import { createHash } from "node:crypto";

export const EXECUTION_STATUSES = [
  "created",
  "submitted",
  "pending",
  "confirmed",
  "settled",
  "failed",
] as const;

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

const ALLOWED_TRANSITIONS: Record<ExecutionStatus, readonly ExecutionStatus[]> = {
  created: ["submitted", "failed"],
  submitted: ["pending", "confirmed", "failed"],
  pending: ["confirmed", "failed"],
  confirmed: ["settled", "failed"],
  settled: [],
  failed: [],
};

export function canTransition(from: ExecutionStatus, to: ExecutionStatus): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ExecutionStatus, to: ExecutionStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`invalid execution transition: ${from} -> ${to}`);
  }
}

/** Stable JSON serialization for request idempotency. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export function hashExecutionRequest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
