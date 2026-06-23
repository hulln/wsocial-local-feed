// Shared, dependency-free helpers for reading public records from the W Social PDS.
//
// Used by both the local scripts (full-scrape.mjs) and the Netlify backfill
// (netlify/lib/wsocial-backfill.mjs). Netlify's esbuild bundler follows the
// import and bundles this file, so keep it free of Netlify-specific imports.

export const W_PDS = process.env.W_PDS ?? "https://pds.wsocial.network";
export const COLLECTION = "app.bsky.feed.post";
const USER_AGENT = "wsocial-local-feed/0.2";

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// fetch() wrapper with a timeout that throws an Error carrying the HTTP status
// and a snippet of the response body, so callers can inspect 400s instead of
// guessing.
export async function fetchJson(url, { timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const error = new Error(
        `${response.status} ${response.statusText}: ${body.slice(0, 300)}`
      );
      error.status = response.status;
      error.statusText = response.statusText;
      error.body = body.slice(0, 500);
      throw error;
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

// One page of com.atproto.sync.listRepos. Returns active DIDs and the cursor
// for the next page (null when there are no more).
export async function listWsocialDidsPage({ cursor, limit = 100, timeoutMs } = {}) {
  const url = new URL(`${W_PDS}/xrpc/com.atproto.sync.listRepos`);
  url.searchParams.set("limit", String(limit));

  if (cursor) {
    url.searchParams.set("cursor", cursor);
  }

  const data = await fetchJson(url, { timeoutMs });
  const repos = data.repos ?? [];
  const dids = [];

  for (const repo of repos) {
    if (repo.did && repo.active !== false) {
      dids.push(repo.did);
    }
  }

  return {
    dids,
    cursor: data.cursor ?? null,
    pageSize: repos.length,
  };
}

// Async generator over every active W-hosted DID, paging through listRepos.
// maxDids = 0 means "no limit".
export async function* iterateAllWsocialDids({
  pageLimit = 1000,
  maxDids = 0,
  timeoutMs,
} = {}) {
  let cursor;
  let count = 0;

  while (true) {
    const page = await listWsocialDidsPage({ cursor, limit: pageLimit, timeoutMs });

    for (const did of page.dids) {
      yield did;
      count += 1;
      if (maxDids > 0 && count >= maxDids) return;
    }

    if (!page.cursor) return;
    cursor = page.cursor;
  }
}

// Collect app.bsky.feed.post records for a single DID, newest first.
//
// Records come back newest-first by default (no reverse), and the cursor walks
// older. We stop when any of these is hit:
//   - a record older than `cutoff` (everything after it is older too)
//   - `maxPosts` collected
//   - `maxPages` fetched
//   - the repo runs out of records (empty page / no cursor)
//
// `cutoff` of null/undefined means "no cutoff" (collect all history).
export async function collectPostsForDid(did, {
  cutoff = null,
  maxPages = 10,
  maxPosts = 1000,
  pageLimit = 100,
  requestDelayMs = 0,
  timeoutMs,
} = {}) {
  const posts = [];
  let cursor;
  let pages = 0;
  let hitCutoff = false;
  let reachedEnd = false;

  while (pages < maxPages && posts.length < maxPosts) {
    const url = new URL(`${W_PDS}/xrpc/com.atproto.repo.listRecords`);
    url.searchParams.set("repo", did);
    url.searchParams.set("collection", COLLECTION);
    url.searchParams.set("limit", String(pageLimit));
    // No `reverse`: default order is newest-first, which is what we want.
    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }

    const data = await fetchJson(url, { timeoutMs });
    pages += 1;

    const records = data.records ?? [];
    if (records.length === 0) {
      reachedEnd = true;
      break;
    }

    for (const record of records) {
      const value = record.value ?? {};
      const createdAt = value.createdAt;

      if (!createdAt) continue;
      const created = new Date(createdAt);
      if (Number.isNaN(created.getTime())) continue;

      // Newest-first, so the first record older than the cutoff means every
      // remaining record (this page and beyond) is older too.
      if (cutoff && created < cutoff) {
        hitCutoff = true;
        break;
      }

      posts.push({
        uri: record.uri,
        cid: record.cid ?? null,
        did,
        createdAt,
        text: value.text ?? "",
      });

      if (posts.length >= maxPosts) break;
    }

    if (hitCutoff) break;
    if (!data.cursor) {
      reachedEnd = true;
      break;
    }
    cursor = data.cursor;

    if (requestDelayMs > 0) await sleep(requestDelayMs);
  }

  return {
    posts,
    pages,
    hitCutoff,
    reachedEnd,
    // We stopped on a limit rather than reaching the natural end of the repo.
    truncated: !reachedEnd && !hitCutoff,
  };
}
