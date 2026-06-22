import { parseArgs } from "node:util";
import {
  DaemonUnreachableError,
  daemonUrl,
  requestJson,
  resolveRepoArg,
} from "./http.ts";
import { getNextActionHint } from "./delegate.ts";
import { buildRunVerdict } from "@portico/orchestrator";
import type { RunDetails } from "@portico/orchestrator";

export async function resultCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      json: { type: "boolean" },
      url: { type: "string" },
      token: { type: "string" },
    },
  });

  if (values.help) {
    console.log(`Usage: portico result <run_id> [options]

Options:
  --repo <path>            Repository path (default: cwd)
  --json                   Output JSON format
  --url <url>              Daemon URL
  --token <token>          Auth token
  -h, --help               Show this help message`);
    return 0;
  }

  const runId = positionals[0];
  if (!runId) {
    console.error("Usage: portico result <run_id> [--repo .]");
    return 1;
  }

  let details: RunDetails;
  try {
    const target = `${daemonUrl(values.url)}/runs/${encodeURIComponent(runId)}?repo=${encodeURIComponent(
      resolveRepoArg(values.repo),
    )}`;
    details = await requestJson<RunDetails>(target, {}, values.token);
  } catch (err) {
    if (err instanceof DaemonUnreachableError) return 1;
    throw err;
  }

  const verdict = buildRunVerdict(details.run, details.result);
  const nextAction = getNextActionHint(details.run, details.result?.reviewDecision);

  if (values.json) {
    console.log(
      JSON.stringify(
        {
          id: details.run.id,
          status: details.run.status,
          role: details.run.role ?? "single",
          verdict,
          next: nextAction,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(`run ${details.run.id}: ${details.run.status}`);
  console.log(verdict.topRisks.length ? verdict.topRisks.join("\n") : "no risks recorded.");
  console.log("");
  console.log(`next: ${nextAction}`);

  if ((details.run.role ?? "single") === "group") {
    console.log(`this is a group parent; children should be reviewed via portico review ${details.run.id}`);
  }

  return 0;
}
