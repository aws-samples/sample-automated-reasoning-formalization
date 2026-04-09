/**
 * HTML sanitization utility using DOMPurify.
 * Strips dangerous content (scripts, event handlers, javascript: URIs)
 * while preserving standard HTML elements produced by marked.
 */
import DOMPurify from "dompurify";

/**
 * Sanitize HTML and return a DocumentFragment ready for DOM insertion.
 * Avoids innerHTML by using DOMPurify's RETURN_DOM_FRAGMENT option.
 */
export function sanitizeToFragment(dirty: string): DocumentFragment {
  return DOMPurify.sanitize(dirty, { RETURN_DOM_FRAGMENT: true });
}
