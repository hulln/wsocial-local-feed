// Descriptive, side-by-side analysis of one or more *-posts.jsonl archives.
//
// Streams each file line-by-line (so it handles multi-GB / multi-million-post
// archives without loading them into memory) and prints a comparison report:
// post/author counts, date range, monthly timeline, language mix, reply rate,
// embed/media types, link/mention/hashtag rates, post length, top hashtags.
//
//   node analyze.mjs data/archive/wsocial-posts.jsonl data/archive/eurosky-posts.jsonl
//   node analyze.mjs                 # auto-discovers *-posts.jsonl in data/archive
//   DEDUP=false node analyze.mjs ... # skip uri de-duplication (less memory)
//   node analyze.mjs --json out.json # also write the raw numbers as JSON
//
// De-duplication by uri is ON by default (a stop/resume can re-append a repo).

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DEDUP = process.env.DEDUP !== "false";
const OUT_DIR = process.env.OUT_DIR ?? "data/archive";
const TOP_N = Number(process.env.TOP_N ?? 15);

const EMBED_LABELS = {
  "app.bsky.embed.images": "images",
  "app.bsky.embed.video": "video",
  "app.bsky.embed.external": "external link",
  "app.bsky.embed.record": "quote",
  "app.bsky.embed.recordWithMedia": "quote+media",
};

function newStats(network, file) {
  return {
    network,
    file,
    totalLines: 0,
    parseErrors: 0,
    duplicates: 0,
    posts: 0,
    authors: new Set(),
    uris: DEDUP ? new Set() : null,
    minDate: null,
    maxDate: null,
    byMonth: new Map(),
    langs: new Map(),
    noLang: 0,
    replies: 0,
    embeds: new Map(),
    noEmbed: 0,
    withLink: 0,
    withMention: 0,
    withHashtag: 0,
    hashtags: new Map(),
    textChars: 0,
    textWords: 0,
  };
}

function bump(map, key, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}

async function analyzeFile(file) {
  const base = path.basename(file).replace(/-posts\.jsonl$/, "").replace(/\.jsonl$/, "");
  const s = newStats(base, file);

  const rl = createInterface({
    input: createReadStream(file, "utf8"),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    s.totalLines += 1;

    let p;
    try {
      p = JSON.parse(line);
    } catch {
      s.parseErrors += 1;
      continue;
    }

    if (DEDUP && p.uri) {
      if (s.uris.has(p.uri)) {
        s.duplicates += 1;
        continue;
      }
      s.uris.add(p.uri);
    }

    s.posts += 1;
    if (p.did) s.authors.add(p.did);

    // dates / timeline
    if (p.createdAt) {
      const d = new Date(p.createdAt);
      if (!Number.isNaN(d.getTime())) {
        if (!s.minDate || d < s.minDate) s.minDate = d;
        if (!s.maxDate || d > s.maxDate) s.maxDate = d;
        bump(s.byMonth, p.createdAt.slice(0, 7)); // YYYY-MM
      }
    }

    // languages
    if (Array.isArray(p.langs) && p.langs.length > 0) {
      for (const l of p.langs) bump(s.langs, String(l).toLowerCase());
    } else {
      s.noLang += 1;
    }

    // replies
    if (p.reply) s.replies += 1;

    // embeds / media
    if (p.embedType) {
      bump(s.embeds, EMBED_LABELS[p.embedType] ?? p.embedType);
    } else {
      s.noEmbed += 1;
    }

    // facets: links, mentions, hashtags
    let hasLink = false;
    let hasMention = false;
    let hasTag = false;
    if (Array.isArray(p.facets)) {
      for (const facet of p.facets) {
        for (const feature of facet.features ?? []) {
          const t = feature.$type;
          if (t === "app.bsky.richtext.facet#link") hasLink = true;
          else if (t === "app.bsky.richtext.facet#mention") hasMention = true;
          else if (t === "app.bsky.richtext.facet#tag") {
            hasTag = true;
            if (feature.tag) bump(s.hashtags, String(feature.tag).toLowerCase());
          }
        }
      }
    }
    if (Array.isArray(p.tags)) {
      for (const t of p.tags) {
        hasTag = true;
        bump(s.hashtags, String(t).toLowerCase());
      }
    }
    if (hasLink) s.withLink += 1;
    if (hasMention) s.withMention += 1;
    if (hasTag) s.withHashtag += 1;

    // text length
    const text = typeof p.text === "string" ? p.text : "";
    s.textChars += text.length;
    if (text.trim()) s.textWords += text.trim().split(/\s+/).length;
  }

  // free the big sets after summarizing
  s.authorCount = s.authors.size;
  s.authors = null;
  s.uris = null;
  return s;
}

// ---- reporting --------------------------------------------------------------

function pct(n, total) {
  if (!total) return "0.0%";
  return `${((100 * n) / total).toFixed(1)}%`;
}

function topEntries(map, n = TOP_N) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function pad(str, width) {
  str = String(str);
  return str.length >= width ? str : str + " ".repeat(width - str.length);
}

function row(label, values, width = 26) {
  return pad(label, 26) + values.map((v) => pad(v, width)).join("");
}

function report(allStats) {
  const names = allStats.map((s) => s.network);
  const W = 26;

  const line = (label, fn) => row(label, allStats.map(fn), W);

  console.log("");
  console.log("=".repeat(26 + W * allStats.length));
  console.log(row("METRIC", names, W));
  console.log("=".repeat(26 + W * allStats.length));

  console.log(line("Posts (deduped)", (s) => s.posts.toLocaleString()));
  console.log(line("Unique authors", (s) => s.authorCount.toLocaleString()));
  console.log(line("Posts / author", (s) => (s.authorCount ? (s.posts / s.authorCount).toFixed(1) : "0")));
  console.log(line("Duplicate lines", (s) => s.duplicates.toLocaleString()));
  console.log(line("Parse errors", (s) => s.parseErrors.toLocaleString()));
  console.log(line("Earliest post", (s) => (s.minDate ? s.minDate.toISOString().slice(0, 10) : "-")));
  console.log(line("Latest post", (s) => (s.maxDate ? s.maxDate.toISOString().slice(0, 10) : "-")));
  console.log(line("Avg chars / post", (s) => (s.posts ? (s.textChars / s.posts).toFixed(0) : "0")));
  console.log(line("Avg words / post", (s) => (s.posts ? (s.textWords / s.posts).toFixed(1) : "0")));
  console.log("-".repeat(26 + W * allStats.length));
  console.log(line("Replies", (s) => `${s.replies.toLocaleString()} (${pct(s.replies, s.posts)})`));
  console.log(line("With media/embed", (s) => `${(s.posts - s.noEmbed).toLocaleString()} (${pct(s.posts - s.noEmbed, s.posts)})`));
  console.log(line("With link", (s) => `${s.withLink.toLocaleString()} (${pct(s.withLink, s.posts)})`));
  console.log(line("With @mention", (s) => `${s.withMention.toLocaleString()} (${pct(s.withMention, s.posts)})`));
  console.log(line("With hashtag", (s) => `${s.withHashtag.toLocaleString()} (${pct(s.withHashtag, s.posts)})`));
  console.log("=".repeat(26 + W * allStats.length));

  // Per-network detail blocks
  for (const s of allStats) {
    console.log("");
    console.log(`### ${s.network}  (${s.file})`);

    console.log(`  Top languages:`);
    const totalLang = [...s.langs.values()].reduce((a, b) => a + b, 0) + s.noLang;
    for (const [lang, n] of topEntries(s.langs, 10)) {
      console.log(`    ${pad(lang, 8)} ${pad(n.toLocaleString(), 12)} ${pct(n, totalLang)}`);
    }
    if (s.noLang) console.log(`    ${pad("(none)", 8)} ${pad(s.noLang.toLocaleString(), 12)} ${pct(s.noLang, totalLang)}`);

    console.log(`  Embed types:`);
    for (const [type, n] of topEntries(s.embeds, 8)) {
      console.log(`    ${pad(type, 14)} ${pad(n.toLocaleString(), 12)} ${pct(n, s.posts)}`);
    }

    console.log(`  Top hashtags:`);
    const tags = topEntries(s.hashtags, TOP_N);
    if (tags.length === 0) console.log("    (none)");
    for (const [tag, n] of tags) {
      console.log(`    #${pad(tag, 24)} ${n.toLocaleString()}`);
    }
  }
  console.log("");
}

function toJSON(allStats) {
  return allStats.map((s) => ({
    network: s.network,
    file: s.file,
    posts: s.posts,
    uniqueAuthors: s.authorCount,
    duplicates: s.duplicates,
    parseErrors: s.parseErrors,
    earliest: s.minDate?.toISOString() ?? null,
    latest: s.maxDate?.toISOString() ?? null,
    avgCharsPerPost: s.posts ? s.textChars / s.posts : 0,
    avgWordsPerPost: s.posts ? s.textWords / s.posts : 0,
    replies: s.replies,
    withEmbed: s.posts - s.noEmbed,
    withLink: s.withLink,
    withMention: s.withMention,
    withHashtag: s.withHashtag,
    byMonth: Object.fromEntries([...s.byMonth.entries()].sort()),
    languages: Object.fromEntries(topEntries(s.langs, 30)),
    embeds: Object.fromEntries([...s.embeds.entries()]),
    topHashtags: Object.fromEntries(topEntries(s.hashtags, 50)),
  }));
}

async function main() {
  const args = process.argv.slice(2);
  let jsonOut = null;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json") jsonOut = args[++i] ?? "analysis.json";
    else files.push(args[i]);
  }

  if (files.length === 0) {
    const entries = await readdir(OUT_DIR).catch(() => []);
    for (const f of entries.sort()) {
      if (f.endsWith("-posts.jsonl")) files.push(path.join(OUT_DIR, f));
    }
  }

  if (files.length === 0) {
    console.error(`No *-posts.jsonl files given or found in ${OUT_DIR}.`);
    process.exit(1);
  }

  console.log(`Analyzing ${files.length} archive(s)${DEDUP ? " (de-duplicating by uri)" : ""}:`);
  for (const f of files) console.log(`  - ${f}`);

  const allStats = [];
  for (const file of files) {
    process.stdout.write(`\nReading ${file} ...`);
    const s = await analyzeFile(file);
    process.stdout.write(` ${s.posts.toLocaleString()} posts.\n`);
    allStats.push(s);
  }

  report(allStats);

  if (jsonOut) {
    await writeFile(jsonOut, JSON.stringify(toJSON(allStats), null, 2), "utf8");
    console.log(`Wrote machine-readable summary to ${jsonOut}`);
  }
}

main().catch((error) => {
  console.error("Failed:");
  console.error(error);
  process.exit(1);
});
