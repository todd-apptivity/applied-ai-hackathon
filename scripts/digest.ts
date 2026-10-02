#!/usr/bin/env tsx
/**
 * The change digest from the terminal.
 *
 *   npm run digest:viewers -- --seed
 *   npm run digest:changes -- --matter 123 --days 30 --no-model
 *   npm run digest:compose -- --matter 123
 *   npm run digest:review  -- --matter 123
 *
 * `--no-model` prints the code-written digest, so the deterministic half is
 * demonstrable with no API key, no UI, and no network beyond Clio — which is
 * also the fastest way to tell a bad changeset from a bad prompt.
 *
 * Clio tokens come from the same gitignored `.clio/tokens.json` the dev server
 * uses, so connect once at /clio and the CLI works too.
 */

import { markReviewed, getReviewState } from "../src/lib/changes/checkpoint";
import { changeDigest, matterLabel } from "../src/lib/changes/digest";
import { digestCount } from "../src/lib/changes/cache";
import { databasePath } from "../src/lib/db/sqlite";
import {
  defaultViewer,
  getViewer,
  listViewers,
  seedViewersFromClio,
  viewerToPrincipal,
} from "../src/lib/identity/viewers";
import { revisionHistoryStart } from "../src/lib/rag/revisions";

try {
  process.loadEnvFile(".env.local");
} catch {
  // Fine if it is absent — the variables may already be exported.
}

type Command = "changes" | "compose" | "viewers" | "review";

interface Args {
  command: Command;
  matterId?: number;
  viewerId?: string;
  days?: number;
  since?: string;
  limit?: number;
  noModel: boolean;
  noSync: boolean;
  json: boolean;
  seed: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "changes",
    noModel: false,
    noSync: false,
    json: false,
    seed: false,
  };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case "--matter":
        args.matterId = Number(argv[(i += 1)]);
        break;
      case "--viewer":
        args.viewerId = argv[(i += 1)];
        break;
      case "--days":
        args.days = Number(argv[(i += 1)]);
        break;
      case "--since":
        args.since = argv[(i += 1)];
        break;
      case "--limit":
        args.limit = Number(argv[(i += 1)]);
        break;
      case "--no-model":
        args.noModel = true;
        break;
      case "--no-sync":
        args.noSync = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--seed":
        args.seed = true;
        break;
      default:
        positional.push(token);
    }
  }

  const command = positional[0];
  if (
    command === "changes" ||
    command === "compose" ||
    command === "viewers" ||
    command === "review"
  ) {
    args.command = command;
  }

  return args;
}

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function resolveViewer(args: Args) {
  if (args.viewerId) {
    const viewer = getViewer(args.viewerId);
    if (!viewer) {
      throw new Error(
        `No viewer "${args.viewerId}". Run \`npm run digest:viewers\` to list them.`,
      );
    }
    return viewer;
  }
  return defaultViewer();
}

function requireMatter(args: Args): number {
  if (!Number.isInteger(args.matterId) || (args.matterId ?? 0) <= 0) {
    throw new Error("Pass --matter <matter id>.");
  }
  return args.matterId!;
}

function windowFor(args: Args) {
  if (args.since) return { kind: "absolute" as const, since: args.since };
  if (Number.isFinite(args.days) && (args.days ?? 0) > 0) {
    return { kind: "relative" as const, days: args.days! };
  }
  return { kind: "checkpoint" as const };
}

async function runChanges(args: Args, compose: boolean): Promise<void> {
  const matterId = requireMatter(args);
  const viewer = resolveViewer(args);

  log(`Database: ${databasePath()}`);
  log(`Matter:   ${matterLabel(matterId)} (${matterId})`);
  log(`Viewer:   ${viewer.name} [${viewer.id}] — ${viewer.role}`);
  log(`History:  ${revisionHistoryStart(matterId) ?? "no change log yet"}`);
  log("");

  const result = await changeDigest({
    principal: viewerToPrincipal(viewer, matterId),
    viewerId: viewer.id,
    matterId,
    window: windowFor(args),
    sync: !args.noSync,
    compose: compose && !args.noModel,
    limit: args.limit,
  });

  if (args.json) {
    log(JSON.stringify(result, null, 2));
    return;
  }

  log(`State:    ${result.state}`);
  log(`Window:   ${result.window.label}`);
  log(`          ${result.window.from ?? "(start of history)"} → ${result.window.to}`);
  log(
    `Sync:     ${result.freshness.mode}${result.freshness.error ? ` — ${result.freshness.error}` : ""}`,
  );
  log(`Changes:  ${result.counts.total}${result.degraded ? " (degraded: inferred from timestamps)" : ""}`);
  if (result.withheld.count > 0) {
    log(
      `Withheld: ${result.withheld.count}${result.withheld.topics.length ? ` (${result.withheld.topics.join(", ")})` : ""}`,
    );
  }
  if (result.notice) log(`Note:     ${result.notice}`);
  log("");

  if (result.events.length > 0) {
    log("Changes");
    log("-------");
    for (const event of result.events) {
      log(`  [${event.ref}] ${event.type} (w${event.weight})`);
      log(`    ${event.summary}`);
      if (event.backdated) log("    BACKDATED");
      if (event.clioUrl) log(`    ${event.clioUrl}`);
    }
    log("");
  }

  if (result.digest) {
    log("Digest");
    log("------");
    log(
      `${result.digest.headline} ${result.digest.headlineRefs.map((r) => `[${r}]`).join(" ")}`,
    );
    for (const section of result.digest.sections) {
      log("");
      log(`  ${section.heading}`);
      for (const sentence of section.sentences) {
        log(`   - ${sentence.text} ${sentence.refs.map((r) => `[${r}]`).join(" ")}`);
      }
    }
    log("");
    log(
      `Written by: ${result.model ?? "code (no model)"}${result.cached ? " — served from cache, 0 model calls" : ""}`,
    );
    if (result.validation) {
      log(
        `Validation: kept ${result.validation.keptSentences}, stripped ${result.validation.strippedSentences}, unknown refs ${result.validation.unknownRefs.length}`,
      );
      for (const reason of result.validation.reasons) log(`  - ${reason}`);
    }
    log(`Cached digests: ${digestCount(matterId)}`);
  }
}

async function runViewers(args: Args): Promise<void> {
  if (args.seed) {
    const { viewers, clioError } = await seedViewersFromClio({
      providerMatterId: args.matterId,
    });
    if (clioError) {
      log(`Clio unavailable (${clioError}); seeded a local firm viewer instead.`);
    }
    for (const viewer of viewers) {
      log(`  ${viewer.id}  ${viewer.name}  [${viewer.role}]`);
    }
    return;
  }

  const viewers = listViewers();
  if (viewers.length === 0) {
    log("No viewers yet. Run `npm run digest:viewers -- --seed`.");
    return;
  }
  for (const viewer of viewers) {
    log(
      `  ${viewer.id}  ${viewer.name}  [${viewer.role}]${viewer.matterId ? ` matter ${viewer.matterId}` : ""}`,
    );
  }
}

function runReview(args: Args): void {
  const matterId = requireMatter(args);
  const viewer = resolveViewer(args);
  const before = getReviewState(viewer.id, matterId);
  const after = markReviewed(viewer.id, matterId);

  log(`Viewer: ${viewer.name} [${viewer.id}]`);
  log(`Before: reviewed_through = ${before?.reviewedThrough ?? "(none)"}`);
  log(`After:  reviewed_through = ${after.reviewedThrough}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case "changes":
      await runChanges(args, false);
      break;
    case "compose":
      await runChanges(args, true);
      break;
    case "viewers":
      await runViewers(args);
      break;
    case "review":
      runReview(args);
      break;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
