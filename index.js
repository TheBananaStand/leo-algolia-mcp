#!/usr/bin/env node
//
// Algolia search indices as a Leo package, over MCP.
//
// The problem this exists for: an ERP (or any app) writes a record to its own
// database and its search index is a *separate* store that ingests on a
// schedule. Between the write and the next ingest, the record is real
// everywhere except the one place people look for it. On the Proluxe work hub
// that landed as a user creating part `PL335144-LS`, finding it fine in
// Engineering → Parts, and getting zero hits for it in the Costing BOM picker
// — which runs on the Algolia index `part_costs`. The ERP has six endpoints
// that *produce* index payloads (`GET /algolia/{parts,catalog,customers,
// contacts,vendors,products}`) and nothing anywhere that pushes one, and its
// Go helper (`shared/services/algolia.go`) is search-only. So there was no
// reindex to ask for.
//
// Five tools, and the shape of them is deliberate:
//
//   list_indices   -> every index, its record count and when it last built
//   search         -> run the query that failed, against the index that failed
//   refresh_index  -> pull a JSON feed and atomically replace the index
//   save_records   -> upsert named records, for one new part rather than 40k
//   delete_records -> remove named records
//
// **Every write waits for the index to publish before answering.** Algolia
// indexing is asynchronous: a batch returns a `taskID` immediately and the
// records are searchable some time later. A server that answered at that point
// would report "refreshed" and the very next search would still miss — the
// original bug, now with a reassuring message on top. `waitForTask` is what
// makes "refreshed" mean "go and look".
//
// Plain JavaScript against Algolia's v1 REST API with `fetch`, and no Algolia
// client dependency. Two reasons: this ships as a commit-pinned git tarball and
// npm does not reliably run build steps for a tarball URL, and the sibling Leo
// MCP packages all carry exactly one dependency (the MCP SDK) so there is no
// version to drift. `refresh_index` reimplements what the official clients call
// `replaceAllObjects` — the three-step copy/fill/move below — because that is
// the only way to replace an index without a window where it is half empty.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Leo hands an entitled setting to the subprocess under its settings key,
// verbatim and lower-case. These must match the descriptor's `settings_read`
// or the credential silently never arrives.
const APP_ID = "algolia_app_id";
const ADMIN_KEY = "algolia_admin_api_key";
const FEED_USER = "algolia_feed_auth_user";
const FEED_PASS = "algolia_feed_auth_pass";
// A feed behind OAuth2 client credentials — the Proluxe gateway is one. A
// static token would be simpler and wrong: these expire (24h on that gateway),
// and the failure arrives as a 401 on the one call somebody made because
// something was already missing from search.
const FEED_OAUTH_URL = "algolia_feed_oauth_url";
const FEED_OAUTH_ID = "algolia_feed_oauth_client_id";
const FEED_OAUTH_SECRET = "algolia_feed_oauth_client_secret";
const FEED_OAUTH_AUDIENCE = "algolia_feed_oauth_audience";

// Algolia caps a batch at 1000 objects. Larger requests are rejected whole, so
// a 40k-record feed has to arrive in chunks either way.
const BATCH = 1000;

// How long to wait for an index to publish before giving up and saying so.
// A big replace genuinely takes tens of seconds; silence is the one answer
// that must not happen.
const TASK_TIMEOUT_MS = 180_000;
const TASK_POLL_MS = 500;

function credentials() {
  const appId = (process.env[APP_ID] ?? "").trim();
  const apiKey = (process.env[ADMIN_KEY] ?? "").trim();
  const missing = [];
  if (!appId) missing.push(APP_ID);
  if (!apiKey) missing.push(ADMIN_KEY);
  if (missing.length) {
    throw new Error(
      `No ${missing.join(" and no ")} configured. Add them in Settings → ` +
        `Packages → Algolia. The admin key is the one with write access — a ` +
        `search-only key lists and searches but cannot refresh anything, and ` +
        `Algolia refuses it with "Method not allowed with this API key".`,
    );
  }
  return { appId, apiKey };
}

/**
 * One Algolia REST call.
 *
 * `-dsn` is the read host (geo-replicated, closest replica); writes must go to
 * the bare host. Sending a write to `-dsn` appears to work and lands on a
 * replica, which is a way to refresh an index nobody is searching.
 */
async function call({ appId, apiKey }, { method = "GET", path, body, write = false }) {
  const host = write ? `https://${appId}.algolia.net` : `https://${appId}-dsn.algolia.net`;
  const response = await fetch(`${host}${path}`, {
    method,
    headers: {
      "X-Algolia-Application-Id": appId,
      "X-Algolia-API-Key": apiKey,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { message: text.slice(0, 300) };
  }
  if (!response.ok) {
    // Algolia's own `message` is the useful half ("Index does not exist",
    // "Method not allowed with this API key"); the status alone sends a reader
    // looking for a network fault.
    throw new Error(
      `Algolia ${method} ${path} returned ${response.status}: ` +
        `${payload?.message ?? text.slice(0, 200)}`,
    );
  }
  return payload;
}

/** Block until `taskID` on `index` is published, or say it didn't. */
export async function waitForTask(creds, index, taskID, deps = {}) {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const ask = deps.ask ?? ((c, o) => call(c, o));
  const deadline = now() + (deps.timeoutMs ?? TASK_TIMEOUT_MS);
  for (;;) {
    const res = await ask(creds, {
      path: `/1/indexes/${encodeURIComponent(index)}/task/${taskID}`,
    });
    if (res?.status === "published") return;
    if (now() >= deadline) {
      // Not a failure of the write — the records were accepted. Saying so is
      // the point: "still indexing" and "refreshed" lead to different next
      // actions, and reporting the second for the first is the bug this whole
      // server exists to stop.
      throw new Error(
        `Records were accepted but index "${index}" had not finished publishing ` +
          `task ${taskID} after ${Math.round((deps.timeoutMs ?? TASK_TIMEOUT_MS) / 1000)}s. ` +
          `Nothing is lost — search again in a moment.`,
      );
    }
    await sleep(TASK_POLL_MS);
  }
}

/** Every record in `records` has an objectID, or we say which one doesn't. */
export function withObjectIds(records, field) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error("No records to write — the feed or `records` was empty.");
  }
  return records.map((record, i) => {
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`Record ${i} is not an object.`);
    }
    // A chosen field is copied, not moved: the original stays searchable, which
    // is what a caller naming `Id` or `part_number` means. Algolia only ever
    // reads `objectID`.
    const id = field ? record[field] : record.objectID;
    if (id === undefined || id === null || id === "") {
      throw new Error(
        `Record ${i} has no ${field ? `\`${field}\`` : "`objectID`"}. Algolia ` +
          `identifies records by objectID; without one every refresh would ` +
          `append duplicates instead of replacing. Pass \`object_id_field\` to ` +
          `name the field that carries it.`,
      );
    }
    return { ...record, objectID: String(id) };
  });
}

/** Push `records` into `index` in batches, waiting for each to publish. */
async function batchInto(creds, index, records, action) {
  let written = 0;
  for (let i = 0; i < records.length; i += BATCH) {
    const chunk = records.slice(i, i + BATCH);
    const res = await call(creds, {
      method: "POST",
      write: true,
      path: `/1/indexes/${encodeURIComponent(index)}/batch`,
      body: { requests: chunk.map((body) => ({ action, body })) },
    });
    await waitForTask(creds, index, res.taskID);
    written += chunk.length;
  }
  return written;
}

async function listIndices() {
  const creds = credentials();
  const res = await call(creds, { path: "/1/indexes" });
  const items = Array.isArray(res?.items) ? res.items : [];
  return {
    indices: items.map((i) => ({
      name: i.name,
      records: i.entries,
      updated_at: i.updatedAt,
      last_build_seconds: i.lastBuildTimeS,
      // The field that answers "is a refresh still running" without a second
      // call, which is exactly the question somebody has after asking for one.
      pending_tasks: i.numberOfPendingTasks ?? 0,
    })),
  };
}

async function search({ index, query, hits_per_page, filters }) {
  if (!index) throw new Error("search requires `index`.");
  const creds = credentials();
  const params = new URLSearchParams();
  params.set("query", query ?? "");
  params.set("hitsPerPage", String(hits_per_page ?? 10));
  if (filters) params.set("filters", filters);
  const res = await call(creds, {
    method: "POST",
    path: `/1/indexes/${encodeURIComponent(index)}/query`,
    body: { params: params.toString() },
  });
  return {
    index,
    query: query ?? "",
    total_hits: res?.nbHits ?? 0,
    exhaustive: res?.exhaustiveNbHits !== false,
    hits: Array.isArray(res?.hits) ? res.hits : [],
  };
}

// One token, reused until it expires. Minting per call would be a second
// round trip on every refresh and, on a gateway that rate-limits token
// issuance, the thing that breaks under a burst.
let tokenCache = null;

/**
 * An OAuth2 client-credentials access token for the feed, or `null` if no
 * OAuth is configured.
 *
 * The 60s margin is not politeness: a token that expires between being read
 * here and arriving at the gateway produces a 401 on a refresh that was
 * otherwise correct, and the next attempt succeeds — an intermittent failure
 * with no pattern anybody can see.
 */
export async function feedToken(deps = {}) {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => Date.now());
  const url = (env[FEED_OAUTH_URL] ?? "").trim();
  const id = (env[FEED_OAUTH_ID] ?? "").trim();
  const secret = (env[FEED_OAUTH_SECRET] ?? "").trim();
  if (!url || !id || !secret) return null;
  if (tokenCache && tokenCache.expires > now()) return tokenCache.token;

  const body = {
    client_id: id,
    client_secret: secret,
    grant_type: "client_credentials",
  };
  // Omitting the audience is the quiet one. Auth0 answers 200 with a real but
  // *opaque* token, which the gateway then declines — and that reads exactly
  // like a wrong secret.
  const audience = (env[FEED_OAUTH_AUDIENCE] ?? "").trim();
  if (audience) body.audience = audience;

  const response = await (deps.fetch ?? fetch)(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }
  if (!response.ok || !payload.access_token) {
    throw new Error(
      `Could not get a feed access token from ${url} (${response.status}). ` +
        `Check ${FEED_OAUTH_ID} and ${FEED_OAUTH_SECRET}` +
        (audience ? "." : `, and whether ${FEED_OAUTH_AUDIENCE} is required.`),
    );
  }
  // An unreported lifetime falls back to an hour rather than to forever: a
  // cached-forever token works until it doesn't and then never recovers.
  const ttl = Number(payload.expires_in) > 0 ? Number(payload.expires_in) : 3600;
  tokenCache = { token: payload.access_token, expires: now() + Math.max(ttl - 60, 0) * 1000 };
  return tokenCache.token;
}

/** Fetch a JSON array of records from `url`, with whatever auth is configured. */
async function fetchFeed(url, auth) {
  const headers = { Accept: "application/json" };
  const user = (process.env[FEED_USER] ?? "").trim();
  const pass = (process.env[FEED_PASS] ?? "").trim();
  if (auth !== false) {
    // OAuth wins when both are configured — a gateway that issues tokens is
    // not also going to accept the basic-auth pair, and sending the weaker one
    // would make the refusal look like a credential problem rather than a
    // configuration one.
    const token = await feedToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    else if (user && pass) {
      headers.Authorization = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
    }
  }
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Feed ${url} returned ${response.status}. ` +
        (response.status === 401 || response.status === 403
          ? `It needs credentials this package does not have — set ` +
            `${FEED_OAUTH_URL}/${FEED_OAUTH_ID}/${FEED_OAUTH_SECRET} for an OAuth ` +
            `gateway, or ${FEED_USER} and ${FEED_PASS} for basic auth.`
          : detail.slice(0, 200)),
    );
  }
  const payload = await response.json();
  // A feed that wraps its array ({"records": [...]}) is common enough to accept,
  // and the alternative is an unhelpful "not an array" for a feed that is fine.
  const records = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.records)
      ? payload.records
      : Array.isArray(payload?.items)
        ? payload.items
        : null;
  if (!records) {
    throw new Error(
      `Feed ${url} did not return a JSON array of records (or an object with ` +
        `\`records\`/\`items\`). Got ${typeof payload}.`,
    );
  }
  return records;
}

/**
 * Replace an index's contents with a feed's, atomically.
 *
 * The three steps are what the official clients' `replaceAllObjects` does, and
 * each one is load-bearing:
 *
 * 1. **Copy settings, synonyms and rules** to a temporary index. Skipping this
 *    is the subtle way to break search: the records arrive intact and the
 *    index comes back with default searchable attributes and no custom
 *    ranking, so every query returns the wrong things in the wrong order and
 *    nothing looks broken.
 * 2. **Fill the temporary index**, waiting for each batch.
 * 3. **Move it over the real one.** A move is atomic — there is never a moment
 *    where the index people are searching is half full. Clearing the live
 *    index and refilling it is the obvious alternative and gives every search
 *    during the refill zero results.
 *
 * `dry_run` stops after the feed, which is the only way to answer "is the feed
 * the problem or the index?" without writing anything.
 */
async function refreshIndex({ index, feed_url, object_id_field, dry_run, feed_auth }) {
  if (!index) throw new Error("refresh_index requires `index`.");
  if (!feed_url) throw new Error("refresh_index requires `feed_url`.");
  const creds = credentials();

  const raw = await fetchFeed(feed_url, feed_auth);
  const records = withObjectIds(raw, object_id_field);

  // Read the count first so the answer can say what changed rather than just
  // what it wrote — "4,312 → 4,313" is the sentence somebody wanted.
  let before = null;
  try {
    const existing = await call(creds, {
      path: `/1/indexes/${encodeURIComponent(index)}`,
    });
    before = existing?.entries ?? null;
  } catch {
    // A brand-new index has no settings object yet, which is not an error
    // here: the move at step 3 creates it.
    before = null;
  }

  if (dry_run) {
    return {
      index,
      dry_run: true,
      records_in_feed: records.length,
      records_in_index: before,
      sample: records.slice(0, 3),
      note: "Nothing was written. Drop `dry_run` to replace the index.",
    };
  }

  const tmp = `${index}_leo_tmp_${Date.now()}`;
  const copy = await call(creds, {
    method: "POST",
    write: true,
    path: `/1/indexes/${encodeURIComponent(index)}/operation`,
    body: { operation: "copy", destination: tmp, scope: ["settings", "synonyms", "rules"] },
  });
  // The task belongs to the index the operation was issued against, not the
  // destination — polling the destination answers "unknown task" forever.
  await waitForTask(creds, index, copy.taskID);

  const written = await batchInto(creds, tmp, records, "updateObject");

  const move = await call(creds, {
    method: "POST",
    write: true,
    path: `/1/indexes/${encodeURIComponent(tmp)}/operation`,
    body: { operation: "move", destination: index },
  });
  await waitForTask(creds, tmp, move.taskID);

  return {
    index,
    feed_url,
    records_written: written,
    records_before: before,
    searchable: true,
    note:
      "The index was replaced atomically and has finished publishing — a search " +
      "now will find these records.",
  };
}

async function saveRecords({ index, records, object_id_field }) {
  if (!index) throw new Error("save_records requires `index`.");
  const creds = credentials();
  const prepared = withObjectIds(records, object_id_field);
  const written = await batchInto(creds, index, prepared, "updateObject");
  return {
    index,
    records_written: written,
    object_ids: prepared.map((r) => r.objectID),
    searchable: true,
    note:
      "Upserted and published. This adds and replaces records; it does not " +
      "remove anything the index holds and the feed no longer does — use " +
      "refresh_index for that.",
  };
}

async function deleteRecords({ index, object_ids }) {
  if (!index) throw new Error("delete_records requires `index`.");
  const ids = Array.isArray(object_ids) ? object_ids.filter((s) => `${s}`.trim()) : [];
  if (!ids.length) throw new Error("delete_records requires a non-empty `object_ids`.");
  const creds = credentials();
  const written = await batchInto(
    creds,
    index,
    ids.map((objectID) => ({ objectID: String(objectID) })),
    "deleteObject",
  );
  return { index, records_deleted: written, object_ids: ids.map(String) };
}

const TOOLS = {
  list_indices: {
    run: listIndices,
    description:
      "Every Algolia index on this application, with its record count, when it " +
      "last built and how many tasks are still pending. The first call to make " +
      "when a record exists in the source system but search cannot find it: a " +
      "stale `updated_at` says the index never ingested it.",
    inputSchema: { type: "object", properties: {} },
  },
  search: {
    run: search,
    description:
      "Search one index. Use it to reproduce the query that failed and, after a " +
      "refresh, to prove the record is findable rather than assume it.",
    inputSchema: {
      type: "object",
      properties: {
        index: { type: "string", description: "Index name, e.g. part_costs." },
        query: { type: "string", description: "Search text. Empty returns the first page." },
        hits_per_page: { type: "number", description: "Default 10." },
        filters: { type: "string", description: "Algolia filter expression." },
      },
      required: ["index"],
    },
  },
  refresh_index: {
    run: refreshIndex,
    description:
      "Replace an index's entire contents from a JSON feed, atomically, and wait " +
      "until it has published. This is the fix for an index that ingests on a " +
      "schedule and has not caught up — on the Proluxe ERP, index `part_costs` " +
      "from feed https://api.proluxe.com/algolia/parts (and catalog, customers, " +
      "contacts, vendors, products from the matching /algolia/* paths). Settings, " +
      "synonyms and ranking rules are carried over, and search never sees a " +
      "half-filled index. Pass `dry_run` to count the feed without writing — the " +
      "way to tell a bad feed from a stale index.",
    inputSchema: {
      type: "object",
      properties: {
        index: { type: "string", description: "Index to replace." },
        feed_url: {
          type: "string",
          description: "URL returning a JSON array of records (or {records:[…]}).",
        },
        object_id_field: {
          type: "string",
          description:
            "Field carrying the record id, if the feed does not already name it " +
            "`objectID`. Copied, not moved.",
        },
        feed_auth: {
          type: "boolean",
          description:
            "Send the configured feed basic-auth credentials. Default true when " +
            "they are set; pass false for a public feed.",
        },
        dry_run: { type: "boolean", description: "Fetch and count only; write nothing." },
      },
      required: ["index", "feed_url"],
    },
  },
  save_records: {
    run: saveRecords,
    description:
      "Upsert specific records into an index and wait until they publish. The " +
      "narrow path for one newly created record — far cheaper than replacing a " +
      "whole index, and the right call right after something is added by API.",
    inputSchema: {
      type: "object",
      properties: {
        index: { type: "string" },
        records: {
          type: "array",
          items: { type: "object" },
          description: "Records to upsert. Each needs an objectID.",
        },
        object_id_field: { type: "string" },
      },
      required: ["index", "records"],
    },
  },
  delete_records: {
    run: deleteRecords,
    description: "Remove records from an index by objectID, and wait until it publishes.",
    inputSchema: {
      type: "object",
      properties: {
        index: { type: "string" },
        object_ids: { type: "array", items: { type: "string" } },
      },
      required: ["index", "object_ids"],
    },
  },
};

const server = new Server(
  { name: "leo-algolia-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Object.entries(TOOLS).map(([name, t]) => ({
    name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = TOOLS[name];
  if (!tool) {
    return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
  }
  try {
    return {
      content: [{ type: "text", text: JSON.stringify(await tool.run(args ?? {}), null, 2) }],
    };
  } catch (error) {
    // `isError` is what lets the hub tell "nothing matched" from "the call never
    // ran" — a zero-hit result for the second reads as the first, which is the
    // exact confusion that sent somebody looking for a missing part record.
    return {
      isError: true,
      content: [{ type: "text", text: String(error?.message ?? error) }],
    };
  }
});

/** Test seam — the token cache is module state and a suite must be able to clear it. */
export function __resetTokenCache() {
  tokenCache = null;
}

export { TOOLS, credentials, fetchFeed };

if (process.env.LEO_MCP_NO_SERVE !== "1") {
  await server.connect(new StdioServerTransport());
}
