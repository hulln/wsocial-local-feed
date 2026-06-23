import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DATA_DIR = "data";
const POSTS_PATH = path.join(DATA_DIR, "posts.json");
const MAX_POSTS = Number(process.env.MAX_POSTS ?? 10000);

export async function readPosts() {
  await mkdir(DATA_DIR, { recursive: true });

  try {
    const text = await readFile(POSTS_PATH, "utf8");
    return JSON.parse(text);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

export async function writePosts(posts) {
  await mkdir(DATA_DIR, { recursive: true });

  const sortedPosts = [...posts].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );

  const limitedPosts = sortedPosts.slice(0, MAX_POSTS);

  await writeFile(POSTS_PATH, JSON.stringify(limitedPosts, null, 2), "utf8");

  return limitedPosts;
}

export async function addPosts(newPosts) {
  const existingPosts = await readPosts();
  const postsByUri = new Map();

  for (const post of existingPosts) {
    if (post.uri) {
      postsByUri.set(post.uri, post);
    }
  }

  for (const post of newPosts) {
    if (!post.uri || !post.createdAt) {
      continue;
    }

    postsByUri.set(post.uri, {
      uri: post.uri,
      cid: post.cid ?? null,
      did: post.did ?? null,
      createdAt: post.createdAt,
      text: post.text ?? "",
    });
  }

  return writePosts([...postsByUri.values()]);
}
