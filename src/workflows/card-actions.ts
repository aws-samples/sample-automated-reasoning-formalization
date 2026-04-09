/**
 * Card action dispatch handler.
 *
 * Maps card type + action combinations to the appropriate UI or chat response.
 * Pure orchestration — no direct service calls.
 */
import type { ChatPanelHandle as ChatPanel } from "../components/ChatPanelComponent";
import type { DocumentPreviewHandle as DocumentPreview } from "../components/DocumentPreviewPanel";
import type { PolicyDefinition } from "../types";
import { toAppDefinition } from "../utils/policy-definition";
import type { AutomatedReasoningPolicyDefinition } from "@aws-sdk/client-bedrock";

export interface CardActionDeps {
  chatPanel: ChatPanel;
  docPreview: DocumentPreview;
  getDefinition: () => AutomatedReasoningPolicyDefinition | null;
  hasPolicy: () => boolean;
}

/** Card types that trigger sibling dismissal when acted on. */
const DISMISSABLE_CARD_TYPES = new Set([
  "follow-up-prompt", "next-steps", "proposal", "variable-proposal",
]);

/** Dismiss sibling cards in the same batch after an actionable card is selected. */
function maybeDismissSiblings(deps: CardActionDeps, cardType: string, d: Record<string, string>): void {
  if (!DISMISSABLE_CARD_TYPES.has(cardType)) return;
  if (d.__batchId && d.__segmentId) {
    deps.chatPanel.dismissBatch(d.__batchId, d.__segmentId);
  }
}

/**
 * Handle a card action emitted by the chat panel.
 * Returns a function suitable for assigning to `chatPanel.onCardAction`.
 */
export function createCardActionHandler(deps: CardActionDeps) {
  return async (cardType: string, action: string, data: unknown) => {
    if (!deps.hasPolicy() || !deps.getDefinition()) return;
    const d = data as Record<string, string>;

    // ── Rule card ──
    if (cardType === "rule" && action === "update-rule") {
      deps.chatPanel.prefillInput(d.prompt);
    } else if (cardType === "rule" && action === "show-source") {
      deps.docPreview.emphasize(d.ruleId);
    } else if (action === "filter-entity") {
      const rawDef = deps.getDefinition();
      const def = rawDef ? toAppDefinition(rawDef) : null;
      deps.docPreview.filterByEntity(d.entityType as "rule" | "variable", d.entityId, def ?? undefined);
    }

    // ── Test card ──
    else if (cardType === "test" && action === "rerun-test") {
      deps.chatPanel.onSendMessage?.(`Re-run the test with answer "${d.answer}" and question "${d.question}" and summarize the results.`);
    } else if (cardType === "test" && action === "dive-deeper") {
      const divePrompt = [
        `[DEEP ANALYSIS REQUEST]`,
        `Answer (guard content): ${d.answer}`,
        `Question (query content): ${d.question}`,
        `Expected result: ${d.expectedStatus}`,
        `Actual result: ${d.actualStatus}`,
        `Findings summary: ${d.findingsSummary}`,
        ``,
        `Analyze this test result in depth. The user expected "${d.expectedStatus}" but got "${d.actualStatus}".`,
        `Consider what the expected result tells you about the user's INTENT — they believe this test should be ${d.expectedStatus}.`,
        `Do NOT suggest changes that would simply make the test pass by changing the test to match the current policy behavior — that defeats the purpose.`,
        `Instead, figure out WHY the policy produced "${d.actualStatus}" and offer multiple remediation paths.`,
        ``,
        `You MUST emit at least two follow-up-prompt cards with different fix strategies. For example:`,
        `- Rewrite the test text to make the intent clearer to the translation layer`,
        `- Improve variable descriptions so the policy can correctly interpret the test text`,
        `- Add or update rules to handle the scenario the test describes`,
        `- Add missing variables that the test text references`,
        ``,
        `If the actual result is TRANSLATION_AMBIGUOUS or there are no translations, ALWAYS include a follow-up-prompt card for improving variable descriptions — this is the most common and effective fix.`,
      ].join("\n");
      deps.chatPanel.onSendMessage?.(divePrompt);
    }

    // ── Next steps card ──
    else if (cardType === "next-steps" && action === "execute-prompt") {
      deps.chatPanel.onSendMessage?.(d.prompt);
    }

    // ── Variable proposal card ──
    else if (cardType === "variable-proposal" && action === "accept-variable") {
      deps.chatPanel.onSendMessage?.(`Add variable "${d.name}" of type ${d.type}`);
    }

    // ── Guardrail validation card ──
    else if (cardType === "guardrail-validation" && action === "highlight-rule") {
      deps.docPreview.emphasize(d.ruleId);
    }

    // ── Follow-up prompt card ──
    else if (cardType === "follow-up-prompt" && action === "execute-prompt") {
      deps.chatPanel.onSendMessage?.(d.prompt);
    }

    // ── Proposal card ──
    else if (cardType === "proposal" && action === "approve-proposal") {
      const { generateApprovalCode } = await import("../utils/card-helpers");
      const code = generateApprovalCode();
      try { await window.architect.writeApprovalCode(code); } catch (err) {
        console.error("[card-actions] Failed to write approval code:", err);
      }
      const promptWithCode = `${d.prompt}\n\n[APPROVAL_CODE: ${code}]`;
      deps.chatPanel.onSendMessage?.(promptWithCode);
    } else if (cardType === "proposal" && action === "reject-proposal") {
      deps.chatPanel.onSendMessage?.(d.prompt);
    }

    // Dismiss sibling cards for any actionable card type
    maybeDismissSiblings(deps, cardType, d);
  };
}
