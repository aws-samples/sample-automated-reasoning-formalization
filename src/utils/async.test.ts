/**
 * Unit tests for async utilities.
 */
import { describe, it, expect } from "vitest";
import { withTimeout } from "./async";

describe("withTimeout", () => {
  it("resolves when promise completes before timeout", async () => {
    const result = await withTimeout(Promise.resolve("done"), 1000, "test");
    expect(result).toBe("done");
  });

  it("rejects when timeout fires first", async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 5000));
    await expect(withTimeout(slow, 10, "slowOp")).rejects.toThrow(
      "slowOp timed out after 10ms",
    );
  });

  it("includes label in timeout error message", async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 5000));
    await expect(withTimeout(slow, 10, "myLabel")).rejects.toThrow("myLabel");
  });

  it("propagates rejection from the original promise", async () => {
    const failing = Promise.reject(new Error("original error"));
    await expect(withTimeout(failing, 1000, "test")).rejects.toThrow("original error");
  });
});
