// Full historical local scrape of public posts from every active W-hosted repo.
//
// Runs on your machine (no Netlify time limit), paginates each repo newest-first
// until the cutoff/limits, and writes to data/posts.json. Then upload with
// upload-to-netlify.mjs.
//
//   DAYS_BACK=0 npm run scrape          # all history (default)
//   DAYS_BACK=30 npm run scrape         # last 30 days only
//   MAX_DIDS=50 npm run scrape          # quick test over the first 50 repos

import { addPosts, readPosts } from "./lib/post-store.mjs";
import {
  collectPostsForDid,
  iterateAllWsocialDids,
} from "./lib/wsocial-source.mjs";

const DAYS_BACK = Number(process.env.DAYS_BACK ?? 0); // 0 = no cutoff (all history)
const MAX_DIDS = Number(process.env.MAX_DIDS ?? 0); // 0 = all repos
const MAX_POSTS_PER_DID = Number(process.env.MAX_POSTS_PER_DID ?? 5000);
const MAX_RECORD_PAGES_PER_DID = Number(process.env.MAX_RECORD_PAGES_PER_DID ?? 100);
const RECORDS_PER_PAGE = Number(process.env.RECORDS_PER_PAGE ?? 100);
const DELAY_MS = Number(process.env.DELAY_MS ?? 50);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 15000);
const FLUSH_EVERY = Number(process.env.FLUSH_EVERY ?? 100); // save to disk every N repos

async function main() {
  const cutoff = DAYS_BACK > 0 ? new Date(Date.now() - DAYS_BACK * 86400000) : null;

  console.log("W Social full historical scrape");
  console.log(`Cutoff: ${cutoff ? cutoff.toISOString() : "none (all history)"}`);
  console.log(`MAX_DIDS: ${MAX_DIDS === 0 ? "all" : MAX_DIDS}`);
  console.log("");

  let buffer = [];
  let processed = 0;
  let withPosts = 0;
  let emptyRepos = 0;
  let totalFound = 0;
  const errors = [];

  async function flush() {
    if (buffer.length === 0) return;
    const saved = await addPosts(buffer);
    buffer = [];
    console.log(`  ...flushed to disk, store now holds ${saved.length} posts`);
  }

  for await (const did of iterateAllWsocialDids({ maxDids: MAX_DIDS, timeoutMs: TIMEOUT_MS })) {
    processed += 1;

    try {
      const result = await collectPostsForDid(did, {
        cutoff,
        maxPages: MAX_RECORD_PAGES_PER_DID,
        maxPosts: MAX_POSTS_PER_DID,
        pageLimit: RECORDS_PER_PAGE,
        requestDelayMs: DELAY_MS,
        timeoutMs: TIMEOUT_MS,
      });

      if (result.posts.length > 0) {
        withPosts += 1;
        totalFound += result.posts.length;
        buffer.push(...result.posts);
        console.log(`#${processed} ${did} -> ${result.posts.length} posts (${result.pages} pages)`);
      } else {
        emptyRepos += 1;
      }
    } catch (error) {
      errors.push({ did, status: error.status ?? null, message: error.message });
      console.log(`#${processed} ${did} -> ERROR ${error.status ?? ""} ${error.message}`);
    }

    if (processed % FLUSH_EVERY === 0) {
      await flush();
    }

    if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  await flush();
  const all = await readPosts();

  console.log("");
  console.log("Done.");
  console.log(`Processed repos:   ${processed}`);
  console.log(`Repos with posts:  ${withPosts}`);
  console.log(`Empty repos:       ${emptyRepos}`);
  console.log(`Errors:            ${errors.length}`);
  console.log(`Posts found:       ${totalFound}`);
  console.log(`Stored in file:    ${all.length} (data/posts.json)`);

  if (errors.length > 0) {
    console.log("");
    console.log("First few errors:");
    for (const e of errors.slice(0, 10)) {
      console.log(`  ${e.did}: ${e.status ?? ""} ${e.message}`);
    }
  }
}

main().catch((error) => {
  console.error("Failed:");
  console.error(error);
  process.exit(1);
});
