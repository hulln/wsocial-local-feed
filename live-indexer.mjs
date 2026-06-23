import WebSocket from "ws";
import { addPosts, readPosts } from "./lib/post-store.mjs";

const W_PDS = "https://pds.wsocial.network";
const JETSTREAM_BASE = "wss://jetstream2.us-east.bsky.network/subscribe";

const CHUNK_SIZE = Number(process.env.CHUNK_SIZE ?? 100);
const RECONNECT_DELAY_MS = Number(process.env.RECONNECT_DELAY_MS ?? 10000);
const OPEN_DELAY_MS = Number(process.env.OPEN_DELAY_MS ?? 500);

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

let saveQueue = Promise.resolve();

async function savePostFromEvent(event) {
  const commit = event.commit;
  const record = commit.record ?? {};

  const createdAt = record.createdAt;
  if (!createdAt) return false;

  const post = {
    uri: `at://${event.did}/app.bsky.feed.post/${commit.rkey}`,
    cid: commit.cid ?? null,
    did: event.did,
    createdAt,
    text: record.text ?? "",
  };

  saveQueue = saveQueue.then(async () => {
    await addPosts([post]);
  });

  await saveQueue;

  console.log("");
  console.log("────────────────────────────");
  console.log("Saved live W post");
  console.log(post.createdAt);
  console.log(post.uri);
  console.log(post.text.slice(0, 300));

  return true;
}

function makeStreamManager({ index, total, chunk, stats }) {
  const label = `Stream ${index + 1}/${total}`;
  const url = makeJetstreamUrl(chunk);

  let socket = null;
  let connected = false;
  let reconnectTimer = null;
  let manuallyClosed = false;

  function connect() {
    manuallyClosed = false;

    console.log(
      `Opening ${label} with ${chunk.length} DIDs, URL length ${url.length}`
    );

    socket = new WebSocket(url);

    socket.on("open", () => {
      connected = true;
      stats.openSockets++;
      console.log(`${label} connected. Open sockets: ${stats.openSockets}`);
    });

    socket.on("message", async (message) => {
      let event;

      try {
        event = JSON.parse(message.toString());
      } catch {
        return;
      }

      stats.totalEvents++;

      if (event.kind !== "commit") return;
      if (!event.commit) return;
      if (event.commit.collection !== "app.bsky.feed.post") return;
      if (event.commit.operation !== "create") return;

      try {
        const saved = await savePostFromEvent(event);

        if (saved) {
          stats.savedPosts++;
        }
      } catch (error) {
        console.error(`${label} could not save post:`, error.message);
      }
    });

    socket.on("error", (error) => {
      console.error(`${label} error:`, error.message || error);
    });

    socket.on("close", (code, reasonBuffer) => {
      const reason = reasonBuffer?.toString?.() ?? "";

      if (connected) {
        stats.openSockets--;
      }

      connected = false;

      console.log(
        `${label} closed: ${code}${reason ? ` ${reason}` : ""}. Open sockets: ${stats.openSockets}`
      );

      if (!manuallyClosed) {
        console.log(`${label} reconnecting in ${RECONNECT_DELAY_MS} ms...`);

        reconnectTimer = setTimeout(() => {
          connect();
        }, RECONNECT_DELAY_MS);
      }
    });
  }

  function close() {
    manuallyClosed = true;

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }

    if (socket) {
      socket.close();
    }
  }

  return { connect, close };
}

async function main() {
  const existingPosts = await readPosts();

  console.log(`Store currently contains ${existingPosts.length} posts.`);
  console.log("Loading W-hosted DIDs...");

  const dids = await getWsocialDids();
  const chunks = chunkArray(dids, CHUNK_SIZE);

  console.log(`Loaded ${dids.length} W-hosted DIDs.`);
  console.log(`Split into ${chunks.length} Jetstream connections.`);
  console.log("");

  const stats = {
    totalEvents: 0,
    savedPosts: 0,
    openSockets: 0,
  };

  const managers = chunks.map((chunk, index) =>
    makeStreamManager({
      index,
      total: chunks.length,
      chunk,
      stats,
    })
  );

  for (const manager of managers) {
    manager.connect();
    await sleep(OPEN_DELAY_MS);
  }

  const heartbeat = setInterval(async () => {
    const currentPosts = await readPosts();

    console.log(
      `[heartbeat] open sockets: ${stats.openSockets}, events: ${stats.totalEvents}, saved live posts: ${stats.savedPosts}, store posts: ${currentPosts.length}`
    );
  }, 30000);

  process.on("SIGINT", () => {
    console.log("");
    console.log("Stopping live indexer...");

    clearInterval(heartbeat);

    for (const manager of managers) {
      manager.close();
    }

    setTimeout(() => {
      process.exit(0);
    }, 500);
  });
}

main().catch((error) => {
  console.error("Failed:");
  console.error(error);
  process.exit(1);
});
