import { addPosts, readPosts, writePosts } from "../lib/feed-store.mjs";

const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? null;

function json(status, data) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

// Accept the token via "Authorization: Bearer <token>" or "x-admin-token".
// Avoid putting the token in the query string so it does not end up in logs.
function getToken(request) {
  const auth = request.headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return request.headers.get("x-admin-token");
}

export default async function handler(request) {
  if (request.method !== "POST") {
    return json(405, { error: "MethodNotAllowed", message: "Use POST." });
  }

  if (!ADMIN_TOKEN) {
    return json(503, {
      error: "NotConfigured",
      message: "Set the ADMIN_TOKEN environment variable to enable imports.",
    });
  }

  const token = getToken(request);
  if (!token || token !== ADMIN_TOKEN) {
    return json(401, { error: "Unauthorized", message: "Missing or invalid token." });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: "InvalidJSON", message: "Body must be JSON." });
  }

  const posts = Array.isArray(payload) ? payload : payload?.posts;
  if (!Array.isArray(posts)) {
    return json(400, {
      error: "InvalidRequest",
      message: "Expected a JSON array of posts, or { posts: [...] }.",
    });
  }

  const url = new URL(request.url);
  const replace = url.searchParams.get("replace") === "true";

  const before = (await readPosts()).length;
  const saved = replace ? await writePosts(posts) : await addPosts(posts);

  return json(200, {
    ok: true,
    mode: replace ? "replace" : "merge",
    received: posts.length,
    storedBefore: before,
    storedAfter: saved.length,
  });
}

export const config = {
  path: ["/admin/import"],
};
