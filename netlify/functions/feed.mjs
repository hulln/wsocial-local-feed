import { readPosts } from "../lib/feed-store.mjs";
import { readBackfillState, readLock } from "../lib/wsocial-backfill.mjs";

const CONFIGURED_SERVICE_DID = process.env.SERVICE_DID ?? null;
const FEED_OWNER_DID = process.env.FEED_OWNER_DID ?? null;
const FEED_RKEY = process.env.FEED_RKEY ?? "wsocial-local";

function getServiceDid(url) {
  return CONFIGURED_SERVICE_DID ?? `did:web:${url.hostname}`;
}

function getFeedOwnerDid(url) {
  return FEED_OWNER_DID ?? getServiceDid(url);
}

function getFeedUri(url) {
  return `at://${getFeedOwnerDid(url)}/app.bsky.feed.generator/${FEED_RKEY}`;
}

function json(status, data) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function text(status, body) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function parseLimit(value) {
  const limit = Number(value ?? 50);

  if (!Number.isFinite(limit)) return 50;
  if (limit < 1) return 1;
  if (limit > 100) return 100;

  return Math.floor(limit);
}

function parseCursor(value) {
  const cursor = Number(value ?? 0);

  if (!Number.isFinite(cursor)) return 0;
  if (cursor < 0) return 0;

  return Math.floor(cursor);
}

export default async function handler(request) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  const serviceDid = getServiceDid(url);
  const feedUri = getFeedUri(url);

  if (pathname === "/.well-known/did.json") {
    return json(200, {
      "@context": ["https://www.w3.org/ns/did/v1"],
      id: serviceDid,
      service: [
        {
          id: "#bsky_fg",
          type: "BskyFeedGenerator",
          serviceEndpoint: url.origin,
        },
      ],
    });
  }

  if (pathname === "/" || pathname === "/.netlify/functions/feed") {
    const posts = await readPosts();

    return text(
      200,
      [
        "W Social Local Feed",
        "",
        "Experimental unofficial chronological feed for public posts from accounts hosted on the W Social PDS.",
        "",
        `Stored posts: ${posts.length}`,
        `Service DID: ${serviceDid}`,
        `Feed URI: ${feedUri}`,
        "",
        "Endpoints:",
        "- /.well-known/did.json",
        "- /posts.json",
        "- /backfill-state.json",
        "- /xrpc/app.bsky.feed.describeFeedGenerator",
        "- /xrpc/app.bsky.feed.getFeedSkeleton",
      ].join("\n")
    );
  }

  if (pathname === "/posts.json") {
    const posts = await readPosts();
    return json(200, posts);
  }

  if (pathname === "/backfill-state.json") {
    const [state, lock] = await Promise.all([readBackfillState(), readLock()]);
    return json(200, { ...state, lock });
  }

  if (pathname === "/xrpc/app.bsky.feed.describeFeedGenerator") {
    return json(200, {
      did: serviceDid,
      feeds: [
        {
          uri: feedUri,
        },
      ],
    });
  }

  if (pathname === "/xrpc/app.bsky.feed.getFeedSkeleton") {
    const requestedFeed = url.searchParams.get("feed");

    if (requestedFeed && requestedFeed !== feedUri) {
      return json(400, {
        error: "InvalidRequest",
        message: "Feed not found",
      });
    }

    const posts = await readPosts();

    const limit = parseLimit(url.searchParams.get("limit"));
    const cursor = parseCursor(url.searchParams.get("cursor"));

    const page = posts.slice(cursor, cursor + limit);
    const nextCursor =
      cursor + limit < posts.length ? String(cursor + limit) : undefined;

    const body = {
      feed: page.map((post) => ({
        post: post.uri,
      })),
    };

    if (nextCursor) {
      body.cursor = nextCursor;
    }

    return json(200, body);
  }

  return json(404, {
    error: "NotFound",
    message: "Endpoint not found",
  });
}

export const config = {
  path: [
    "/",
    "/.well-known/did.json",
    "/posts.json",
    "/backfill-state.json",
    "/xrpc/app.bsky.feed.describeFeedGenerator",
    "/xrpc/app.bsky.feed.getFeedSkeleton",
  ],
};
