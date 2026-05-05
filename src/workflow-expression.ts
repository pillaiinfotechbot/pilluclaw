/**
 * WT-NC-06 — Workflow expression DSL evaluator.
 *
 * Tiny TS evaluator for the workflow expression language. Supports the same
 * operator surface as the canonical PHP/JS evaluator owned by WT-WF-04
 * (the canvas validator) — keeping them in lock-step so YAML written for one
 * runs the same on the other.
 *
 * Supported:
 *   - Path access: `$.event.payload.foo`, `$.steps.<id>.output.bar`,
 *     `$.context.x`, `$.workflow.x`, `$.<itemVar>` (loop item)
 *   - Literals: numbers, single-quoted strings, double-quoted strings,
 *     `true` / `false` / `null`
 *   - Comparison: `==`, `!=`, `>=`, `<=`, `>`, `<`
 *   - Logical: `&&`, `||`, `!` (prefix)
 *   - Membership: `in` (left in right-array), `contains` (right-substr in left-string)
 *   - Parentheses for grouping
 *
 * Not supported (deliberate — keep grammar small):
 *   - Function calls
 *   - Arithmetic (+, -, *, /)
 *   - Regex
 *
 * Add ops only when a workflow needs them and the canvas evaluator agrees.
 */

export type ExprValue =
  | string
  | number
  | boolean
  | null
  | unknown[]
  | Record<string, unknown>;

/**
 * Evaluate an expression against a context object. Throws on parse errors.
 * Returns the raw value of the expression (boolean for predicates, scalar
 * for path access, etc.).
 */
export function evaluateExpression(
  expr: string,
  context: Record<string, unknown>,
): ExprValue {
  const tokens = tokenize(expr);
  const parser = new Parser(tokens, context);
  const value = parser.parseExpression();
  if (parser.peek() !== null) {
    throw new Error(
      `Unexpected token "${parser.peek()?.value}" at end of expression: ${expr}`,
    );
  }
  return value;
}

/** Convenience — evaluate as boolean (truthy in JS sense). */
export function evaluatePredicate(
  expr: string,
  context: Record<string, unknown>,
): boolean {
  const value = evaluateExpression(expr, context);
  return Boolean(value);
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenType =
  | 'path'
  | 'number'
  | 'string'
  | 'bool'
  | 'null'
  | 'ident'
  | 'op'
  | 'lparen'
  | 'rparen';

interface Token {
  type: TokenType;
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;

  while (i < n) {
    const ch = input[i];

    // whitespace
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // path: $.foo.bar
    if (ch === '$' && input[i + 1] === '.') {
      let j = i + 2;
      while (j < n && /[a-zA-Z0-9_]/.test(input[j])) j++;
      // allow dotted continuation
      while (j < n && input[j] === '.') {
        j++;
        while (j < n && /[a-zA-Z0-9_]/.test(input[j])) j++;
      }
      tokens.push({ type: 'path', value: input.slice(i, j) });
      i = j;
      continue;
    }

    // number
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n && /[0-9.]/.test(input[j])) j++;
      tokens.push({ type: 'number', value: input.slice(i, j) });
      i = j;
      continue;
    }

    // string — single or double quoted
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      let buf = '';
      while (j < n && input[j] !== quote) {
        if (input[j] === '\\' && j + 1 < n) {
          buf += input[j + 1];
          j += 2;
        } else {
          buf += input[j];
          j++;
        }
      }
      if (j >= n) {
        throw new Error(`Unterminated string at position ${i}`);
      }
      tokens.push({ type: 'string', value: buf });
      i = j + 1; // skip closing quote
      continue;
    }

    // parens
    if (ch === '(') {
      tokens.push({ type: 'lparen', value: ch });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen', value: ch });
      i++;
      continue;
    }

    // multi-char operators
    const two = input.slice(i, i + 2);
    if (
      two === '==' ||
      two === '!=' ||
      two === '>=' ||
      two === '<=' ||
      two === '&&' ||
      two === '||'
    ) {
      tokens.push({ type: 'op', value: two });
      i += 2;
      continue;
    }

    // single-char operators
    if (ch === '>' || ch === '<' || ch === '!') {
      tokens.push({ type: 'op', value: ch });
      i++;
      continue;
    }

    // identifier — `true`, `false`, `null`, `in`, `contains`
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[a-zA-Z0-9_]/.test(input[j])) j++;
      const word = input.slice(i, j);
      if (word === 'true' || word === 'false') {
        tokens.push({ type: 'bool', value: word });
      } else if (word === 'null') {
        tokens.push({ type: 'null', value: word });
      } else if (word === 'in' || word === 'contains') {
        tokens.push({ type: 'op', value: word });
      } else {
        tokens.push({ type: 'ident', value: word });
      }
      i = j;
      continue;
    }

    throw new Error(`Unexpected character '${ch}' at position ${i}`);
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Recursive-descent parser
//
// Grammar (low → high precedence):
//   expr    := or
//   or      := and ( '||' and )*
//   and     := compare ( '&&' compare )*
//   compare := unary ( ( '==' | '!=' | '>=' | '<=' | '>' | '<' | 'in' | 'contains' ) unary )?
//   unary   := '!' unary | primary
//   primary := number | string | bool | null | path | '(' expr ')'
// ---------------------------------------------------------------------------

class Parser {
  private pos = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly context: Record<string, unknown>,
  ) {}

  peek(): Token | null {
    return this.tokens[this.pos] ?? null;
  }

  consume(): Token {
    const t = this.tokens[this.pos];
    this.pos++;
    return t;
  }

  parseExpression(): ExprValue {
    return this.parseOr();
  }

  private parseOr(): ExprValue {
    let left = this.parseAnd();
    while (this.peek()?.type === 'op' && this.peek()?.value === '||') {
      this.consume();
      const right = this.parseAnd();
      left = Boolean(left) || Boolean(right);
    }
    return left;
  }

  private parseAnd(): ExprValue {
    let left = this.parseCompare();
    while (this.peek()?.type === 'op' && this.peek()?.value === '&&') {
      this.consume();
      const right = this.parseCompare();
      left = Boolean(left) && Boolean(right);
    }
    return left;
  }

  private parseCompare(): ExprValue {
    const left = this.parseUnary();
    const tok = this.peek();
    if (tok && tok.type === 'op' && isCompareOp(tok.value)) {
      this.consume();
      const right = this.parseUnary();
      return applyCompare(tok.value, left, right);
    }
    return left;
  }

  private parseUnary(): ExprValue {
    const tok = this.peek();
    if (tok && tok.type === 'op' && tok.value === '!') {
      this.consume();
      const v = this.parseUnary();
      return !v;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ExprValue {
    const tok = this.consume();
    if (!tok) throw new Error('Unexpected end of expression');

    switch (tok.type) {
      case 'number':
        return Number(tok.value);
      case 'string':
        return tok.value;
      case 'bool':
        return tok.value === 'true';
      case 'null':
        return null;
      case 'path':
        return resolvePath(tok.value, this.context) as ExprValue;
      case 'lparen': {
        const inner = this.parseExpression();
        const close = this.consume();
        if (!close || close.type !== 'rparen') {
          throw new Error('Missing closing paren');
        }
        return inner;
      }
      case 'ident':
        throw new Error(
          `Bare identifier '${tok.value}' is not allowed — use $.${tok.value}`,
        );
      default:
        throw new Error(`Unexpected token: ${tok.type} ${tok.value}`);
    }
  }
}

function isCompareOp(op: string): boolean {
  return (
    op === '==' ||
    op === '!=' ||
    op === '>=' ||
    op === '<=' ||
    op === '>' ||
    op === '<' ||
    op === 'in' ||
    op === 'contains'
  );
}

function applyCompare(op: string, left: ExprValue, right: ExprValue): boolean {
  switch (op) {
    case '==':
      // eslint-disable-next-line eqeqeq
      return left == right;
    case '!=':
      // eslint-disable-next-line eqeqeq
      return left != right;
    case '>':
      return (left as number) > (right as number);
    case '<':
      return (left as number) < (right as number);
    case '>=':
      return (left as number) >= (right as number);
    case '<=':
      return (left as number) <= (right as number);
    case 'in':
      if (Array.isArray(right)) return right.includes(left);
      if (typeof right === 'string' && typeof left === 'string') {
        return right.includes(left);
      }
      return false;
    case 'contains':
      if (typeof left === 'string' && typeof right === 'string') {
        return left.includes(right);
      }
      if (Array.isArray(left)) return left.includes(right);
      return false;
    default:
      throw new Error(`Unknown compare op: ${op}`);
  }
}

/**
 * Resolve a `$.a.b.c` path against the context. Returns `undefined` for
 * any missing segment — callers decide how to treat that (predicates treat
 * it as falsy).
 */
function resolvePath(path: string, context: Record<string, unknown>): unknown {
  // strip leading "$."
  const trimmed = path.startsWith('$.') ? path.slice(2) : path;
  if (trimmed.length === 0) return context;
  const parts = trimmed.split('.');
  let value: unknown = context;
  for (const part of parts) {
    if (value === null || value === undefined) return undefined;
    if (typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
