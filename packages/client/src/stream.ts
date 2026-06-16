// NDJSON stream reader for the browser/fetch world. Kept free of any runtime import
// from @portico/core (only erased type imports) so bundlers never pull Node-only code.

import type { RuntimeEvent } from "@portico/core";

/** Read a fetch Response body as a stream of RuntimeEvents. */
export async function* readNdjsonStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<RuntimeEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) yield parseLine(line);
        nl = buffer.indexOf("\n");
      }
    }
    const last = buffer.trim();
    if (last) yield parseLine(last);
  } finally {
    reader.releaseLock();
  }
}

function parseLine(line: string): RuntimeEvent {
  try {
    return JSON.parse(line) as RuntimeEvent;
  } catch {
    return { type: "error", error: `Malformed event line: ${line.slice(0, 200)}`, code: "bad_request" };
  }
}
