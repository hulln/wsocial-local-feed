import { writeFile } from "node:fs/promises";

const W_PDS = "https://pds.wsocial.network";
const COLLECTION = "app.bsky.feed.post";

const DAYS_BACK = 7;
const MAX_DIDS = 20;
const RECORDS_PER_DID = 100;

async function getWsocialDids() {
  const dids = [];
  let cursor;

  while (dids.length < MAX_DIDS) {
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

      if (dids.length >= MAX_DIDS) {
        break;
      }
    }

    if (!data.cursor) {
      break;
    }

    cursor = data.cursor;
  }

  return dids;
}

async function listPostsForDid(did, cutoffDate) {
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

  console.log(`Backfilling test posts from last ${DAYS_BACK} days.`);
  console.log(`Cutoff: ${cutoffDate.toISOString()}`);
  console.log("");

  const dids = await getWsocialDids();

  console.log(`Testing ${dids.length} W-hosted DIDs.`);
  console.log("");

  const allPosts = [];

  for (const [index, did] of dids.entries()) {
    console.log(`Checking ${index + 1}/${dids.length}: ${did}`);

    const posts = await listPostsForDid(did, cutoffDate);
    allPosts.push(...posts);

    if (posts.length > 0) {
      console.log(`  found ${posts.length} recent posts`);
    }
  }

  allPosts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  await writeFile(
    "data/backfill-test.json",
    JSON.stringify(allPosts, null, 2),
    "utf8"
  );

  console.log("");
  console.log(`Saved ${allPosts.length} posts to data/backfill-test.json`);

  for (const post of allPosts.slice(0, 5)) {
    console.log("");
    console.log("────────────────────────────");
    console.log(post.createdAt);
    console.log(post.uri);
    console.log(post.text.slice(0, 300));
  }
}

main().catch((error) => {
  console.error("Failed:");
  console.error(error);
  process.exit(1);
});
