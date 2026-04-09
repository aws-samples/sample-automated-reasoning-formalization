/**
 * Safe DOM element lookup that throws a descriptive error instead of
 * silently returning null. Replaces bare `document.getElementById(id)!`
 * non-null assertions throughout the codebase.
 */
export function requireElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: ${id}`);
  return el as T;
}
