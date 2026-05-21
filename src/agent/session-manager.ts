import { nanoid } from "nanoid";
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
  }

  markDiscarded(sessionId: string): void {
    this.update(sessionId, (session) => ({
      ...session,
      status: "discarded",
      completedAt: Date.now(),
    }));
  }

  get(sessionId: string): AgentSessionRecord | undefined {
    return this.sessions.get(sessionId);
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
}

