import { addPosts, readPosts } from "./lib/post-store.mjs";

const W_PDS = "https://pds.wsocial.network";
const COLLECTION = "app.bsky.feed.post";

const DAYS_BACK = Number(process.env.DAYS_BACK ?? 7);
const MAX_DIDS = Number(process.env.MAX_DIDS ?? 50);
const RECORDS_PER_DID = Number(process.env.RECORDS_PER_DID ?? 100);
const DELAY_MS = Number(process.env.DELAY_MS ?? 150);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getWsocialDids() {
  const dids = [];
  let cursor;

  while (true) {
    const url = new URL(`${W_PDS}/xrpc/com.atproto.sync.listRepos`);
    url.searchParams.set("limit", "1000");

    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`PDS listRepos error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    for (const repo of data.repos ?? []) {
      if (repo.did && repo.active !== false) {
        dids.push(repo.did);
      }

      if (MAX_DIDS > 0 && dids.length >= MAX_DIDS) {
        return dids;
      }
    }

    if (!data.cursor) {
      break;
    }

    cursor = data.cursor;
  }

  return dids;
}

async function listRecentPostsForDid(did, cutoffDate) {
  const url = new URL(`${W_PDS}/xrpc/com.atproto.repo.listRecords`);
  url.searchParams.set("repo", did);
  url.searchParams.set("collection", COLLECTION);
  url.searchParams.set("limit", String(RECORDS_PER_DID));
  url.searchParams.set("reverse", "true");

  const response = await fetch(url);

  if (!response.ok) {
    console.log(`Skipping ${did}: ${response.status} ${response.statusText}`);
    return [];
  }

  const data = await response.json();
  const posts = [];

  for (const record of data.records ?? []) {
    const value = record.value ?? {};
    const createdAt = value.createdAt;

    if (!createdAt) continue;

    const createdDate = new Date(createdAt);

    if (Number.isNaN(createdDate.getTime())) continue;
    if (createdDate < cutoffDate) continue;

    posts.push({
      uri: record.uri,
      cid: record.cid,
      did,
      createdAt,
      text: value.text ?? "",
    });
  }

  return posts;
}

async function main() {
  const cutoffDate = new Date(Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000);

  console.log(`Backfilling W Social posts from last ${DAYS_BACK} days.`);
  console.log(`Cutoff: ${cutoffDate.toISOString()}`);
  console.log(`MAX_DIDS: ${MAX_DIDS === 0 ? "all" : MAX_DIDS}`);
  console.log(`RECORDS_PER_DID: ${RECORDS_PER_DID}`);
  console.log("");

  const dids = await getWsocialDids();

  console.log(`Checking ${dids.length} W-hosted DIDs.`);
  console.log("");

  let recentPosts = [];

  for (const [index, did] of dids.entries()) {
    console.log(`Checking ${index + 1}/${dids.length}: ${did}`);

    const posts = await listRecentPostsForDid(did, cutoffDate);

    if (posts.length > 0) {
      console.log(`  found ${posts.length} recent posts`);
      recentPosts.push(...posts);
    }

    await sleep(DELAY_MS);
  }

  recentPosts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  console.log("");
  console.log(`Found ${recentPosts.length} recent posts before deduplication.`);

  const savedPosts = await addPosts(recentPosts);
  const allSavedPosts = await readPosts();

  console.log(`Saved store now contains ${savedPosts.length} posts.`);
  console.log("");

  console.log("Latest posts in store:");

  for (const post of allSavedPosts.slice(0, 5)) {
    console.log("");
    console.log("────────────────────────────");
    console.log(post.createdAt);
    console.log(post.uri);
    console.log(post.text.slice(0, 250));
  }
}

main().catch((error) => {
  console.error("Failed:");
  console.error(error);
  process.exit(1);
});
