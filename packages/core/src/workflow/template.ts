/**
 * `{{path}}` template resolution for the workflow DSL.
 * Paths are dotted lookups into the run scope: `{{inputs.x}}`, `{{vars.y}}`,
 * `{{stepIdOrSaveAs.field}}`.
 */

export type TemplateScope = Record<string, unknown>;

const FULL_REF = /^\{\{\s*([^{}]+?)\s*\}\}$/;
const EMBEDDED_REF = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** Resolve a dotted path into a scope object. Missing segments → undefined. */
export function resolvePath(path: string, scope: TemplateScope): unknown {
  const segments = path.split('.');
  let current: unknown = scope;
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

/**
 * Resolve a single string value:
 * - A string that is EXACTLY one `{{ref}}` returns the raw resolved value
 *   (preserving its type — number, boolean, object, ...). Missing → undefined.
 * - A string with embedded refs interpolates each as a string; missing refs
 *   interpolate as '' and objects as JSON.
 * - Non-strings are returned unchanged.
 */
export function resolveTemplate(value: unknown, scope: TemplateScope): unknown {
  if (typeof value !== 'string') return value;
  const full = FULL_REF.exec(value);
  if (full) {
    return resolvePath(full[1]!, scope);
  }
  return value.replace(EMBEDDED_REF, (_m, path: string) => {
    const resolved = resolvePath(path, scope);
    if (resolved === undefined || resolved === null) return '';
    if (typeof resolved === 'object') return JSON.stringify(resolved);
    return String(resolved);
  });
}

/** Recursively resolve templates inside plain objects/arrays/strings. */
export function resolveDeep(value: unknown, scope: TemplateScope): unknown {
  if (typeof value === 'string') return resolveTemplate(value, scope);
  if (Array.isArray(value)) return value.map((v) => resolveDeep(v, scope));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveDeep(v, scope);
    }
    return out;
  }
  return value;
}
