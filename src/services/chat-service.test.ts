/**
 * Integration tests for ChatService with mocked AcpTransport.
 *
 * Tests connection lifecycle, message sending with reconnection,
 * session routing, and test context injection.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ChatService } from "./chat-service";
import type { AcpTransport, AcpUpdateCallback } from "./acp-transport";

function createMockTransport(): AcpTransport & { _listeners: AcpUpdateCallback[] } {
  const listeners: AcpUpdateCallback[] = [];
  return {
    _listeners: listeners,
    start: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue("session-1"),
    sendPrompt: vi.fn().mockResolvedValue({ stopReason: "end_turn" }),
    cancel: vi.fn(),
    stop: vi.fn(),
    onUpdate: vi.fn((cb: AcpUpdateCallback) => {
      listeners.push(cb);
      return () => { listeners.splice(listeners.indexOf(cb), 1); };
    }),
  };
}

describe("ChatService + AcpTransport", () => {
  let transport: ReturnType<typeof createMockTransport>;
  let service: ChatService;

  beforeEach(() => {
    transport = createMockTransport();
    // Reset the static processStarted flag between tests
    (ChatService as any).processStarted = false;
    service = new ChatService({ transport });
  });

  // ── connect happy path ──

  describe("connect", () => {
    it("calls start (once), createSession, sets connected flag", async () => {
      await service.connect("system prompt");

      expect(transport.start).toHaveBeenCalledTimes(1);
      expect(transport.createSession).toHaveBeenCalledWith(
        undefined, "system prompt", undefined,
      );
      // Second connect should be a no-op
      await service.connect();
      expect(transport.start).toHaveBeenCalledTimes(1);
      expect(transport.createSession).toHaveBeenCalledTimes(1);
    });

    it("is idempotent — second call is no-op", async () => {
      await service.connect();
      await service.connect();

      expect(transport.createSession).toHaveBeenCalledTimes(1);
    });
  });

  // ── sendPolicyMessage ──

  describe("sendPolicyMessage", () => {
    it("calls sendPrompt with formatted text + context", async () => {
      await service.connect();

      // Simulate the transport emitting a streamed chunk
      (transport.sendPrompt as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        for (const listener of transport._listeners) {
          listener({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Hello" },
            sessionId: "session-1",
          });
        }
        return { stopReason: "end_turn" };
      });

      const msg = await service.sendPolicyMessage("What is this policy?", { policyArn: "arn:test" });

      expect(transport.sendPrompt).toHaveBeenCalled();
      const prompt = (transport.sendPrompt as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(prompt).toContain("What is this policy?");
      expect(prompt).toContain("arn:test");
      expect(msg.role).toBe("assistant");
      expect(msg.content).toContain("Hello");
    });
  });

  // ── sendPolicyMessage with reconnect ──

  describe("sendPolicyMessage with reconnect", () => {
    it("transient ACP error → reconnects → retries", async () => {
      await service.connect();

      const transientError = new Error("ACP process not running");

      let callCount = 0;
      (transport.sendPrompt as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw transientError;
        // Emit a chunk on retry
        for (const listener of transport._listeners) {
          listener({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Recovered" },
            sessionId: "session-1",
          });
        }
        return { stopReason: "end_turn" };
      });

      const msg = await service.sendPolicyMessage("test");

      expect(callCount).toBe(2);
      expect(msg.content).toContain("Recovered");
    });
  });

  // ── cancel ──

  describe("cancel", () => {
    it("calls transport.cancel with session ID", async () => {
      await service.connect();
      service.cancel();

      expect(transport.cancel).toHaveBeenCalledWith("session-1");
    });
  });

  // ── disconnect ──

  describe("disconnect", () => {
    it("resets state so next connect creates a new session", async () => {
      await service.connect();
      service.disconnect();

      // After disconnect, connecting again should create a new session
      (ChatService as any).processStarted = false;
      (transport.createSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce("session-2");
      await service.connect();

      expect(transport.createSession).toHaveBeenCalledTimes(2);
    });
  });

  // ── Session routing ──

  describe("session routing", () => {
    it("updates with wrong sessionId are ignored", async () => {
      await service.connect();

      const updateSpy = vi.fn();
      service.onUpdate = updateSpy;

      // Simulate an update for a different session
      for (const listener of transport._listeners) {
        listener({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "wrong session" },
          sessionId: "other-session",
        });
      }

      expect(updateSpy).not.toHaveBeenCalled();
    });

    it("updates with matching sessionId are forwarded", async () => {
      await service.connect();

      const updateSpy = vi.fn();
      service.onUpdate = updateSpy;

      for (const listener of transport._listeners) {
        listener({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "correct session" },
          sessionId: "session-1",
        });
      }

      expect(updateSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ── Test context injection ──

  describe("test context injection", () => {
    it("testContext string included in every message", async () => {
      await service.connect();
      service.testContext = "Test case tc-1: guard=true, query=false";

      (transport.sendPrompt as ReturnType<typeof vi.fn>).mockResolvedValue({ stopReason: "end_turn" });

      await service.sendPolicyMessage("Why did this test fail?");

      const prompt = (transport.sendPrompt as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(prompt).toContain("Test case tc-1: guard=true, query=false");
      expect(prompt).toContain("ACTIVE TEST CONTEXT");
    });
  });
});
