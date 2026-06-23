import { getStore } from "@netlify/blobs";
import { addPosts } from "./feed-store.mjs";
import {
  collectPostsForDid,
  listWsocialDidsPage,
} from "../../lib/wsocial-source.mjs";

const STORE_NAME = "wsocial-feed";
const STATE_KEY = "backfill-state";
const LOCK_KEY = "backfill-lock";

// 0 days back means "no cutoff" (collect all available history). Netlify runs
// incrementally so a modest window is enough to catch up between runs; the full
// historical load is meant to come from the local scrape + admin import.
const DAYS_BACK = Number(process.env.DAYS_BACK ?? 7);
const MAX_DIDS_PER_RUN = Number(process.env.MAX_DIDS_PER_RUN ?? 75);
const RECORDS_PER_PAGE = Number(process.env.RECORDS_PER_PAGE ?? 100);
const MAX_RECORD_PAGES_PER_DID = Number(process.env.MAX_RECORD_PAGES_PER_DID ?? 10);
const MAX_POSTS_PER_DID = Number(process.env.MAX_POSTS_PER_DID ?? 1000);
const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS ?? 25);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 10000);
// Soft wall-clock budget per run. Kept well under Netlify's synchronous-function
// HTTP timeout (~26s) so a manually triggered run always returns cleanly and
// saves its progress instead of being killed mid-flight.
const MAX_RUN_MS = Number(process.env.MAX_RUN_MS ?? 16000);
// How long a lock is considered valid if a run dies without releasing it.
const LOCK_TTL_MS = Number(process.env.LOCK_TTL_MS ?? 60000);

function getStateStore() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function readBackfillState() {
  const store = getStateStore();
  const state = await store.get(STATE_KEY, { type: "json", consistency: "strong" });

  if (!state || typeof state !== "object") {
    return {};
  }

  return state;
}

async function writeState(state) {
  const store = getStateStore();
  await store.setJSON(STATE_KEY, state);
}

export async function readLock() {
  const store = getStateStore();
  const lock = await store.get(LOCK_KEY, { type: "json", consistency: "strong" });

  if (!lock || typeof lock !== "object") {
    return { locked: false };
  }

  const active = typeof lock.expiresAt === "number" && Date.now() < lock.expiresAt;

  return {
    locked: active,
    id: lock.id ?? null,
    acquiredAt: lock.acquiredAt ?? null,
    expiresAt: lock.expiresAt ? new Date(lock.expiresAt).toISOString() : null,
  };
}

// Best-effort lock to stop overlapping runs (e.g. a manual "Run now" landing on
// top of the scheduled run). Read-then-write is not perfectly atomic, but the
// TTL guarantees a crashed run can never wedge the job for more than LOCK_TTL_MS.
async function acquireLock() {
  const store = getStateStore();
  const now = Date.now();
  const existing = await store.get(LOCK_KEY, { type: "json", consistency: "strong" });

  if (existing && typeof existing.expiresAt === "number" && now < existing.expiresAt) {
    return {
      acquired: false,
      lockedUntil: new Date(existing.expiresAt).toISOString(),
    };
  }

  const id = `${now}-${Math.random().toString(36).slice(2, 10)}`;
  await store.setJSON(LOCK_KEY, {
    id,
    acquiredAt: new Date(now).toISOString(),
    expiresAt: now + LOCK_TTL_MS,
  });

  return { acquired: true, id };
}

async function releaseLock(id) {
  const store = getStateStore();
  const existing = await store.get(LOCK_KEY, { type: "json", consistency: "strong" });

  // Only delete the lock if it is still ours (or already gone/expired).
  if (!existing || existing.id === id) {
    await store.delete(LOCK_KEY);
  }
}

async function doBackfill() {
  const startedAt = new Date();
  const cutoff =
    DAYS_BACK > 0 ? new Date(startedAt.getTime() - DAYS_BACK * 86400000) : null;
  const deadline = MAX_RUN_MS > 0 ? Date.now() + MAX_RUN_MS : Infinity;

  const previousState = await readBackfillState();
  const startCursor = previousState.cursor ?? null;
  const startOffset = Number.isInteger(previousState.didOffset)
    ? previousState.didOffset
    : 0;

  // `cursor` selects which listRepos page we are on; `didOffset` is how far into
  // that page we already processed. Together they let a heavy page resume mid-way
  // on the next run instead of restarting (which previously caused a doom loop on
  // dense blocks of active accounts).
  let pageCursor = startCursor;
  let offset = startOffset;

  let page = await listWsocialDidsPage({
    cursor: pageCursor,
    limit: MAX_DIDS_PER_RUN,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });

  // If the saved cursor pointed past the end of the repo list, wrap back to the
  // start so the sweep keeps cycling (good for catching new posts over time).
  let wrappedToStart = false;
  if (page.dids.length === 0 && pageCursor) {
    wrappedToStart = true;
    pageCursor = null;
    offset = 0;
    page = await listWsocialDidsPage({
      cursor: null,
      limit: MAX_DIDS_PER_RUN,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
  }

  // Defensive: if the page shrank below our saved offset, restart the page.
  if (offset >= page.dids.length) offset = 0;

  const allNewPosts = [];
  const errors = [];
  let skippedEmptyRepos = 0;
  let didsWithPosts = 0;
  let recordPagesFetched = 0;
  let processedDids = 0;
  let stoppedEarly = false;

  let index = offset;
  for (; index < page.dids.length; index++) {
    if (Date.now() > deadline) {
      stoppedEarly = true;
      break;
    }

    const did = page.dids[index];

    try {
      const result = await collectPostsForDid(did, {
        cutoff,
        maxPages: MAX_RECORD_PAGES_PER_DID,
        maxPosts: MAX_POSTS_PER_DID,
        pageLimit: RECORDS_PER_PAGE,
        requestDelayMs: REQUEST_DELAY_MS,
        timeoutMs: REQUEST_TIMEOUT_MS,
      });

      recordPagesFetched += result.pages;

      if (result.posts.length > 0) {
        didsWithPosts += 1;
        allNewPosts.push(...result.posts);
      } else {
        // 200 with no matching records: empty repo or no recent posts. Not a
        // failure.
        skippedEmptyRepos += 1;
      }
    } catch (error) {
      // Keep going, but record the status and body so 400s can be diagnosed
      // instead of being silently swallowed.
      errors.push({
        did,
        status: error.status ?? null,
        message: error.message,
        body: error.body ?? null,
      });
    }

    processedDids += 1;
    if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
  }

  const saved = await addPosts(allNewPosts);

  // Where to resume next run:
  // - stopped early  -> same page, at the next unprocessed DID
  // - finished page  -> next page, offset 0
  let nextCursor;
  let nextOffset;
  if (stoppedEarly) {
    nextCursor = pageCursor;
    nextOffset = index;
  } else {
    nextCursor = page.cursor ?? null;
    nextOffset = 0;
  }
  const finishedSweep = !stoppedEarly && !page.cursor;

  const finishedAt = new Date();

  const state = {
    cursor: nextCursor,
    didOffset: nextOffset,
    lastRunAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    cutoff: cutoff ? cutoff.toISOString() : null,
    daysBack: DAYS_BACK,
    repoCursorBefore: startCursor,
    repoCursorAfter: nextCursor,
    didOffsetBefore: startOffset,
    didOffsetAfter: nextOffset,
    pageDidCount: page.dids.length,
    processedDids,
    didsWithPosts,
    skippedEmptyRepos,
    recordPagesFetched,
    foundPosts: allNewPosts.length,
    storedPosts: saved.length,
    errorCount: errors.length,
    errors: errors.slice(0, 20),
    stoppedEarly,
    wrappedToStart,
    finishedSweep,
    lastPosts: allNewPosts.slice(0, 5).map((post) => ({
      uri: post.uri,
      createdAt: post.createdAt,
      text: post.text.slice(0, 140),
    })),
  };

  await writeState(state);

  return {
    ok: true,
    skipped: false,
    startedAt: startedAt.toISOString(),
    durationMs: state.durationMs,
    cutoff: state.cutoff,
    repoCursorBefore: startCursor,
    repoCursorAfter: nextCursor,
    didOffsetBefore: startOffset,
    didOffsetAfter: nextOffset,
    processedDids,
    didsWithPosts,
    skippedEmptyRepos,
    foundPosts: allNewPosts.length,
    storedPosts: saved.length,
    errorCount: errors.length,
    errors: errors.slice(0, 5),
    stoppedEarly,
    wrappedToStart,
    finishedSweep,
  };
}

export async function runBackfill() {
  const lock = await acquireLock();

  if (!lock.acquired) {
    return {
      ok: false,
      skipped: true,
      reason: "locked",
      message: "Another backfill is already running.",
      lockedUntil: lock.lockedUntil,
    };
  }

  try {
    return await doBackfill();
  } finally {
    await releaseLock(lock.id);
  }
}
