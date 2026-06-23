import { getStore } from "@netlify/blobs";
import { addPosts } from "./feed-store.mjs";

const W_PDS = "https://pds.wsocial.network";
const STORE_NAME = "wsocial-feed";
const STATE_KEY = "backfill-state";

const DAYS_BACK = Number(process.env.DAYS_BACK ?? 7);
const MAX_DIDS_PER_RUN = Number(process.env.MAX_DIDS_PER_RUN ?? 50);
const RECORDS_PER_DID = Number(process.env.RECORDS_PER_DID ?? 50);
const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS ?? 50);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 10000);

function getStateStore() {
  return getStore({
    name: STORE_NAME,
    consistency: "strong",
  });
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "wsocial-local-feed/0.1",
      },
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function readBackfillState() {
  const store = getStateStore();

  const state = await store.get(STATE_KEY, {
    type: "json",
    consistency: "strong",
  });

  if (!state || typeof state !== "object") {
    return {};
  }

  return state;
}

async function writeState(state) {
  const store = getStateStore();
  await store.setJSON(STATE_KEY, state);
}

async function listWsocialDids(cursor) {
  const url = new URL(`${W_PDS}/xrpc/com.atproto.sync.listRepos`);
  url.searchParams.set("limit", String(MAX_DIDS_PER_RUN));

  if (cursor) {
    url.searchParams.set("cursor", cursor);
  }

  const data = await fetchJson(url);

  const dids = [];

  for (const repo of data.repos ?? []) {
    if (repo.did && repo.active !== false) {
      dids.push(repo.did);
    }
  }

  return {
    dids,
    cursor: data.cursor ?? null,
  };
}

async function getRecentPostsForDid(did, cutoff) {
  const url = new URL(`${W_PDS}/xrpc/com.atproto.repo.listRecords`);
  url.searchParams.set("repo", did);
  url.searchParams.set("collection", "app.bsky.feed.post");
  url.searchParams.set("limit", String(RECORDS_PER_DID));
  url.searchParams.set("reverse", "true");

  const data = await fetchJson(url);
  const posts = [];

  for (const record of data.records ?? []) {
    const value = record.value ?? {};
    const createdAt = value.createdAt;

    if (!createdAt) continue;
    if (new Date(createdAt) < cutoff) continue;

    posts.push({
      uri: record.uri,
      cid: record.cid ?? null,
      did,
      createdAt,
      text: value.text ?? "",
    });
  }

  return posts;
}

export async function runBackfill() {
  const startedAt = new Date();
  const cutoff = new Date(startedAt.getTime() - DAYS_BACK * 24 * 60 * 60 * 1000);

  const previousState = await readBackfillState();

  let cursor = previousState.cursor ?? null;
  let wrappedToStart = false;

  let didResult = await listWsocialDids(cursor);

  if (didResult.dids.length === 0 && cursor) {
    cursor = null;
    wrappedToStart = true;
    didResult = await listWsocialDids(cursor);
  }

  const allNewPosts = [];
  const errors = [];

  for (const did of didResult.dids) {
    try {
      const posts = await getRecentPostsForDid(did, cutoff);
      allNewPosts.push(...posts);
    } catch (error) {
      if (error.message.startsWith("400 ")) {
        // Empty or unusual repos may not have an app.bsky.feed.post collection.
        // Treat those as accounts with no posts instead of noisy failures.
      } else {
        errors.push({
          did,
          message: error.message,
        });
      }
    }

    if (REQUEST_DELAY_MS > 0) {
      await sleep(REQUEST_DELAY_MS);
    }
  }

  const savedPosts = await addPosts(allNewPosts);

  const nextCursor = didResult.cursor ?? null;

  await writeState({
    cursor: nextCursor,
    lastRunAt: startedAt.toISOString(),
    cutoff: cutoff.toISOString(),
    processedDids: didResult.dids.length,
    foundPosts: allNewPosts.length,
    storedPosts: savedPosts.length,
    errors: errors.slice(0, 20),
    wrappedToStart: wrappedToStart || !nextCursor,
  });

  return {
    ok: true,
    startedAt: startedAt.toISOString(),
    cutoff: cutoff.toISOString(),
    nextCursor,
    wrappedToStart: wrappedToStart || !nextCursor,
    processedDids: didResult.dids.length,
    foundPosts: allNewPosts.length,
    storedPosts: savedPosts.length,
    errorCount: errors.length,
    errors: errors.slice(0, 5),
  };
}
