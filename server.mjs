import http from "node:http";
import { readPosts } from "./lib/post-store.mjs";

const PORT = Number(process.env.PORT ?? 3000);

const FEED_DID = process.env.FEED_DID ?? "did:web:localhost";
const FEED_RKEY = process.env.FEED_RKEY ?? "wsocial-local";
const FEED_URI =
  process.env.FEED_URI ??
  `at://${FEED_DID}/app.bsky.feed.generator/${FEED_RKEY}`;

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });

  response.end(JSON.stringify(data, null, 2));
}

function sendText(response, statusCode, text) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });

  response.end(text);
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

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname === "/") {
    const posts = await readPosts();

    return sendText(
      response,
      200,
      [
        "W Social Local Feed",
        "",
        "Experimental unofficial chronological feed for public posts from accounts hosted on the W Social PDS.",
        "",
        `Stored posts: ${posts.length}`,
        `Feed URI: ${FEED_URI}`,
        "",
        "Endpoints:",
        "- /posts.json",
        "- /xrpc/app.bsky.feed.describeFeedGenerator",
        "- /xrpc/app.bsky.feed.getFeedSkeleton",
      ].join("\n")
    );
  }

  if (url.pathname === "/posts.json") {
    const posts = await readPosts();
    return sendJson(response, 200, posts);
  }

  if (url.pathname === "/xrpc/app.bsky.feed.describeFeedGenerator") {
    return sendJson(response, 200, {
      did: FEED_DID,
      feeds: [
        {
          uri: FEED_URI,
        },
      ],
    });
  }

  if (url.pathname === "/xrpc/app.bsky.feed.getFeedSkeleton") {
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

    return sendJson(response, 200, body);
  }

  return sendJson(response, 404, {
    error: "NotFound",
    message: "Endpoint not found",
  });
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    console.error(error);

    sendJson(response, 500, {
      error: "InternalServerError",
      message: error.message,
    });
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Feed URI: ${FEED_URI}`);
});
