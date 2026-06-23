// Upload the locally scraped data/posts.json into the Netlify Blob store via the
// protected /admin/import endpoint.
//
//   ADMIN_TOKEN=secret npm run upload                 # merge into existing store
//   ADMIN_TOKEN=secret REPLACE=true npm run upload     # replace the store
//   ADMIN_TOKEN=secret SITE_URL=https://... npm run upload
//
// ADMIN_TOKEN must match the ADMIN_TOKEN environment variable set on Netlify.

import { readFile } from "node:fs/promises";

const SITE_URL = (process.env.SITE_URL ?? "https://wsocial-local-feed.netlify.app").replace(/\/$/, "");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const REPLACE = process.env.REPLACE === "true";
const INPUT = process.env.INPUT ?? "data/posts.json";

if (!ADMIN_TOKEN) {
  console.error("Set the ADMIN_TOKEN environment variable (must match Netlify).");
  process.exit(1);
}

const posts = JSON.parse(await readFile(INPUT, "utf8"));

if (!Array.isArray(posts)) {
  console.error(`${INPUT} does not contain a JSON array.`);
  process.exit(1);
}

const url = `${SITE_URL}/admin/import${REPLACE ? "?replace=true" : ""}`;

console.log(`Uploading ${posts.length} posts from ${INPUT}`);
console.log(`-> ${url} (${REPLACE ? "replace" : "merge"})`);

const response = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${ADMIN_TOKEN}`,
  },
  body: JSON.stringify(posts),
});

const body = await response.text();
console.log(`Status: ${response.status} ${response.statusText}`);
console.log(body);

if (!response.ok) {
  process.exit(1);
}
