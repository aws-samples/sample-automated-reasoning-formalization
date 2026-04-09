/**
 * Tests for the LandingScreen component.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { LandingScreen } from "./LandingScreen";

describe("LandingScreen", () => {
  it("renders the app title and subtitle", () => {
    render(<LandingScreen onNewPolicy={() => {}} onOpenPolicy={() => {}} />);
    expect(screen.getByText("ARchitect")).toBeTruthy();
    expect(screen.getByText("Automated Reasoning policy editor")).toBeTruthy();
  });

  it("renders Import Document and Open Existing Policy buttons", () => {
    render(<LandingScreen onNewPolicy={() => {}} onOpenPolicy={() => {}} />);
    expect(screen.getByText("Import Document")).toBeTruthy();
    expect(screen.getByText("Open Existing Policy")).toBeTruthy();
  });

  it("calls onNewPolicy when Import Document is clicked", () => {
    const onNew = vi.fn();
    render(<LandingScreen onNewPolicy={onNew} onOpenPolicy={() => {}} />);
    screen.getByText("Import Document").click();
    expect(onNew).toHaveBeenCalledOnce();
  });

  it("calls onOpenPolicy when Open Existing Policy is clicked", () => {
    const onOpen = vi.fn();
    render(<LandingScreen onNewPolicy={() => {}} onOpenPolicy={onOpen} />);
    screen.getByText("Open Existing Policy").click();
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
