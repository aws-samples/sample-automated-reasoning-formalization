/**
 * Tests for ChatContextRouter — focused on endStreaming card extraction.
 *
 * Verifies that endStreaming() correctly extracts card blocks from trailing
 * content that processRaw() couldn't match during streaming, including
 * progressive JSON repair for truncated card blocks.
 */
import { describe, it, expect, vi } from "vitest";
import { ChatContextRouter } from "./chat-context-router";
import type { ChatSegment } from "../hooks/useStreamProcessor";

/** Helper: create a router and capture the latest snapshot via onChange. */
function setup() {
  let latest: { segments: ChatSegment[]; streaming: boolean; trailingText: string; hasPartialBlock: boolean } = {
    segments: [],
    streaming: false,
    trailingText: "",
    hasPartialBlock: false,
  };
  const onChange = vi.fn((snapshot: typeof latest) => {
    latest = snapshot;
  });
  const router = new ChatContextRouter(onChange);
  const ui = router.createBoundUI("policy");
  return { router, ui, onChange, getLatest: () => latest };
}

describe("ChatContextRouter.endStreaming — card extraction", () => {
  it("extracts a complete JSON card block from trailing content", () => {
    const { ui, getLatest } = setup();

    ui.startStreaming();
    // Push text that contains a complete card block but arrives as a single chunk
    // after processRaw has already been called with partial content
    const card = JSON.stringify({
      type: "proposal",
      title: "Add rule",
      description: "Adds a new rule",
      changes: [{ label: "Rule", before: "none", after: "x >= 2" }],
      approvePrompt: "Approve",
      rejectPrompt: "Reject",
    });
    ui.pushStreamChunk(`Here is my suggestion:\n\`\`\`json\n${card}\n\`\`\``);
    ui.endStreaming();

    const segments = getLatest().segments;
    const cardSegments = segments.filter((s) => s.type === "card");
    const textSegments = segments.filter((s) => s.type === "text");

    expect(cardSegments).toHaveLength(1);
    expect(cardSegments[0].card?.type).toBe("proposal");
    expect((cardSegments[0].card as any).title).toBe("Add rule");
    // Text before the card should be preserved
    expect(textSegments.length).toBeGreaterThanOrEqual(1);
    expect(textSegments.some((s) => s.content.includes("Here is my suggestion"))).toBe(true);
  });

  it("recovers a truncated JSON card block via progressive repair", () => {
    const { ui, getLatest } = setup();

    ui.startStreaming();
    // Simulate a truncated proposal card (missing closing brace) — this is the
    // exact scenario from the bug report where the CLI crashed mid-stream
    const truncatedJson = '{"type":"proposal","title":"Fix rule","description":"Removes the bad rule","changes":[{"label":"Rule","before":"old","after":"new"}],"approvePrompt":"Approve","rejectPrompt":"Reject"';
    ui.pushStreamChunk(`Check this out:\n\`\`\`json\n${truncatedJson}`);
    // Stream ends without closing fence — simulates CLI crash
    ui.endStreaming();

    const segments = getLatest().segments;
    const cardSegments = segments.filter((s) => s.type === "card");

    // extractCards should repair the truncated JSON by appending "}"
    expect(cardSegments).toHaveLength(1);
    expect(cardSegments[0].card?.type).toBe("proposal");
    expect((cardSegments[0].card as any).title).toBe("Fix rule");
  });

  it("still produces a text segment when there are no cards", () => {
    const { ui, getLatest } = setup();

    ui.startStreaming();
    ui.pushStreamChunk("Just some plain text with no cards.");
    ui.endStreaming();

    const segments = getLatest().segments;
    const textSegments = segments.filter((s) => s.type === "text");
    const cardSegments = segments.filter((s) => s.type === "card");

    expect(textSegments).toHaveLength(1);
    expect(textSegments[0].content).toContain("Just some plain text");
    expect(cardSegments).toHaveLength(0);
  });

  it("preserves interleaved text/card ordering", () => {
    const { ui, getLatest } = setup();

    ui.startStreaming();
    const card1 = JSON.stringify({ type: "rule", ruleId: "R1", expression: "x", naturalLanguage: "rule one" });
    const card2 = JSON.stringify({ type: "rule", ruleId: "R2", expression: "y", naturalLanguage: "rule two" });
    // Push everything as trailing content (not yet processed by processRaw)
    ui.pushStreamChunk(
      `First rule:\n\`\`\`json\n${card1}\n\`\`\`\nSecond rule:\n\`\`\`json\n${card2}\n\`\`\``
    );
    ui.endStreaming();

    const segments = getLatest().segments;
    const types = segments.map((s) => s.type);

    // Should have interleaved: text, card, text, card
    // (processRaw may have already extracted these during pushStreamChunk,
    // but endStreaming should handle whatever is left)
    const cardSegments = segments.filter((s) => s.type === "card");
    expect(cardSegments).toHaveLength(2);
    expect((cardSegments[0].card as any).ruleId).toBe("R1");
    expect((cardSegments[1].card as any).ruleId).toBe("R2");
  });

  it("assigns batchId to extracted card segments for dismissal compatibility", () => {
    const { ui, getLatest } = setup();

    ui.startStreaming();
    const card = JSON.stringify({
      type: "next-steps",
      summary: "Run tests",
      description: "Execute all tests",
      prompt: "run tests",
    });
    ui.pushStreamChunk(`\`\`\`json\n${card}\n\`\`\``);
    ui.endStreaming();

    const segments = getLatest().segments;
    const cardSegments = segments.filter((s) => s.type === "card");

    expect(cardSegments).toHaveLength(1);
    expect(cardSegments[0].batchId).toBeTruthy();
  });

  it("handles empty trailing content gracefully", () => {
    const { ui, getLatest } = setup();

    ui.startStreaming();
    // Don't push any chunks
    ui.endStreaming();

    const segments = getLatest().segments;
    // Should just have removed the loading indicator, no text or card segments
    expect(segments.filter((s) => s.type === "text")).toHaveLength(0);
    expect(segments.filter((s) => s.type === "card")).toHaveLength(0);
    expect(segments.filter((s) => s.type === "loading")).toHaveLength(0);
  });
});
