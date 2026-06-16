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

async function ask() {
  const provider = els.agent.value;
  if (!provider || provider.startsWith("(")) return;

  els.answer.textContent = "";
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
    messages: [{ role: "user", content: els.question.value }],
  };

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
      if (event.type === "content") els.answer.textContent += event.delta;
      else if (event.type === "error") els.answer.textContent += `\n[error] ${event.error}`;
    }
  } catch (err) {
    if (err.name !== "AbortError") els.answer.textContent += `\n[transport error] ${err.message}`;
  } finally {
    els.ask.disabled = false;
    els.cancel.disabled = true;
    controller = null;
  }
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

(async () => {
  if (await checkHealth()) await loadAgents();
})();
