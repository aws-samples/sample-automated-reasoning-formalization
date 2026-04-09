/**
 * Maps raw MCP tool titles to user-friendly activity labels with icons.
 *
 * Labels use playful present-tense phrasing with emoji to keep the
 * experience warm while the agent works behind the scenes.
 * The fallback covers unknown tools without exposing internals.
 */

const TOOL_LABEL_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/get-.*policy-definition/i, '📖 Flipping through your rulebook…'],
  [/export-.*policy/i, '📖 Flipping through your rulebook…'],
  [/get-.*policy.*test/i, '🔍 Peeking at test results…'],
  [/list-.*test/i, '📋 Rounding up your tests…'],
  [/run-.*test|execute.?tests/i, '🧪 Running experiments…'],
  [/add.?rules/i, '⚙️ Wiring in new rules…'],
  [/delete.?rules/i, '⚙️ Removing some rules…'],
  [/add.?variables/i, '⚙️ Adding new variables…'],
  [/update.?variables/i, '⚙️ Fine-tuning variables…'],
  [/delete.?variables/i, '⚙️ Cleaning up variables…'],
  [/update.?tests/i, '⚙️ Adjusting test cases…'],
  [/delete.?tests/i, '⚙️ Removing test cases…'],
  [/update-.*policy/i, '✏️ Tweaking your policy…'],
  [/create-.*policy/i, '🛠️ Crafting a fresh policy…'],
  [/search.?(?:rules|variables|document)/i, '🔎 Searching through your policy…'],
  [/find.?related/i, '🔎 Tracing connections…'],
  [/get.?(?:rule|variable).?details/i, '🔎 Looking up the details…'],
  [/get.?section.?rules/i, '🔎 Checking what this section covers…'],
  [/document|section/i, '📄 Scanning your document…'],
  [/scenario/i, '🎭 Playing out scenarios…'],
  [/build|compile/i, '🏗️ Building things up…'],
  [/fidelity|quality/i, '✅ Giving it a quality check…'],
] as const;

/**
 * Convert a raw tool title (e.g. "get-automated-reasoning-policy-definition")
 * to a friendly activity label with icon (e.g. "📖 Flipping through your rulebook…").
 */
export function mapToolToActivityLabel(title: string): string {
  for (const [pattern, label] of TOOL_LABEL_PATTERNS) {
    if (pattern.test(title)) return label;
  }
  return '🔮 Gathering context…';
}
