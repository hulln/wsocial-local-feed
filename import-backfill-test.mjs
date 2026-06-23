import { readFile } from "node:fs/promises";
import { addPosts, readPosts } from "./lib/post-store.mjs";

const inputPath = "data/backfill-test.json";

const input = await readFile(inputPath, "utf8");
const posts = JSON.parse(input);

console.log(`Read ${posts.length} posts from ${inputPath}`);

const savedPosts = await addPosts(posts);

console.log(`Saved ${savedPosts.length} posts to data/posts.json`);

const latestPosts = await readPosts();

console.log("");
console.log("Latest posts:");

for (const post of latestPosts.slice(0, 5)) {
  console.log("");
  console.log("────────────────────────────");
  console.log(post.createdAt);
  console.log(post.uri);
  console.log(post.text.slice(0, 200));
}
