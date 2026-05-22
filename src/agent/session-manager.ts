import { nanoid } from "nanoid";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { InboundChatEvent } from "../types.js";

export type AgentSessionStatus = "created" | "running" | "completed" | "discarded";

export interface AgentSessionRecord {
  id: string;
  timelineKey: string;
  status: AgentSessionStatus;
  trigger: InboundChatEvent;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

export class SessionManager {
  private readonly sessions = new Map<string, AgentSessionRecord>();
  private readonly agents = new Map<string, Agent>();
  private readonly byTimeline = new Map<string, Set<string>>();

  createPlaceholder(trigger: InboundChatEvent): AgentSessionRecord {
    const record: AgentSessionRecord = {
      id: `s-${nanoid(10)}`,
      timelineKey: trigger.timelineKey,
      status: "created",
      trigger,
      createdAt: Date.now(),
    };
    this.sessions.set(record.id, record);
    const ids = this.byTimeline.get(record.timelineKey) ?? new Set<string>();
    ids.add(record.id);
    this.byTimeline.set(record.timelineKey, ids);
    return record;
  }

  markRunning(sessionId: string): void {
    this.update(sessionId, (session) => ({
      ...session,
      status: "running",
      startedAt: session.startedAt ?? Date.now(),
    }));
  }

  markCompleted(sessionId: string): void {
    this.update(sessionId, (session) => ({
      ...session,
      status: "completed",
      completedAt: Date.now(),
    }));
    this.evict(sessionId);
  }

  markDiscarded(sessionId: string): void {
    this.update(sessionId, (session) => ({
      ...session,
      status: "discarded",
      completedAt: Date.now(),
    }));
    this.evict(sessionId);
  }

  get(sessionId: string): AgentSessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  attachAgent(sessionId: string, agent: Agent): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    this.agents.set(sessionId, agent);
  }

  getAgent(sessionId: string): Agent | undefined {
    return this.agents.get(sessionId);
  }

  steer(sessionId: string, message: AgentMessage): boolean {
    const session = this.sessions.get(sessionId);
    const agent = this.agents.get(sessionId);
    if (!session || !agent || session.status !== "running") return false;
    agent.steer(message);
    return true;
  }

  activeForTimeline(timelineKey: string): AgentSessionRecord[] {
    const ids = this.byTimeline.get(timelineKey) ?? new Set<string>();
    return [...ids]
      .map((id) => this.sessions.get(id))
      .filter((session): session is AgentSessionRecord =>
        Boolean(session && (session.status === "created" || session.status === "running")),
      );
  }

  private update(sessionId: string, updater: (session: AgentSessionRecord) => AgentSessionRecord): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    this.sessions.set(sessionId, updater(session));
  }

  private evict(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    this.agents.delete(sessionId);
    this.sessions.delete(sessionId);
    if (!session) return;
    const ids = this.byTimeline.get(session.timelineKey);
    ids?.delete(sessionId);
    if (ids?.size === 0) this.byTimeline.delete(session.timelineKey);
  }
}
