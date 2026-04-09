/**
 * Tests for useStreamProcessor — focused on the dismissBatch behavior.
 */
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useStreamProcessor } from "./useStreamProcessor";
import type { ChatCard } from "../types";

/** Helper to push a complete card block through the stream processor. */
function pushCard(hook: ReturnType<typeof useStreamProcessor>, card: ChatCard): void {
  hook.pushChunk("```json\n" + JSON.stringify(card) + "\n```");
}

describe("useStreamProcessor.dismissBatch", () => {
  it("marks sibling cards as dismissed and sets summary on chosen card", () => {
    const { result } = renderHook(() => useStreamProcessor());

    // Stream two follow-up-prompt cards in the same batch
    act(() => result.current.startStreaming());
    act(() => pushCard(result.current, { type: "follow-up-prompt", label: "Fix A", prompt: "fix a" } as ChatCard));
    act(() => pushCard(result.current, { type: "follow-up-prompt", label: "Fix B", prompt: "fix b" } as ChatCard));
    act(() => result.current.endStreaming());

    const cards = result.current.segments.filter((s) => s.type === "card");
    expect(cards).toHaveLength(2);
    const batchId = cards[0].batchId!;
    expect(cards[1].batchId).toBe(batchId);

    // Dismiss: user picks the first card
    act(() => result.current.dismissBatch(batchId, cards[0].id));

    const after = result.current.segments.filter((s) => s.type === "card");
    const chosen = after.find((s) => s.id === cards[0].id)!;
    const sibling = after.find((s) => s.id === cards[1].id)!;

    expect(chosen.dismissed).toBeFalsy();
    expect(chosen.dismissSummary).toBe("1 other option dismissed: Fix B");
    expect(sibling.dismissed).toBe(true);
  });

  it("is a no-op when there are no siblings to dismiss", () => {
    const { result } = renderHook(() => useStreamProcessor());

    // Stream a single card
    act(() => result.current.startStreaming());
    act(() => pushCard(result.current, { type: "next-steps", summary: "Run tests", description: "Run all", prompt: "run" } as ChatCard));
    act(() => result.current.endStreaming());

    const cards = result.current.segments.filter((s) => s.type === "card");
    expect(cards).toHaveLength(1);
    const before = [...result.current.segments];

    act(() => result.current.dismissBatch(cards[0].batchId!, cards[0].id));

    // Segments should be unchanged (same reference = no state update)
    expect(result.current.segments).toEqual(before);
  });

  it("pluralizes the summary correctly for multiple dismissed cards", () => {
    const { result } = renderHook(() => useStreamProcessor());

    act(() => result.current.startStreaming());
    act(() => pushCard(result.current, { type: "follow-up-prompt", label: "Option 1", prompt: "p1" } as ChatCard));
    act(() => pushCard(result.current, { type: "follow-up-prompt", label: "Option 2", prompt: "p2" } as ChatCard));
    act(() => pushCard(result.current, { type: "follow-up-prompt", label: "Option 3", prompt: "p3" } as ChatCard));
    act(() => result.current.endStreaming());

    const cards = result.current.segments.filter((s) => s.type === "card");
    expect(cards).toHaveLength(3);

    act(() => result.current.dismissBatch(cards[0].batchId!, cards[1].id));

    const chosen = result.current.segments.find((s) => s.id === cards[1].id)!;
    expect(chosen.dismissSummary).toBe("2 other options dismissed: Option 1, Option 3");
    expect(chosen.dismissed).toBeFalsy();

    const dismissed = result.current.segments.filter((s) => s.type === "card" && s.dismissed);
    expect(dismissed).toHaveLength(2);
  });

  it("does not dismiss cards from a different batch", () => {
    const { result } = renderHook(() => useStreamProcessor());

    // First batch
    act(() => result.current.startStreaming());
    act(() => pushCard(result.current, { type: "follow-up-prompt", label: "Batch1 A", prompt: "b1a" } as ChatCard));
    act(() => result.current.endStreaming());

    // Second batch
    act(() => result.current.startStreaming());
    act(() => pushCard(result.current, { type: "follow-up-prompt", label: "Batch2 A", prompt: "b2a" } as ChatCard));
    act(() => pushCard(result.current, { type: "follow-up-prompt", label: "Batch2 B", prompt: "b2b" } as ChatCard));
    act(() => result.current.endStreaming());

    const allCards = result.current.segments.filter((s) => s.type === "card");
    const batch1Card = allCards.find((s) => s.card && "label" in s.card && s.card.label === "Batch1 A")!;
    const batch2Cards = allCards.filter((s) => s.batchId !== batch1Card.batchId);

    // Dismiss within batch 2
    act(() => result.current.dismissBatch(batch2Cards[0].batchId!, batch2Cards[0].id));

    // Batch 1 card should be untouched
    const batch1After = result.current.segments.find((s) => s.id === batch1Card.id)!;
    expect(batch1After.dismissed).toBeFalsy();
    expect(batch1After.dismissSummary).toBeUndefined();
  });

  it("extracts label from next-steps card summary field", () => {
    const { result } = renderHook(() => useStreamProcessor());

    act(() => result.current.startStreaming());
    act(() => pushCard(result.current, { type: "next-steps", summary: "Run tests", description: "desc", prompt: "run" } as ChatCard));
    act(() => pushCard(result.current, { type: "next-steps", summary: "Add rule", description: "desc", prompt: "add" } as ChatCard));
    act(() => result.current.endStreaming());

    const cards = result.current.segments.filter((s) => s.type === "card");
    act(() => result.current.dismissBatch(cards[0].batchId!, cards[0].id));

    const chosen = result.current.segments.find((s) => s.id === cards[0].id)!;
    // Summary should exist (sibling was dismissed)
    expect(chosen.dismissSummary).toBe("1 other option dismissed: Add rule");
  });
});


describe("useStreamProcessor.streamGeneration", () => {
  it("returns 0 initially", () => {
    const { result } = renderHook(() => useStreamProcessor());
    expect(result.current.streamGeneration()).toBe(0);
  });

  it("increments on clearMessages", () => {
    const { result } = renderHook(() => useStreamProcessor());
    act(() => result.current.clearMessages());
    expect(result.current.streamGeneration()).toBe(1);
    act(() => result.current.clearMessages());
    expect(result.current.streamGeneration()).toBe(2);
  });

  it("does NOT increment on startStreaming", () => {
    const { result } = renderHook(() => useStreamProcessor());
    act(() => result.current.startStreaming());
    expect(result.current.streamGeneration()).toBe(0);
  });

  it("clearMessages then startStreaming keeps the same generation", () => {
    const { result } = renderHook(() => useStreamProcessor());
    act(() => result.current.clearMessages());
    const gen = result.current.streamGeneration();
    act(() => result.current.startStreaming());
    expect(result.current.streamGeneration()).toBe(gen);
  });
});
