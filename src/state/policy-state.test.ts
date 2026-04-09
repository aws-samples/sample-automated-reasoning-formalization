/**
 * Unit tests for policy state management.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getPolicy, setPolicy,
  getDefinition, setDefinition,
  getLocalState, setLocalState,
  getTestsWithResults, setTestsWithResults,
  getSourceDocumentText, setSourceDocumentText,
  getBuildWorkflowId, setBuildWorkflowId,
  getTestCases, setTestCases,
  buildPolicyContext,
  getKnownEntities,
  persistLocalState,
  updateSectionImportState,
  policyStore,
} from "./policy-state";
import { buildAssetsStore } from "../services/build-assets-store";

// Reset state between tests
beforeEach(() => {
  setPolicy(null);
  setDefinition(null);
  setLocalState(null);
  setTestsWithResults([]);
  setSourceDocumentText(null);
  setBuildWorkflowId(null);
  setTestCases(null);
  buildAssetsStore.clear();
});

describe("getters and setters", () => {
  it("round-trips policy metadata", () => {
    expect(getPolicy()).toBeNull();
    const policy = { policyArn: "arn:test", name: "Test" };
    setPolicy(policy);
    expect(getPolicy()).toBe(policy);
  });

  it("round-trips definition", () => {
    expect(getDefinition()).toBeNull();
    const def = { rules: [], variables: [] } as unknown as import("@aws-sdk/client-bedrock").AutomatedReasoningPolicyDefinition;
    setDefinition(def);
    expect(getDefinition()).toBe(def);
  });

  it("round-trips source document text", () => {
    setSourceDocumentText("hello");
    expect(getSourceDocumentText()).toBe("hello");
  });

  it("round-trips build workflow id", () => {
    setBuildWorkflowId("bw-123");
    expect(getBuildWorkflowId()).toBe("bw-123");
  });

  it("round-trips test cases", () => {
    setTestCases([{ id: "tc1" }]);
    expect(getTestCases()).toEqual([{ id: "tc1" }]);
  });

  it("round-trips tests with results", () => {
    const tests = [{ testCase: { testCaseId: "tc1" } }] as import("../types").TestCaseWithResult[];
    setTestsWithResults(tests);
    expect(getTestsWithResults()).toBe(tests);
  });
});

describe("subscribe", () => {
  it("notifies listener on state change", () => {
    const listener = vi.fn();
    const unsub = policyStore.subscribe(listener);
    setPolicy({ policyArn: "arn:test", name: "Test" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      policy: { policyArn: "arn:test", name: "Test" },
    }));
    unsub();
  });

  it("unsubscribe stops notifications", () => {
    const listener = vi.fn();
    const unsub = policyStore.subscribe(listener);
    unsub();
    setPolicy({ policyArn: "arn:test", name: "Test" });
    expect(listener).not.toHaveBeenCalled();
  });

  it("multiple subscribers all notified", () => {
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    const unsub1 = policyStore.subscribe(listener1);
    const unsub2 = policyStore.subscribe(listener2);
    setBuildWorkflowId("bw-999");
    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledTimes(1);
    unsub1();
    unsub2();
  });
});

describe("buildPolicyContext", () => {
  it("returns undefined when no policy loaded", () => {
    expect(buildPolicyContext()).toBeUndefined();
  });

  it("returns undefined when no definition loaded", () => {
    setPolicy({ policyArn: "arn:test", name: "Test" });
    expect(buildPolicyContext()).toBeUndefined();
  });

  it("includes policyArn and policyDefinition", () => {
    setPolicy({ policyArn: "arn:test", name: "Test" });
    const def = { rules: [], variables: [] } as unknown as import("@aws-sdk/client-bedrock").AutomatedReasoningPolicyDefinition;
    setDefinition(def);
    const ctx = buildPolicyContext();
    expect(ctx).toBeDefined();
    expect(ctx!.policyArn).toBe("arn:test");
    expect(ctx!.policyDefinition).toBe(def);
  });

  it("includes sourceDocumentText when set", () => {
    setPolicy({ policyArn: "arn:test", name: "Test" });
    setDefinition({ rules: [], variables: [] } as unknown as import("@aws-sdk/client-bedrock").AutomatedReasoningPolicyDefinition);
    setSourceDocumentText("doc text");
    const ctx = buildPolicyContext()!;
    expect(ctx.sourceDocumentText).toBe("doc text");
  });

  it("omits sourceDocumentText when null", () => {
    setPolicy({ policyArn: "arn:test", name: "Test" });
    setDefinition({ rules: [], variables: [] } as unknown as import("@aws-sdk/client-bedrock").AutomatedReasoningPolicyDefinition);
    const ctx = buildPolicyContext()!;
    expect(ctx).not.toHaveProperty("sourceDocumentText");
  });

  it("includes testCases when non-empty", () => {
    setPolicy({ policyArn: "arn:test", name: "Test" });
    setDefinition({ rules: [], variables: [] } as unknown as import("@aws-sdk/client-bedrock").AutomatedReasoningPolicyDefinition);
    setTestCases([{ id: "tc1" }]);
    const ctx = buildPolicyContext()!;
    expect(ctx.testCases).toEqual([{ id: "tc1" }]);
  });

  it("omits testCases when empty", () => {
    setPolicy({ policyArn: "arn:test", name: "Test" });
    setDefinition({ rules: [], variables: [] } as unknown as import("@aws-sdk/client-bedrock").AutomatedReasoningPolicyDefinition);
    setTestCases([]);
    const ctx = buildPolicyContext()!;
    expect(ctx).not.toHaveProperty("testCases");
  });

  it("includes qualityReport from buildAssetsStore", () => {
    setPolicy({ policyArn: "arn:test", name: "Test" });
    setDefinition({ rules: [], variables: [] } as unknown as import("@aws-sdk/client-bedrock").AutomatedReasoningPolicyDefinition);
    buildAssetsStore.set({
      buildWorkflowId: "bw-1",
      policyDefinition: null,
      rawPolicyDefinition: null,
      buildLog: null,
      rawBuildLog: null,
      qualityReport: [{ issueType: "conflicting_rules", description: "test" }],
      rawQualityReport: null,
      fidelityReport: null,
      rawFidelityReport: null,
      policyScenarios: null,
      rawPolicyScenarios: null,
    });
    const ctx = buildPolicyContext()!;
    expect(ctx.qualityReport).toHaveLength(1);
  });
});

describe("getKnownEntities", () => {
  it("returns empty arrays when no definition", () => {
    expect(getKnownEntities()).toEqual({ ruleIds: [], variableNames: [] });
  });

  it("extracts rule IDs and variable names", () => {
    setDefinition({
      rules: [{ ruleId: "r1", expression: "x" }, { ruleId: "r2", expression: "y" }],
      variables: [{ name: "v1" }, { name: "v2" }],
    } as unknown as import("@aws-sdk/client-bedrock").AutomatedReasoningPolicyDefinition);
    const entities = getKnownEntities();
    expect(entities.ruleIds).toEqual(["r1", "r2"]);
    expect(entities.variableNames).toEqual(["v1", "v2"]);
  });
});

describe("persistLocalState", () => {
  it("is a no-op when no local state", async () => {
    // Should not throw
    await persistLocalState();
  });

  it("calls window.architect.saveLocalState", async () => {
    const saveMock = vi.fn().mockResolvedValue(undefined);
    (globalThis as Record<string, unknown>).window = {
      architect: { saveLocalState: saveMock },
    };
    setLocalState({
      policyArn: "arn:test",
      policyName: "Test",
      documentPath: "/tmp/doc.md",
      sections: [],
      sectionImports: {},
      fidelityReports: {},
    });
    await persistLocalState();
    expect(saveMock).toHaveBeenCalledWith("arn:test", expect.any(String));
  });

  it("handles save failure gracefully", async () => {
    (globalThis as Record<string, unknown>).window = {
      architect: { saveLocalState: vi.fn().mockRejectedValue(new Error("disk full")) },
    };
    setLocalState({
      policyArn: "arn:test",
      policyName: "Test",
      documentPath: "/tmp/doc.md",
      sections: [],
      sectionImports: {},
      fidelityReports: {},
    });
    // Should not throw
    await persistLocalState();
  });
});

describe("updateSectionImportState", () => {
  it("is a no-op when no local state", async () => {
    await updateSectionImportState("s0", { status: "completed" });
    // No throw
  });

  it("creates new entry if not exists", async () => {
    (globalThis as Record<string, unknown>).window = {
      architect: { saveLocalState: vi.fn().mockResolvedValue(undefined) },
    };
    const state = {
      policyArn: "arn:test",
      policyName: "Test",
      documentPath: "/tmp/doc.md",
      sections: [],
      sectionImports: {} as Record<string, import("../types").SectionImportState>,
      fidelityReports: {},
    };
    setLocalState(state);
    await updateSectionImportState("s0", { status: "in_progress" });
    expect(state.sectionImports["s0"]).toBeDefined();
    expect(state.sectionImports["s0"].status).toBe("in_progress");
    expect(state.sectionImports["s0"].lastUpdatedAt).toBeDefined();
  });

  it("merges patch into existing entry", async () => {
    (globalThis as Record<string, unknown>).window = {
      architect: { saveLocalState: vi.fn().mockResolvedValue(undefined) },
    };
    const state = {
      policyArn: "arn:test",
      policyName: "Test",
      documentPath: "/tmp/doc.md",
      sections: [],
      sectionImports: {
        s0: { sectionId: "s0", status: "in_progress" as const, buildWorkflowId: "bw-1" },
      },
      fidelityReports: {},
    };
    setLocalState(state);
    await updateSectionImportState("s0", { status: "completed" });
    expect(state.sectionImports["s0"].status).toBe("completed");
    expect(state.sectionImports["s0"].buildWorkflowId).toBe("bw-1"); // preserved
  });
});
