// Publish (or update) the app.bsky.feed.generator record on YOUR ATProto account
// so the feed becomes subscribable in the app.
//
// Run locally only. Use an APP PASSWORD, never your main password, and never
// commit the credentials.
//
//   ACCOUNT_IDENTIFIER=you.handle \
//   ACCOUNT_PASSWORD=xxxx-xxxx-xxxx-xxxx \
//   ACCOUNT_PDS=https://pds.wsocial.network \
//   npm run register
//
// After this succeeds, set FEED_OWNER_DID on Netlify to the "Account DID"
// printed below, so getFeedSkeleton accepts the published feed URI.

const PDS = (process.env.ACCOUNT_PDS ?? "https://pds.wsocial.network").replace(/\/$/, "");
const IDENTIFIER = process.env.ACCOUNT_IDENTIFIER;
const PASSWORD = process.env.ACCOUNT_PASSWORD;

const SERVICE_DID = process.env.SERVICE_DID ?? "did:web:wsocial-local-feed.netlify.app";
const RKEY = process.env.FEED_RKEY ?? "wsocial-local";
const DISPLAY_NAME = process.env.FEED_DISPLAY_NAME ?? "W Social Local Feed";
const DESCRIPTION =
  process.env.FEED_DESCRIPTION ??
  "Unofficial chronological feed of public posts from accounts hosted on the W Social PDS.";

if (!IDENTIFIER || !PASSWORD) {
  console.error("Set ACCOUNT_IDENTIFIER and ACCOUNT_PASSWORD (use an app password).");
  process.exit(1);
}

async function xrpc(method, path, { token, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetch(`${PDS}/xrpc/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${response.statusText} ${text.slice(0, 300)}`);
  }

  return data;
}

const session = await xrpc("POST", "com.atproto.server.createSession", {
  body: { identifier: IDENTIFIER, password: PASSWORD },
});

console.log(`Logged in as ${session.handle}`);
console.log(`Account DID: ${session.did}`);

const record = {
  $type: "app.bsky.feed.generator",
  did: SERVICE_DID,
  displayName: DISPLAY_NAME,
  description: DESCRIPTION,
  createdAt: new Date().toISOString(),
};

const result = await xrpc("POST", "com.atproto.repo.putRecord", {
  token: session.accessJwt,
  body: {
    repo: session.did,
    collection: "app.bsky.feed.generator",
    rkey: RKEY,
    record,
  },
});

const feedUri = `at://${session.did}/app.bsky.feed.generator/${RKEY}`;

console.log("");
console.log("Feed generator record published.");
console.log(`Record URI: ${result.uri ?? feedUri}`);
console.log(`Service DID in record: ${SERVICE_DID}`);
console.log("");
console.log("Next step: on Netlify, set");
console.log(`  FEED_OWNER_DID=${session.did}`);
console.log(`  FEED_RKEY=${RKEY}`);
console.log("so /xrpc/app.bsky.feed.getFeedSkeleton accepts this feed URI.");
