// NDJSON helpers for the RuntimeEvent stream. Used by the daemon to serialize
// and by the client to parse. Kept dependency-free so the browser client can reuse it.

import type { RuntimeEvent } from "./types.ts";

/** Serialize one event as a single NDJSON line (newline included). */
export function encodeEvent(event: RuntimeEvent): string {
  return JSON.stringify(event) + "\n";
}

/**
 * Stateful NDJSON line parser. Feed it arbitrary string chunks; it yields
 * complete parsed events and buffers partial lines across chunk boundaries.
 */
export class NdjsonParser {
  #buffer = "";

  push(chunk: string): RuntimeEvent[] {
    this.#buffer += chunk;
    const events: RuntimeEvent[] = [];
    let newlineIndex = this.#buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.#buffer.slice(0, newlineIndex).trim();
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      if (line) events.push(parseLine(line));
      newlineIndex = this.#buffer.indexOf("\n");
    }
    return events;
  }

  /** Flush any trailing line that wasn't newline-terminated. */
  flush(): RuntimeEvent[] {
    const line = this.#buffer.trim();
    this.#buffer = "";
    return line ? [parseLine(line)] : [];
  }
}

function parseLine(line: string): RuntimeEvent {
  try {
    return JSON.parse(line) as RuntimeEvent;
  } catch {
    return { type: "error", error: `Malformed event line: ${line.slice(0, 200)}`, code: "bad_request" };
  }
}

export function isTerminalEvent(event: RuntimeEvent): boolean {
  return event.type === "done" || event.type === "error";
}
