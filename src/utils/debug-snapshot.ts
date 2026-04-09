/**
 * Builds a sanitized state snapshot for the debug export.
 *
 * Renderer-side only — reads from policy-state.ts getters and
 * strips sensitive data (AWS credentials, session tokens).
 */
import * as State from "../state/policy-state";
import { toAppDefinition } from "../utils/policy-definition";
import { buildAssetsStore } from "../services/build-assets-store";

export interface DebugSnapshot {
  capturedAt: string;
  policy: {
    policyArn: string | null;
    name: string | null;
  };
  definition: {
    ruleCount: number;
    variableCount: number;
  } | null;
  buildWorkflowId: string | null;
  testCases: {
    total: number;
    withResults: number;
  };
  localState: {
    hasSectionImports: boolean;
    sectionCount: number;
  } | null;
  buildAssets: {
    hasQualityReport: boolean;
    hasFidelityReport: boolean;
    hasScenarios: boolean;
  };
  sourceDocument: {
    loaded: boolean;
    lengthChars: number;
  };
  contextIndex: {
    loaded: boolean;
  };
}

/**
 * Capture the current renderer state as a sanitized snapshot.
 * No AWS credentials, tokens, or full policy content included.
 */
export function buildDebugSnapshot(): DebugSnapshot {
  const policy = State.getPolicy();
  const rawDefinition = State.getDefinition();
  const definition = rawDefinition ? toAppDefinition(rawDefinition) : null;
  const localState = State.getLocalState();
  const assets = buildAssetsStore.get();
  const sourceDoc = State.getSourceDocumentText();
  const testsWithResults = State.getTestsWithResults();
  const testCases = State.getTestCases();

  return {
    capturedAt: new Date().toISOString(),
    policy: {
      policyArn: policy?.policyArn ?? null,
      name: policy?.name ?? null,
    },
    definition: definition
      ? {
          ruleCount: definition.rules?.length ?? 0,
          variableCount: definition.variables?.length ?? 0,
        }
      : null,
    buildWorkflowId: State.getBuildWorkflowId(),
    testCases: {
      total: testCases?.length ?? 0,
      withResults: testsWithResults.length,
    },
    localState: localState
      ? {
          hasSectionImports: !!localState.sectionImports,
          sectionCount: localState.sectionImports
            ? Object.keys(localState.sectionImports).length
            : 0,
        }
      : null,
    buildAssets: {
      hasQualityReport: !!assets?.qualityReport,
      hasFidelityReport: !!assets?.fidelityReport,
      hasScenarios: !!assets?.policyScenarios && assets.policyScenarios.length > 0,
    },
    sourceDocument: {
      loaded: !!sourceDoc,
      lengthChars: sourceDoc?.length ?? 0,
    },
    contextIndex: {
      loaded: !!State.getContextIndex(),
    },
  };
}
