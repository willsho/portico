// Session bookkeeping. A session is a continuable conversation with one agent in one
// working directory — not a task or a queue entry. The daemon owns a SessionStore and
// the resume policy; core just provides the record shape and the storage primitive.
// See docs/session-management-plan.md.

import { randomUUID } from "node:crypto";

export type SessionStatus = "active" | "interrupted" | "ended";

export interface SessionRecord {
  /** Portico handle (UUID), stable across turns. */
  id: string;
  provider: string;
  /** Working directory — the second half of the resume key; must match to resume. */
  cwd?: string;
  /** The agent's native session id (resume pointer), pinned once the agent reports it. */
  agentSessionId?: string;
  status: SessionStatus;
  turns: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateSessionInput {
  /** Reuse a specific id (e.g. a client handle whose record was evicted). */
  id?: string;
  provider: string;
  cwd?: string;
}

export interface SessionStore {
  create(input: CreateSessionInput): SessionRecord;
  get(id: string): SessionRecord | undefined;
  /** Pin the agent's native session id — the "capture → pin" step. */
  pinAgentSession(id: string, agentSessionId: string): void;
  setStatus(id: string, status: SessionStatus): void;
  /** Record a completed turn (turns++ / updatedAt). */
  touch(id: string): void;
  list(): SessionRecord[];
  delete(id: string): boolean;
}

/** In-memory store: sessions live as long as the daemon process does. */
export function createInMemorySessionStore(): SessionStore {
  const sessions = new Map<string, SessionRecord>();

  return {
    create({ id, provider, cwd }) {
      const now = Date.now();
      const record: SessionRecord = {
        id: id ?? randomUUID(),
        provider,
        cwd,
        status: "active",
        turns: 0,
        createdAt: now,
        updatedAt: now,
      };
      sessions.set(record.id, record);
      return record;
    },
    get(id) {
      return sessions.get(id);
    },
    pinAgentSession(id, agentSessionId) {
      const record = sessions.get(id);
      if (record) {
        record.agentSessionId = agentSessionId;
        record.updatedAt = Date.now();
      }
    },
    setStatus(id, status) {
      const record = sessions.get(id);
      if (record) {
        record.status = status;
        record.updatedAt = Date.now();
      }
    },
    touch(id) {
      const record = sessions.get(id);
      if (record) {
        record.turns += 1;
        record.updatedAt = Date.now();
      }
    },
    list() {
      return [...sessions.values()];
    },
    delete(id) {
      return sessions.delete(id);
    },
  };
}
