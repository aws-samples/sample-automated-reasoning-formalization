/**
 * Tests for the BuildingScreen component.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { BuildingScreen } from "./BuildingScreen";

describe("BuildingScreen", () => {
  it("renders title and status text when not in error state", () => {
    render(
      <BuildingScreen title="Creating policy…" statusText="Reading document" error={null} onBack={() => {}} />
    );
    expect(screen.getByText("Creating policy…")).toBeTruthy();
    expect(screen.getByText("Reading document")).toBeTruthy();
  });

  it("does not show error alert when not in error state", () => {
    render(
      <BuildingScreen title="Creating policy…" statusText="Reading document" error={null} onBack={() => {}} />
    );
    // No error alert, no Back button — just title and status
    expect(screen.queryByText("Back")).toBeNull();
    expect(screen.getByText("Reading document")).toBeTruthy();
  });

  it("shows error alert and back button when error is set", () => {
    const onBack = vi.fn();
    render(
      <BuildingScreen title="Something went wrong" statusText="" error="Network error" onBack={onBack} />
    );
    expect(screen.getByText("Network error")).toBeTruthy();
    expect(screen.getByText("Back")).toBeTruthy();
  });

  it("calls onBack when Back button is clicked in error state", () => {
    const onBack = vi.fn();
    render(
      <BuildingScreen title="Something went wrong" statusText="" error="Network error" onBack={onBack} />
    );
    screen.getByText("Back").click();
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("does not show error alert when error is null", () => {
    render(
      <BuildingScreen title="Creating policy…" statusText="Working" error={null} onBack={() => {}} />
    );
    expect(screen.queryByText("Back")).toBeNull();
  });
});
