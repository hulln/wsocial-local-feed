import { getStore } from "@netlify/blobs";

const STORE_NAME = "wsocial-feed";
const POSTS_KEY = "posts";
const MAX_POSTS = Number(process.env.MAX_POSTS ?? 10000);

function getPostsStore() {
  return getStore({
    name: STORE_NAME,
    consistency: "strong",
  });
}

function normalizePost(post) {
  if (!post?.uri || !post?.createdAt) {
    return null;
  }

  return {
    uri: post.uri,
    cid: post.cid ?? null,
    did: post.did ?? null,
    createdAt: post.createdAt,
    text: post.text ?? "",
  };
}

export async function readPosts() {
  const store = getPostsStore();
  const posts = await store.get(POSTS_KEY, {
    type: "json",
    consistency: "strong",
  });

  if (!Array.isArray(posts)) {
    return [];
  }

  return posts;
}

export async function writePosts(posts) {
  const store = getPostsStore();

  const sortedPosts = posts
    .map(normalizePost)
    .filter(Boolean)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, MAX_POSTS);

  await store.setJSON(POSTS_KEY, sortedPosts);

  return sortedPosts;
}

export async function addPosts(newPosts) {
  const existingPosts = await readPosts();
  const postsByUri = new Map();

  for (const post of existingPosts) {
    const normalized = normalizePost(post);

    if (normalized) {
      postsByUri.set(normalized.uri, normalized);
    }
  }

  for (const post of newPosts) {
    const normalized = normalizePost(post);

    if (normalized) {
      postsByUri.set(normalized.uri, normalized);
    }
  }

  return writePosts([...postsByUri.values()]);
}
