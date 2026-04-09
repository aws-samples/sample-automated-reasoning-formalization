/**
 * Shared section-wiring logic for DocumentPreview callbacks.
 *
 * Both handleNewPolicy (renderer.ts) and loadProgressiveImportMode (policy-loader.ts)
 * need to wire the same three callbacks on DocumentPreview: onImportSection,
 * onImportMultipleSections, and onGranularityChange.
 * This module extracts that shared wiring into a single function.
 */
import type { DocumentSection, SectionImportState, PolicyLocalState } from '../types';
import { parseMarkdownSections } from '../utils/markdown-sections';

/** Minimal interface for the DocumentPreview callbacks we wire. */
export interface SectionWiringTarget {
  onImportSection?: (section: DocumentSection) => void;
  onImportMultipleSections?: (sections: DocumentSection[]) => void;
  onGranularityChange?: (maxLevel: number) => void;
  loadSections: (sections: DocumentSection[], importStates: Record<string, SectionImportState>, maxLevel?: number) => void;
}

/** Dependencies needed by the granularity-change handler. */
export interface SectionWiringDeps {
  getLocalState: () => PolicyLocalState | null;
  getSourceDocumentText: () => string | null;
  persistLocalState: () => Promise<void>;
  appendStatus: (text: string) => void;
  importSection: (section: DocumentSection) => void;
  importMultipleSections: (sections: DocumentSection[]) => void;
}

/**
 * Wire the three section-related callbacks on a DocumentPreview instance.
 * Used by both handleNewPolicy and loadProgressiveImportMode.
 */
export function wireSectionHandlers(
  target: SectionWiringTarget,
  deps: SectionWiringDeps,
): void {
  target.onImportSection = (section) => deps.importSection(section);
  target.onImportMultipleSections = (sections) => deps.importMultipleSections(sections);

  target.onGranularityChange = (newMaxLevel) => {
    const localState = deps.getLocalState();
    const sourceText = deps.getSourceDocumentText();
    if (!localState || !sourceText) return;

    const hasImported = Object.values(localState.sectionImports).some(
      (s) => s.status === 'completed' || s.status === 'in_progress' || s.status === 'timed_out',
    );
    if (hasImported) {
      deps.appendStatus('Cannot change granularity after sections have been imported.');
      return;
    }

    const newSections = parseMarkdownSections(sourceText, newMaxLevel);
    const newImports: Record<string, SectionImportState> = {};
    for (const s of newSections) {
      newImports[s.id] = { sectionId: s.id, status: 'not_started' };
    }
    localState.sections = newSections;
    localState.sectionImports = newImports;
    deps.persistLocalState();
    target.loadSections(newSections, newImports, newMaxLevel);
  };
}
