const W_PDS = "https://pds.wsocial.network";

async function main() {
  const url = `${W_PDS}/xrpc/com.atproto.sync.listRepos?limit=5`;

  console.log(`Checking: ${url}`);

  const response = await fetch(url);

  console.log(`Status: ${response.status} ${response.statusText}`);

  if (!response.ok) {
    const text = await response.text();
    console.log(text);
    process.exit(1);
  }

  const data = await response.json();

  console.log("");
  console.log(`Repos returned: ${data.repos?.length ?? 0}`);
  console.log(`Has cursor: ${data.cursor ? "yes" : "no"}`);
  console.log("");

  for (const repo of data.repos ?? []) {
    console.log(`DID: ${repo.did}`);
    console.log(`Active: ${repo.active}`);
    console.log(`Rev: ${repo.rev}`);
    console.log("---");
  }
}

main().catch((error) => {
  console.error("Failed:");
  console.error(error);
  process.exit(1);
});
