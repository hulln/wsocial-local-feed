// Full historical archive of every public post (app.bsky.feed.post) from every
// active repo on a PDS. Unlike the live feed, this keeps the COMPLETE record for
// each post and applies no count cap and no date cutoff — it's meant for offline
// content analysis and cross-network comparison.
//
// Output is JSONL (one post per line) at data/archive/<network>-posts.jsonl, plus
// a resumable progress file so a long run can be stopped (Ctrl-C) and continued.
//
// Point it at any PDS with W_PDS; NETWORK only sets the output filenames.
//
//   NETWORK=wsocial W_PDS=https://pds.wsocial.network npm run archive
//   NETWORK=eurosky W_PDS=https://eurosky.social      npm run archive
//
//   MAX_DIDS=20 NETWORK=wsocial npm run archive    # quick test over 20 repos
//
// Each JSONL line: { uri, cid, did, ...full record value, embedType }

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

// Self-contained: no local imports and no npm packages, so this single file can
// be copied to any machine with Node >= 18 (built-in fetch) and run as-is.

const W_PDS = process.env.W_PDS ?? "https://pds.wsocial.network";
const COLLECTION = "app.bsky.feed.post";
const USER_AGENT = "atproto-archive/1.0";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// fetch() with a timeout; throws an Error carrying the HTTP status + a body
// snippet so failures can be diagnosed instead of guessed.
async function fetchJson(url, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const error = new Error(`${response.status} ${response.statusText}: ${body.slice(0, 300)}`);
      error.status = response.status;
      throw error;
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

// One page of com.atproto.sync.listRepos -> active DIDs + next cursor (null at end).
async function listReposPage({ cursor, limit = 1000, timeoutMs } = {}) {
  const url = new URL(`${W_PDS}/xrpc/com.atproto.sync.listRepos`);
  url.searchParams.set("limit", String(limit));
  if (cursor) url.searchParams.set("cursor", cursor);
  const data = await fetchJson(url, { timeoutMs });
  const dids = [];
  for (const repo of data.repos ?? []) {
    if (repo.did && repo.active !== false) dids.push(repo.did);
  }
  return { dids, cursor: data.cursor ?? null };
}

const NETWORK = process.env.NETWORK ?? "wsocial";
const OUT_DIR = process.env.OUT_DIR ?? "data/archive";
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 5);
const RECORDS_PER_PAGE = Number(process.env.RECORDS_PER_PAGE ?? 100);
const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS ?? 25);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 15000);
const MAX_POSTS_PER_DID = Number(process.env.MAX_POSTS_PER_DID ?? 0); // 0 = unlimited
const MAX_PAGES_PER_DID = Number(process.env.MAX_PAGES_PER_DID ?? 0); // 0 = unlimited
const MAX_DIDS = Number(process.env.MAX_DIDS ?? 0); // 0 = all (for testing)
const DAYS_BACK = Number(process.env.DAYS_BACK ?? 0); // 0 = all history
const CHECKPOINT_EVERY = Number(process.env.CHECKPOINT_EVERY ?? 25);

const postsPath = path.join(OUT_DIR, `${NETWORK}-posts.jsonl`);
const progressPath = path.join(OUT_DIR, `${NETWORK}-progress.json`);

const cutoff = DAYS_BACK > 0 ? new Date(Date.now() - DAYS_BACK * 86400000) : null;

// ---- resumable progress -----------------------------------------------------

async function loadProgress() {
  try {
    const text = await readFile(progressPath, "utf8");
    const data = JSON.parse(text);
    return {
      completed: new Set(data.completedDids ?? []),
      postsWritten: data.postsWritten ?? 0,
    };
  } catch (error) {
    if (error.code === "ENOENT") return { completed: new Set(), postsWritten: 0 };
    throw error;
  }
}

async function saveProgress(completed, stats) {
  const payload = {
    network: NETWORK,
    pds: W_PDS,
    updatedAt: new Date().toISOString(),
    completedRepos: completed.size,
    postsWritten: stats.postsWritten,
    reposWithPosts: stats.reposWithPosts,
    emptyRepos: stats.emptyRepos,
    errorCount: stats.errors.length,
    completedDids: [...completed],
  };
  // Write to a temp file then rename (atomic on the same filesystem) so a crash
  // mid-write can't corrupt the progress file a resume depends on.
  const tmp = `${progressPath}.tmp`;
  await writeFile(tmp, JSON.stringify(payload), "utf8");
  await rename(tmp, progressPath);
}

// ---- serialized appends (workers fetch concurrently, file writes are queued) -

let writeChain = Promise.resolve();
function appendLines(lines) {
  writeChain = writeChain.then(() => appendFile(postsPath, lines, "utf8"));
  return writeChain;
}

// ---- collect every post for one repo ----------------------------------------

async function collectAllPosts(did) {
  const lines = [];
  let cursor;
  let pages = 0;
  let count = 0;

  while (true) {
    if (MAX_PAGES_PER_DID > 0 && pages >= MAX_PAGES_PER_DID) break;
    if (MAX_POSTS_PER_DID > 0 && count >= MAX_POSTS_PER_DID) break;

    const url = new URL(`${W_PDS}/xrpc/com.atproto.repo.listRecords`);
    url.searchParams.set("repo", did);
    url.searchParams.set("collection", COLLECTION);
    url.searchParams.set("limit", String(RECORDS_PER_PAGE));
    if (cursor) url.searchParams.set("cursor", cursor);

    const data = await fetchJson(url, { timeoutMs: TIMEOUT_MS });
    pages += 1;

    const records = data.records ?? [];
    if (records.length === 0) break;

    let hitCutoff = false;
    for (const record of records) {
      const value = record.value ?? {};

      // Records come back newest-first, so the first one older than the cutoff
      // means every remaining record is older too.
      if (cutoff) {
        const created = value.createdAt ? new Date(value.createdAt) : null;
        if (created && !Number.isNaN(created.getTime()) && created < cutoff) {
          hitCutoff = true;
          break;
        }
      }

      const line = {
        uri: record.uri,
        cid: record.cid ?? null,
        did,
        ...value,
        embedType: value.embed?.$type ?? null,
      };
      lines.push(JSON.stringify(line));
      count += 1;
      if (MAX_POSTS_PER_DID > 0 && count >= MAX_POSTS_PER_DID) break;
    }

    if (hitCutoff) break;
    if (!data.cursor) break;
    cursor = data.cursor;
    if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
  }

  return { lines, count, pages };
}

// ---- gather all DIDs (listRepos pagination is cheap) ------------------------

async function gatherAllDids() {
  const dids = [];
  let cursor;
  while (true) {
    const page = await listReposPage({ cursor, limit: 1000, timeoutMs: TIMEOUT_MS });
    dids.push(...page.dids);
    if (MAX_DIDS > 0 && dids.length >= MAX_DIDS) return dids.slice(0, MAX_DIDS);
    if (!page.cursor) return dids;
    cursor = page.cursor;
  }
}

// ---- main -------------------------------------------------------------------

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  console.log(`Archiving ${NETWORK} posts from ${W_PDS}`);
  console.log(`Cutoff:      ${cutoff ? cutoff.toISOString() : "none (all history)"}`);
  console.log(`Output:      ${postsPath}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log("");

  const { completed, postsWritten } = await loadProgress();
  if (completed.size > 0) {
    console.log(`Resuming: ${completed.size} repos already done, ${postsWritten} posts on disk.`);
  }

  console.log("Listing repos...");
  const allDids = await gatherAllDids();
  const todo = allDids.filter((did) => !completed.has(did));
  console.log(`${allDids.length} active repos total, ${todo.length} left to archive.`);
  console.log("");

  const stats = {
    postsWritten,
    reposWithPosts: 0,
    emptyRepos: 0,
    errors: [],
    processedThisRun: 0,
  };

  // Graceful stop: on Ctrl-C (SIGINT) or `docker compose stop` (SIGTERM), let the
  // in-flight repos finish, then checkpoint and exit. A second signal forces quit.
  let stopping = false;
  const onSignal = (sig) => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`\nReceived ${sig}; finishing in-flight repos then saving progress... (signal again to force quit)`);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  let cursor = 0;
  async function worker() {
    while (cursor < todo.length && !stopping) {
      const did = todo[cursor++];
      try {
        const { lines, count } = await collectAllPosts(did);
        if (lines.length > 0) {
          await appendLines(lines.join("\n") + "\n");
          stats.postsWritten += count;
          stats.reposWithPosts += 1;
        } else {
          stats.emptyRepos += 1;
        }
        completed.add(did);
      } catch (error) {
        stats.errors.push({ did, status: error.status ?? null, message: error.message });
      }

      stats.processedThisRun += 1;
      if (stats.processedThisRun % CHECKPOINT_EVERY === 0) {
        await saveProgress(completed, stats);
      }
      if (stats.processedThisRun % 100 === 0) {
        const done = completed.size;
        console.log(
          `  ${done}/${allDids.length} repos | ${stats.postsWritten} posts | ` +
            `${stats.reposWithPosts} with posts, ${stats.emptyRepos} empty, ${stats.errors.length} errors`
        );
      }
      if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  await writeChain; // ensure all queued appends are flushed
  await saveProgress(completed, stats);

  console.log("");
  console.log(stopping ? "Stopped (resumable)." : "Done.");
  console.log(`Repos completed:   ${completed.size}/${allDids.length}`);
  console.log(`Repos with posts:  ${stats.reposWithPosts}`);
  console.log(`Empty repos:       ${stats.emptyRepos}`);
  console.log(`Errors:            ${stats.errors.length}`);
  console.log(`Posts written:     ${stats.postsWritten}`);
  console.log(`Archive file:      ${postsPath}`);

  if (stats.errors.length > 0) {
    console.log("");
    console.log("First few errors:");
    for (const e of stats.errors.slice(0, 10)) {
      console.log(`  ${e.did}: ${e.status ?? ""} ${e.message}`);
    }
  }
}

main().catch((error) => {
  console.error("Failed:");
  console.error(error);
  process.exit(1);
});
