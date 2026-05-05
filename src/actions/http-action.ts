/**
 * WT-NC-07 — `type: http` action handler.
 *
 * Generic HTTP call. URL / headers / body are templated and resolved from the
 * input/context at execution time. Retries with linear backoff on network or
 * 5xx errors; 4xx is fatal.
 *
 * Output:
 *   - response body parsed as JSON when Content-Type starts with application/json,
 *     otherwise kept as string
 *   - if `output_path` is set, the value at that JSONPath-ish key is extracted
 *     (supports `$.foo.bar` and `data.items.0.id`-style — minimal subset)
 *   - shape: `{ data, status, headers }`
 */
import { ActionHandler } from '../action-registry.js';
import { setStepOutput, resolveTemplate } from '../workflow-engine-helpers.js';
import { logger } from '../logger.js';
import type { HttpActionDef } from '../workflow-types.js';

export class HttpAction implements ActionHandler {
  constructor(
    private readonly def: HttpActionDef,
    private readonly fetchFn: typeof fetch = (...args) => fetch(...args),
  ) {}

  name(): string {
    return this.def.name;
  }

  async execute(
    config: Record<string, unknown>,
    context: Record<string, unknown>,
  ): Promise<void> {
    const tplCtx: Record<string, unknown> = {
      ...context,
      input: config,
    };

    const url = resolveTemplate(this.def.url, tplCtx);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.def.headers)) {
      headers[k] = resolveTemplate(v, tplCtx);
    }

    let body: string | undefined;
    if (this.def.body !== undefined) {
      const resolved = this.resolveBody(this.def.body, tplCtx, config);
      body = typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
      if (!headers['Content-Type'] && typeof resolved !== 'string') {
        headers['Content-Type'] = 'application/json';
      }
    }

    const maxAttempts = (this.def.retry?.max ?? 0) + 1;
    const backoffMs = this.def.retry?.backoff_ms ?? 0;

    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await this.fetchFn(url, {
          method: this.def.method,
          headers,
          body: this.def.method === 'GET' ? undefined : body,
          signal: AbortSignal.timeout(this.def.timeout_ms),
        });

        if (res.status >= 500 && attempt < maxAttempts) {
          lastErr = new Error(`HTTP ${res.status}`);
          await sleep(backoffMs);
          continue;
        }

        const text = await res.text();
        const ct = res.headers.get('content-type') ?? '';
        let parsed: unknown = text;
        if (ct.toLowerCase().includes('application/json')) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = text;
          }
        }

        if (!res.ok) {
          throw new Error(
            `HttpAction[${this.def.name}]: ${this.def.method} ${url} → ${res.status} ${text.slice(0, 200)}`,
          );
        }

        const data = this.def.output_path
          ? extractByPath(parsed, this.def.output_path)
          : parsed;

        setStepOutput(context, {
          data,
          status: res.status,
          headers: Object.fromEntries(res.headers.entries()),
        });
        return;
      } catch (err) {
        lastErr = err;
        const isNetworkOrTimeout =
          err instanceof Error &&
          (err.name === 'AbortError' ||
            err.name === 'TimeoutError' ||
            err.message.startsWith('HTTP 5'));
        if (isNetworkOrTimeout && attempt < maxAttempts) {
          logger.debug(
            { err, attempt, action: this.def.name },
            'HttpAction: retrying',
          );
          await sleep(backoffMs);
          continue;
        }
        throw err;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`HttpAction[${this.def.name}]: exhausted retries`);
  }

  private resolveBody(
    body: unknown,
    tplCtx: Record<string, unknown>,
    rawInput: Record<string, unknown>,
  ): unknown {
    if (typeof body === 'string') {
      const trimmed = body.trim();
      if (trimmed === '{{input}}') return rawInput;
      return resolveTemplate(body, tplCtx);
    }
    if (Array.isArray(body)) {
      return body.map((v) => this.resolveBody(v, tplCtx, rawInput));
    }
    if (body !== null && typeof body === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
        out[k] = this.resolveBody(v, tplCtx, rawInput);
      }
      return out;
    }
    return body;
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

/**
 * Minimal JSONPath-ish extractor. Supports leading `$.`, dot-paths, and
 * numeric segments for arrays. Returns undefined on miss.
 */
export function extractByPath(value: unknown, path: string): unknown {
  let p = path.startsWith('$.') ? path.slice(2) : path;
  if (p.startsWith('$')) p = p.slice(1);
  if (!p) return value;
  const parts = p.split('.').filter(Boolean);
  let cur: unknown = value;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(part)) {
      cur = cur[Number(part)];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}
