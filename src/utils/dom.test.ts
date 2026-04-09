/**
 * Unit tests for DOM utility.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { requireElement } from "./dom";

describe("requireElement", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("returns the element when it exists", () => {
    const div = document.createElement("div");
    div.id = "test-el";
    document.body.appendChild(div);
    expect(requireElement("test-el")).toBe(div);
  });

  it("throws when element does not exist", () => {
    expect(() => requireElement("nonexistent")).toThrow("Missing element: nonexistent");
  });
});
