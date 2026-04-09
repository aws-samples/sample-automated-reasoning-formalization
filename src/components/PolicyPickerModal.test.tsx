/**
 * Tests for the PolicyPickerModal component.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { PolicyPickerModal } from "./PolicyPickerModal";

describe("PolicyPickerModal", () => {
  const mockPolicies = [
    { policyArn: "arn:aws:test:1", name: "HR Policy", updatedAt: new Date("2025-06-15") },
    { policyArn: "arn:aws:test:2", name: "Leave Policy", createdAt: new Date("2025-01-10") },
    { policyArn: "arn:aws:test:3", name: "Travel Policy", updatedAt: new Date("2025-03-20") },
  ];

  it("shows loading state initially when visible", async () => {
    const fetchPolicies = vi.fn(() => new Promise<typeof mockPolicies>(() => {})); // never resolves
    render(
      <PolicyPickerModal visible={true} fetchPolicies={fetchPolicies} onSelect={() => {}} onDismiss={() => {}} />
    );
    expect(screen.getByText("Finding your policies…")).toBeTruthy();
  });

  it("shows policies in a table after loading", async () => {
    const fetchPolicies = vi.fn().mockResolvedValue(mockPolicies);
    render(
      <PolicyPickerModal visible={true} fetchPolicies={fetchPolicies} onSelect={() => {}} onDismiss={() => {}} />
    );
    await waitFor(() => {
      expect(screen.getByText("HR Policy")).toBeTruthy();
      expect(screen.getByText("Leave Policy")).toBeTruthy();
    });
  });

  it("shows empty state when no policies exist", async () => {
    const fetchPolicies = vi.fn().mockResolvedValue([]);
    render(
      <PolicyPickerModal visible={true} fetchPolicies={fetchPolicies} onSelect={() => {}} onDismiss={() => {}} />
    );
    await waitFor(() => {
      expect(screen.getByText("No policies yet")).toBeTruthy();
    });
  });

  it("shows error state when fetch fails", async () => {
    const fetchPolicies = vi.fn().mockRejectedValue(new Error("Network error"));
    render(
      <PolicyPickerModal visible={true} fetchPolicies={fetchPolicies} onSelect={() => {}} onDismiss={() => {}} />
    );
    await waitFor(() => {
      expect(screen.getByText("We couldn't load your policies")).toBeTruthy();
    });
  });

  it("calls onDismiss when Cancel is clicked", async () => {
    const onDismiss = vi.fn();
    const fetchPolicies = vi.fn().mockResolvedValue(mockPolicies);
    render(
      <PolicyPickerModal visible={true} fetchPolicies={fetchPolicies} onSelect={() => {}} onDismiss={onDismiss} />
    );
    await waitFor(() => screen.getByText("HR Policy"));
    screen.getByText("Cancel").click();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("does not fetch policies when not visible", () => {
    const fetchPolicies = vi.fn().mockResolvedValue(mockPolicies);
    render(
      <PolicyPickerModal visible={false} fetchPolicies={fetchPolicies} onSelect={() => {}} onDismiss={() => {}} />
    );
    expect(fetchPolicies).not.toHaveBeenCalled();
  });

  describe("text filter", () => {
    it("filters policies by name when user types in the filter", async () => {
      const fetchPolicies = vi.fn().mockResolvedValue(mockPolicies);
      render(
        <PolicyPickerModal visible={true} fetchPolicies={fetchPolicies} onSelect={() => {}} onDismiss={() => {}} />
      );
      await waitFor(() => screen.getByText("HR Policy"));

      const filterInput = screen.getByPlaceholderText("Find a policy by name");
      fireEvent.change(filterInput, { target: { value: "Leave" } });

      await waitFor(() => {
        expect(screen.getByText("Leave Policy")).toBeTruthy();
        expect(screen.queryByText("HR Policy")).toBeNull();
        expect(screen.queryByText("Travel Policy")).toBeNull();
      });
    });

    it("performs case-insensitive filtering", async () => {
      const fetchPolicies = vi.fn().mockResolvedValue(mockPolicies);
      render(
        <PolicyPickerModal visible={true} fetchPolicies={fetchPolicies} onSelect={() => {}} onDismiss={() => {}} />
      );
      await waitFor(() => screen.getByText("HR Policy"));

      const filterInput = screen.getByPlaceholderText("Find a policy by name");
      fireEvent.change(filterInput, { target: { value: "hr" } });

      await waitFor(() => {
        expect(screen.getByText("HR Policy")).toBeTruthy();
        expect(screen.queryByText("Leave Policy")).toBeNull();
      });
    });

    it("shows no-match empty state when filter matches nothing", async () => {
      const fetchPolicies = vi.fn().mockResolvedValue(mockPolicies);
      render(
        <PolicyPickerModal visible={true} fetchPolicies={fetchPolicies} onSelect={() => {}} onDismiss={() => {}} />
      );
      await waitFor(() => screen.getByText("HR Policy"));

      const filterInput = screen.getByPlaceholderText("Find a policy by name");
      fireEvent.change(filterInput, { target: { value: "nonexistent" } });

      await waitFor(() => {
        expect(screen.getByText(/No policies match/)).toBeTruthy();
        expect(screen.getByText("clear the filter")).toBeTruthy();
      });
    });

    it("restores all policies when clear-filter link is clicked", async () => {
      const fetchPolicies = vi.fn().mockResolvedValue(mockPolicies);
      render(
        <PolicyPickerModal visible={true} fetchPolicies={fetchPolicies} onSelect={() => {}} onDismiss={() => {}} />
      );
      await waitFor(() => screen.getByText("HR Policy"));

      const filterInput = screen.getByPlaceholderText("Find a policy by name");
      fireEvent.change(filterInput, { target: { value: "nonexistent" } });

      await waitFor(() => screen.getByText("clear the filter"));
      screen.getByText("clear the filter").click();

      await waitFor(() => {
        expect(screen.getByText("HR Policy")).toBeTruthy();
        expect(screen.getByText("Leave Policy")).toBeTruthy();
        expect(screen.getByText("Travel Policy")).toBeTruthy();
      });
    });

    it("resets filter text when modal re-opens", async () => {
      const fetchPolicies = vi.fn().mockResolvedValue(mockPolicies);
      const { rerender } = render(
        <PolicyPickerModal visible={true} fetchPolicies={fetchPolicies} onSelect={() => {}} onDismiss={() => {}} />
      );
      await waitFor(() => screen.getByText("HR Policy"));

      const filterInput = screen.getByPlaceholderText("Find a policy by name");
      fireEvent.change(filterInput, { target: { value: "Leave" } });

      await waitFor(() => expect(screen.queryByText("HR Policy")).toBeNull());

      // Close and re-open the modal
      rerender(
        <PolicyPickerModal visible={false} fetchPolicies={fetchPolicies} onSelect={() => {}} onDismiss={() => {}} />
      );
      rerender(
        <PolicyPickerModal visible={true} fetchPolicies={fetchPolicies} onSelect={() => {}} onDismiss={() => {}} />
      );

      await waitFor(() => {
        expect(screen.getByText("HR Policy")).toBeTruthy();
        expect(screen.getByText("Leave Policy")).toBeTruthy();
        expect(screen.getByText("Travel Policy")).toBeTruthy();
      });
    });
  });
});
