import WebSocket from "ws";

const W_PDS = "https://pds.wsocial.network";
const JETSTREAM_URL =
  "wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post";

async function getWsocialDids() {
  const url = `${W_PDS}/xrpc/com.atproto.sync.listRepos?limit=1000`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`PDS error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const dids = new Set();

  for (const repo of data.repos ?? []) {
    if (repo.did && repo.active !== false) {
      dids.add(repo.did);
    }
  }

  return dids;
}

const wsocialDids = await getWsocialDids();

console.log(`Loaded ${wsocialDids.size} W-hosted DIDs.`);
console.log("Connecting to Jetstream...");

let allPosts = 0;
let wPosts = 0;

const socket = new WebSocket(JETSTREAM_URL);

socket.on("open", () => {
  console.log("Connected. Waiting for posts...");
});

socket.on("message", (message) => {
  const event = JSON.parse(message.toString());

  if (event.kind !== "commit") return;
  if (!event.commit) return;
  if (event.commit.collection !== "app.bsky.feed.post") return;
  if (event.commit.operation !== "create") return;

  allPosts++;

  if (!wsocialDids.has(event.did)) return;

  wPosts++;

  const text = event.commit.record?.text ?? "";
  const createdAt = event.commit.record?.createdAt ?? "unknown";
  const uri = `at://${event.did}/app.bsky.feed.post/${event.commit.rkey}`;

  console.log("");
  console.log("────────────────────────────");
  console.log(`W post #${wPosts}`);
  console.log(createdAt);
  console.log(uri);
  console.log(text.slice(0, 300));
});

setInterval(() => {
  console.log(`[heartbeat] all posts: ${allPosts}, W posts: ${wPosts}`);
}, 30000);
