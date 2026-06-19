#!/usr/bin/env node
// A fake fan-in judge for Phase 3 tests. It reads the review prompt, collects any
// "candidate run_..." ids (compare mode), and emits a machine-readable verdict line
// that the orchestrator parses. In split mode the prompt lists no candidates, so it
// just approves the merged result. It writes nothing to disk (read-only review).
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("judge-agent 1.0.0\n");
  process.exit(0);
}

let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;
// Some providers pass the prompt as an argv value (e.g. gemini's `--prompt`), so fold
// argv in too — the judge must read the prompt regardless of the provider's transport.
prompt += "\n" + process.argv.slice(2).join("\n");

const ids = [...prompt.matchAll(/candidate (run_[A-Za-z0-9_]+)/g)].map((m) => m[1]);
const verdict = { verdict: "approve" };
if (ids.length) {
  verdict.recommendedChildId = ids[0];
  verdict.ranking = ids.map((id, index) => ({
    childId: id,
    score: ids.length - index,
    note: index === 0 ? "best fit" : "viable",
  }));
}

process.stdout.write("Reviewed the candidates.\n");
process.stdout.write("PORTICO_JUDGE: " + JSON.stringify(verdict) + "\n");
process.exit(0);
