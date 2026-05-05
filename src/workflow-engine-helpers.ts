/**
 * WT-NC-06 — Shared helpers extracted from the workflow engine.
 *
 * Lives in its own module so step runners can import without pulling the
 * full engine surface (avoids cyclic imports between
 * `workflow-engine.ts` ↔ `workflow-step-runners/*`).
 */

/** Sentinel key used to thread an action's structured output back to the engine. */
export const CAPTURE_KEY = '__capture' as const;

export interface CaptureSlot {
  output?: unknown;
}

/**
 * Resolve `{{ ... }}` templates inside a string by looking up dot-path keys
 * in `payload`. Returns the original placeholder if the key is not found.
 */
export function resolveTemplate(
  template: string,
  payload: Record<string, unknown>,
): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
    const parts = (key as string).trim().split('.');
    let value: unknown = payload;
    for (const part of parts) {
      if (value !== null && typeof value === 'object') {
        value = (value as Record<string, unknown>)[part];
      } else {
        value = undefined;
        break;
      }
    }
    return value !== undefined ? String(value) : `{{${key}}}`;
  });
}

/**
 * Recursively resolve `{{ ... }}` templates inside a value. Strings go through
 * `resolveTemplate`; objects/arrays are walked. Everything else is returned
 * as-is (numbers, booleans, null).
 */
export function resolveValue(
  value: unknown,
  ctx: Record<string, unknown>,
): unknown {
  if (typeof value === 'string') {
    return resolveTemplate(value, ctx);
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveValue(v, ctx));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveValue(v, ctx);
    }
    return out;
  }
  return value;
}

/** Helper for actions that want to expose an output back to the engine. */
export function setStepOutput(
  context: Record<string, unknown>,
  output: unknown,
): void {
  const slot = context[CAPTURE_KEY] as CaptureSlot | undefined;
  if (slot) slot.output = output;
}
