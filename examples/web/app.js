// Minimal Portico browser client, inlined so this example needs no build step.
// In a real app you'd `import { createPorticoClient } from "@portico/client"` instead;
// this mirrors that SDK's behavior (health, listAgents, streaming chat, graceful errors).

const ENDPOINT = "http://127.0.0.1:8787";

const els = {
  status: document.getElementById("status"),
  health: document.getElementById("health"),
  agent: document.getElementById("agent"),
  refresh: document.getElementById("refresh"),
  article: document.getElementById("article"),
  question: document.getElementById("question"),
  ask: document.getElementById("ask"),
  cancel: document.getElementById("cancel"),
  answer: document.getElementById("answer"),
  thinkingBox: document.getElementById("thinkingBox"),
  thinking: document.getElementById("thinking"),
  toolsBox: document.getElementById("toolsBox"),
  tools: document.getElementById("tools"),
  transcript: document.getElementById("transcript"),
  newchat: document.getElementById("newchat"),
};

async function checkHealth() {
  try {
    const res = await fetch(`${ENDPOINT}/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    els.status.textContent = `Connected to ${body.name} v${body.version}`;
    els.health.textContent = "online";
    els.health.className = "pill ok";
    return true;
  } catch {
    els.status.textContent =
      "Portico not detected. Start it with `portico start`, then click Refresh.";
    els.health.textContent = "offline";
    els.health.className = "pill bad";
    return false;
  }
}

async function loadAgents() {
  els.agent.innerHTML = "";
  try {
    const res = await fetch(`${ENDPOINT}/agents`);
    const { agents } = await res.json();
    const usable = agents.filter((a) => a.available);
    if (usable.length === 0) {
      els.agent.innerHTML = "<option>(no agents available)</option>";
      return;
    }
    for (const a of usable) {
      const opt = document.createElement("option");
      opt.value = a.provider;
      opt.textContent = `${a.displayName} ${a.version ?? ""} (${a.versionStatus ?? "unknown"})`;
      els.agent.append(opt);
    }
  } catch {
    els.agent.innerHTML = "<option>(failed to load)</option>";
  }
}

let controller = null;
// The Portico session handle. Carried from one turn's `start` event into the next
// request so the agent resumes the same conversation (see session-management-plan.md).
let sessionId = null;

async function ask() {
  const provider = els.agent.value;
  if (!provider || provider.startsWith("(")) return;
  const question = els.question.value.trim();
  if (!question) return;

  els.answer.textContent = "";
  els.thinking.textContent = "";
  els.thinkingBox.hidden = true;
  els.tools.innerHTML = "";
  els.toolsBox.hidden = true;
  pendingTools.length = 0;
  els.ask.disabled = true;
  els.cancel.disabled = false;
  controller = new AbortController();

  const request = {
    provider,
    context: {
      schemaVersion: "1.0",
      kind: "article",
      title: "Pasted article",
      content: els.article.value,
    },
    messages: [{ role: "user", content: question }],
  };
  if (sessionId) request.sessionId = sessionId;

  let answer = "";
  try {
    const res = await fetch(`${ENDPOINT}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      els.answer.textContent = `Request failed (HTTP ${res.status}).`;
      return;
    }
    for await (const event of readNdjson(res.body)) {
      switch (event.type) {
        case "start":
          sessionId = event.sessionId; // continue this conversation next turn
          break;
        case "content":
          answer += event.delta;
          els.answer.textContent = answer;
          break;
        case "reasoning":
          els.thinkingBox.hidden = false;
          els.thinking.textContent += event.delta;
          break;
        case "tool_call":
          renderToolCall(event);
          break;
        case "tool_result":
          renderToolResult(event);
          break;
        case "error":
          answer += `\n[error] ${event.error}`;
          els.answer.textContent = answer;
          break;
      }
    }
    // Turn complete: fold it into the transcript and clear the live area for a follow-up.
    appendTurn(question, answer);
    els.answer.textContent = "";
    els.question.value = "";
    els.question.placeholder = "Ask a follow-up…";
  } catch (err) {
    if (err.name !== "AbortError") els.answer.textContent += `\n[transport error] ${err.message}`;
  } finally {
    els.ask.disabled = false;
    els.cancel.disabled = true;
    controller = null;
  }
}

function appendTurn(question, answer) {
  const turn = document.createElement("div");
  turn.className = "turn";
  const q = document.createElement("div");
  q.className = "q";
  q.textContent = `You: ${question}`;
  const a = document.createElement("div");
  a.className = "a";
  a.textContent = answer;
  turn.append(q, a);
  els.transcript.append(turn);
}

function newConversation() {
  sessionId = null;
  els.transcript.innerHTML = "";
  els.answer.textContent = "";
  els.thinking.textContent = "";
  els.thinkingBox.hidden = true;
  els.tools.innerHTML = "";
  els.toolsBox.hidden = true;
  els.question.placeholder = "Ask a question…";
}

// Tool calls and their results arrive as separate events. We match a `tool_result`
// to the earliest still-open call with the same tool name (calls/results are sequential).
const pendingTools = [];

function summarize(value) {
  if (value == null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

function renderToolCall(event) {
  els.toolsBox.hidden = false;
  const li = document.createElement("li");
  const head = document.createElement("div");
  head.innerHTML = `<span class="tool-name">🔧 ${event.name ?? "tool"}</span>`;
  li.append(head);
  if (event.input !== undefined) {
    const io = document.createElement("pre");
    io.className = "tool-io";
    io.textContent = summarize(event.input);
    li.append(io);
  }
  els.tools.append(li);
  pendingTools.push({ name: event.name, li });
}

function renderToolResult(event) {
  els.toolsBox.hidden = false;
  const match = pendingTools.findIndex((t) => t.name === event.name);
  const li = match !== -1 ? pendingTools.splice(match, 1)[0].li : document.createElement("li");
  if (match === -1) {
    li.innerHTML = `<span class="tool-name">↳ ${event.name ?? "tool"}</span>`;
    els.tools.append(li);
  }
  const io = document.createElement("pre");
  io.className = `tool-io${event.isError ? " err" : ""}`;
  io.textContent = `↳ ${summarize(event.output)}`;
  li.append(io);
}

async function* readNdjson(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer.trim());
}

els.refresh.addEventListener("click", async () => {
  if (await checkHealth()) await loadAgents();
});
els.ask.addEventListener("click", ask);
els.cancel.addEventListener("click", () => controller?.abort());
els.newchat.addEventListener("click", newConversation);
// Switching agents can't continue the same session — start a new conversation.
els.agent.addEventListener("change", newConversation);

(async () => {
  if (await checkHealth()) await loadAgents();
})();
