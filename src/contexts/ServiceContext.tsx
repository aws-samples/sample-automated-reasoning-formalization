/**
 * ServiceContext — bridge between React components and existing service layer.
 *
 * During the Cloudscape migration, React components consume services through
 * this context while the service layer (PolicyService, ChatSessionManager,
 * BuildOrchestrator) remains unchanged.
 */
import React, { createContext, useContext } from "react";
import type { PolicyService } from "../services/policy-service";
import type { BuildOrchestrator } from "../services/build-orchestrator";
import type { ChatSessionManager } from "../services/chat-session-manager";

export interface Services {
  policyService: PolicyService;
  buildOrchestrator: BuildOrchestrator;
  chatSessionMgr: ChatSessionManager;
}

// Default is null — useServices() enforces that consumers are inside a ServiceProvider.
const ServiceContext = createContext<Services>(null!);

export function ServiceProvider({
  services,
  children,
}: {
  services: Services;
  children: React.ReactNode;
}) {
  return (
    <ServiceContext.Provider value={services}>
      {children}
    </ServiceContext.Provider>
  );
}

export function useServices(): Services {
  const ctx = useContext(ServiceContext);
  if (!ctx) {
    throw new Error("useServices must be used within a ServiceProvider");
  }
  return ctx;
}
