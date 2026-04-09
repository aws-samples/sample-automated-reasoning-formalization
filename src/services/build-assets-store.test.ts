/**
 * Unit tests for BuildAssetsStore.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildAssetsStore } from "./build-assets-store";
import type { BuildAssets } from "../types";

const MOCK_ASSETS: BuildAssets = {
  buildWorkflowId: "bw-1",
  policyDefinition: null,
  rawPolicyDefinition: null,
  buildLog: null,
  rawBuildLog: null,
  qualityReport: null,
  rawQualityReport: null,
  fidelityReport: null,
  rawFidelityReport: null,
  policyScenarios: null,
  rawPolicyScenarios: null,
};

beforeEach(() => {
  buildAssetsStore.clear();
});

describe("BuildAssetsStore", () => {
  it("starts with null", () => {
    expect(buildAssetsStore.get()).toBeNull();
  });

  it("set/get lifecycle", () => {
    buildAssetsStore.set(MOCK_ASSETS);
    expect(buildAssetsStore.get()).toBe(MOCK_ASSETS);
  });

  it("clear resets to null", () => {
    buildAssetsStore.set(MOCK_ASSETS);
    buildAssetsStore.clear();
    expect(buildAssetsStore.get()).toBeNull();
  });

  it("notifies listeners on set", () => {
    const listener = vi.fn();
    buildAssetsStore.subscribe(listener);
    buildAssetsStore.set(MOCK_ASSETS);
    expect(listener).toHaveBeenCalledWith(MOCK_ASSETS);
  });

  it("notifies listeners on clear", () => {
    const listener = vi.fn();
    buildAssetsStore.set(MOCK_ASSETS);
    buildAssetsStore.subscribe(listener);
    buildAssetsStore.clear();
    expect(listener).toHaveBeenCalledWith(null);
  });

  it("unsubscribe stops notifications", () => {
    const listener = vi.fn();
    const unsub = buildAssetsStore.subscribe(listener);
    unsub();
    buildAssetsStore.set(MOCK_ASSETS);
    expect(listener).not.toHaveBeenCalled();
  });

  it("supports multiple listeners", () => {
    const l1 = vi.fn();
    const l2 = vi.fn();
    buildAssetsStore.subscribe(l1);
    buildAssetsStore.subscribe(l2);
    buildAssetsStore.set(MOCK_ASSETS);
    expect(l1).toHaveBeenCalledOnce();
    expect(l2).toHaveBeenCalledOnce();
  });
});
