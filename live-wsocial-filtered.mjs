import WebSocket from "ws";

const W_PDS = "https://pds.wsocial.network";
const JETSTREAM_BASE = "wss://jetstream2.us-east.bsky.network/subscribe";
const CHUNK_SIZE = 100;

async function getWsocialDids() {
  const allDids = [];
  let cursor;

  while (true) {
    const url = new URL(`${W_PDS}/xrpc/com.atproto.sync.listRepos`);
    url.searchParams.set("limit", "1000");

    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`PDS error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    for (const repo of data.repos ?? []) {
      if (repo.did && repo.active !== false) {
        allDids.push(repo.did);
      }
    }

    if (!data.cursor) break;
    cursor = data.cursor;
  }

  return allDids;
}

function chunkArray(items, size) {
  const chunks = [];

  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }

  return chunks;
}

function makeJetstreamUrl(dids) {
  const url = new URL(JETSTREAM_BASE);
  url.searchParams.append("wantedCollections", "app.bsky.feed.post");

  for (const did of dids) {
    url.searchParams.append("wantedDids", did);
  }

  return url.toString();
}

const dids = await getWsocialDids();
const chunks = chunkArray(dids, CHUNK_SIZE);

console.log(`Loaded ${dids.length} W-hosted DIDs.`);
console.log(`Split into ${chunks.length} Jetstream connections.`);
console.log("");

let totalEvents = 0;
let totalPosts = 0;
let openSockets = 0;

for (const [index, chunk] of chunks.entries()) {
  const url = makeJetstreamUrl(chunk);

  console.log(
    `Opening stream ${index + 1}/${chunks.length} with ${chunk.length} DIDs, URL length ${url.length}`
  );

  const socket = new WebSocket(url);

  socket.on("open", () => {
    openSockets++;
    console.log(`Stream ${index + 1} connected. Open sockets: ${openSockets}`);
  });

  socket.on("message", (message) => {
    const event = JSON.parse(message.toString());

    totalEvents++;

    if (event.kind !== "commit") return;
    if (!event.commit) return;
    if (event.commit.collection !== "app.bsky.feed.post") return;
    if (event.commit.operation !== "create") return;

    totalPosts++;

    const text = event.commit.record?.text ?? "";
    const createdAt = event.commit.record?.createdAt ?? "unknown";
    const uri = `at://${event.did}/app.bsky.feed.post/${event.commit.rkey}`;

    console.log("");
    console.log("────────────────────────────");
    console.log(`W post #${totalPosts}`);
    console.log(createdAt);
    console.log(uri);
    console.log(text.slice(0, 300));
  });

  socket.on("error", (error) => {
    console.error(`Stream ${index + 1} error:`, error.message);
  });

  socket.on("close", (code, reason) => {
    openSockets--;
    console.log(`Stream ${index + 1} closed: ${code} ${reason}`);
  });
}

setInterval(() => {
  console.log(
    `[heartbeat] open sockets: ${openSockets}, filtered events: ${totalEvents}, W posts: ${totalPosts}`
  );
}, 30000);
