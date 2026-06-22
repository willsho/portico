import { promises as fs } from "node:fs";
import { glob } from "node:fs/promises";
import { join } from "node:path";
import { capture } from "@portico/core";

/**
 * Build context sections from explicit files and git diffs.
 */
export async function buildContextSections(
  repo: string,
  contextArgs: string[] = [],
  contextDiffArgs: string[] = [],
  maxChars = 40000,
): Promise<string> {
  const sections: string[] = [];

  // 1. Process --context arguments (in order)
  for (const pattern of contextArgs) {
    const hasGlob = pattern.includes("*") || pattern.includes("?") || pattern.includes("[");
    let matchedPaths: string[] = [];

    if (hasGlob) {
      try {
        for await (const entry of glob(pattern, { cwd: repo })) {
          matchedPaths.push(entry);
        }
      } catch (err) {
        console.error(
          `[portico] warning: glob error for pattern "${pattern}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (matchedPaths.length === 0) {
        console.error(`[portico] warning: context pattern "${pattern}" matched zero files`);
        continue;
      }
      matchedPaths.sort();
    } else {
      // Treat as literal path
      const fullPath = join(repo, pattern);
      let isFile = false;
      try {
        const stat = await fs.stat(fullPath);
        isFile = stat.isFile();
      } catch {
        // file doesn't exist or is inaccessible
      }
      if (!isFile) {
        console.error(`[portico] warning: context path "${pattern}" matched zero files`);
        continue;
      }
      matchedPaths = [pattern];
    }

    for (const relPath of matchedPaths) {
      const fullPath = join(repo, relPath);
      try {
        const content = await fs.readFile(fullPath, "utf8");
        if (content.includes("\0")) {
          console.error(`[portico] warning: context file "${relPath}" is binary`);
          continue;
        }
        sections.push(`### Context: ${relPath}\n\`\`\`\n${content}${content.endsWith("\n") ? "" : "\n"}\`\`\``);
      } catch (err) {
        console.error(
          `[portico] warning: failed to read context file "${relPath}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  // 2. Process --context-diff arguments (in order)
  for (const ref of contextDiffArgs) {
    try {
      const res = await capture("git", ["-C", repo, "diff", ref]);
      if (res.code !== 0 || res.error) {
        console.error(
          `[portico] warning: git diff for ref "${ref}" failed${res.error ? `: ${res.error}` : ""}${
            res.stderr ? `: ${res.stderr.trim()}` : ""
          }`,
        );
        continue;
      }
      sections.push(`### Context diff: ${ref}\n\`\`\`diff\n${res.stdout}${res.stdout.endsWith("\n") ? "" : "\n"}\`\`\``);
    } catch (err) {
      console.error(
        `[portico] warning: failed to run git diff for ref "${ref}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  if (sections.length === 0) {
    return "";
  }

  const fullText = sections.join("\n\n");
  if (fullText.length > maxChars) {
    const omitted = fullText.length - maxChars;
    const truncated = fullText.slice(0, maxChars);
    const newline = truncated.endsWith("\n") ? "" : "\n";
    return truncated + newline + `[... context truncated, ${omitted} more characters omitted ...]`;
  }

  return fullText;
}
