#!/usr/bin/env node
//
// What fails quietly, with an injected `fetch` and no network.
//
// The happy path here is not worth a test: a batch that reaches Algolia and
// comes back 200 is visible the moment anybody tries it. What is covered is
// every way this server can report success and be wrong — which is the whole
// class of bug it was written to end.

import assert from "node:assert/strict";
process.env.LEO_MCP_NO_SERVE = "1";

const mod = await import("./index.js");
const { TOOLS, credentials, fetchFeed, waitForTask, withObjectIds, feedToken, __resetTokenCache } = mod;

let failures = 0;
const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    results.push(`  FAIL ${name}\n       ${error?.message ?? error}`);
  }
}

const KEYS = {
  algolia_app_id: "APPID",
  algolia_admin_api_key: "adminkey",
};
function withEnv(env, fn) {
  const saved = {};
  const all = { ...KEYS, ...env };
  for (const [k, v] of Object.entries(all)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return (async () => {
    try {
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  })();
}

/** Record every request, answer from a scripted list of handlers. */
function stubFetch(handlers) {
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    seen.push({ url: u, method: init.method ?? "GET", headers: init.headers ?? {},
                body: init.body ? JSON.parse(init.body) : undefined });
    for (const h of handlers) {
      if (u.includes(h.match) && (!h.method || (init.method ?? "GET") === h.method)) {
        if (h.once && h.used) continue;
        h.used = true;
        return new Response(JSON.stringify(h.body ?? {}), {
          status: h.status ?? 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    throw new Error(`stub has no handler for ${init.method ?? "GET"} ${u}`);
  };
  return { seen, restore: () => { globalThis.fetch = real; } };
}

// ── Credentials ────────────────────────────────────────────────────────────
//
// A missing key must be named. Without this the first symptom is a 403 from
// Algolia, which reads as "the key is wrong" rather than "there is no key" —
// and sends somebody to rotate a credential that was never set.

await test("a missing app id and admin key are both named", () =>
  withEnv({ algolia_app_id: undefined, algolia_admin_api_key: undefined }, async () => {
    assert.throws(credentials, (e) => {
      assert.match(e.message, /algolia_app_id/);
      assert.match(e.message, /algolia_admin_api_key/);
      return true;
    });
  }));

await test("the refusal says a search-only key will not do", () =>
  withEnv({ algolia_admin_api_key: undefined }, async () => {
    assert.throws(credentials, /search-only key/);
  }));

// ── objectID ───────────────────────────────────────────────────────────────
//
// The quietest failure in the whole file. Algolia identifies a record by
// `objectID` and *generates one* for a record that arrives without it — so a
// feed missing the field doesn't error, it appends the entire feed as new
// records on every refresh. The index doubles, the old copies stay searchable,
// and the duplicates rank against each other.

await test("a record with no objectID is refused, by position", () => {
  assert.throws(() => withObjectIds([{ objectID: "a" }, { Name: "b" }]), (e) => {
    assert.match(e.message, /Record 1 has no `objectID`/);
    assert.match(e.message, /duplicates/);
    return true;
  });
});

await test("object_id_field copies rather than moves", () => {
  const out = withObjectIds([{ Id: "x1", Name: "SHIELD" }], "Id");
  assert.equal(out[0].objectID, "x1");
  // The original field has to survive: a caller naming `Id` means "that is
  // also the id", not "take it away" — and a feed whose searchable attributes
  // include it would silently stop matching on it.
  assert.equal(out[0].Id, "x1");
  assert.equal(out[0].Name, "SHIELD");
});

await test("a numeric id becomes a string", () => {
  // Algolia's objectID is a string; a number round-trips as one anyway, and
  // comparing the two forms is how a de-duplicating caller misses a match.
  assert.equal(withObjectIds([{ objectID: 1234 }])[0].objectID, "1234");
});

await test("an empty feed is refused rather than silently emptying an index", () => {
  // Without this, a feed that answers `[]` — an upstream outage, a bad filter —
  // replaces the index with nothing and search goes dark across the whole app.
  assert.throws(() => withObjectIds([]), /empty/);
  assert.throws(() => withObjectIds(null), /empty/);
});

await test("a non-object record is refused", () => {
  assert.throws(() => withObjectIds(["PL335144"]), /Record 0 is not an object/);
});

// ── Waiting for the index ──────────────────────────────────────────────────
//
// The reason this server exists at all. A write returns a taskID and the
// records are searchable later; answering at the taskID means reporting
// "refreshed" while the next search still misses.

await test("waitForTask polls until published", async () => {
  let asked = 0;
  await waitForTask({ appId: "A", apiKey: "k" }, "part_costs", 7, {
    ask: async () => ({ status: asked++ < 2 ? "notPublished" : "published" }),
    sleep: async () => {},
    now: () => 0,
  });
  assert.equal(asked, 3, "should have kept asking until the status changed");
});

await test("a timeout says the records were accepted", async () => {
  let clock = 0;
  await assert.rejects(
    waitForTask({ appId: "A", apiKey: "k" }, "part_costs", 7, {
      ask: async () => ({ status: "notPublished" }),
      sleep: async () => { clock += 1000; },
      now: () => clock,
      timeoutMs: 3000,
    }),
    (e) => {
      // "It failed" would send somebody to re-run a write that already landed.
      assert.match(e.message, /accepted/);
      assert.match(e.message, /Nothing is lost/);
      return true;
    },
  );
});

// ── The feed ───────────────────────────────────────────────────────────────

await test("a feed may be a bare array, or wrapped", async () => {
  for (const [payload, label] of [
    [[{ objectID: "1" }], "bare array"],
    [{ records: [{ objectID: "1" }] }, "records"],
    [{ items: [{ objectID: "1" }] }, "items"],
  ]) {
    const stub = stubFetch([{ match: "feed", body: payload }]);
    try {
      assert.equal((await fetchFeed("https://x/feed", false)).length, 1, label);
    } finally {
      stub.restore();
    }
  }
});

await test("a 401 from the feed names the credentials, not the status", () =>
  withEnv({}, async () => {
    const stub = stubFetch([{ match: "feed", status: 401 }]);
    try {
      await assert.rejects(fetchFeed("https://x/feed", false), (e) => {
        assert.match(e.message, /algolia_feed_auth_user/);
        return true;
      });
    } finally {
      stub.restore();
    }
  }));

await test("feed basic auth is sent when configured, and suppressed on request", () =>
  withEnv({ algolia_feed_auth_user: "u", algolia_feed_auth_pass: "p" }, async () => {
    let stub = stubFetch([{ match: "feed", body: [{ objectID: "1" }] }]);
    try {
      await fetchFeed("https://x/feed");
      assert.equal(stub.seen[0].headers.Authorization,
                   "Basic " + Buffer.from("u:p").toString("base64"));
    } finally {
      stub.restore();
    }
    stub = stubFetch([{ match: "feed", body: [{ objectID: "1" }] }]);
    try {
      await fetchFeed("https://x/feed", false);
      assert.equal(stub.seen[0].headers.Authorization, undefined,
                   "feed_auth:false must not send the credentials");
    } finally {
      stub.restore();
    }
  }));

await test("a feed that is not a list of records says so", async () => {
  const stub = stubFetch([{ match: "feed", body: { error: "nope" } }]);
  try {
    await assert.rejects(fetchFeed("https://x/feed", false), /did not return a JSON array/);
  } finally {
    stub.restore();
  }
});

// ── Feed OAuth ─────────────────────────────────────────────────────────────
//
// The Proluxe gateway issues client-credentials tokens and refuses basic auth,
// so this is the path the one real install actually takes.

const OAUTH_ENV = {
  algolia_feed_oauth_url: "https://x.auth0.com/oauth/token",
  algolia_feed_oauth_client_id: "cid",
  algolia_feed_oauth_client_secret: "csec",
  algolia_feed_oauth_audience: "https://portal.example.com",
};

await test("no OAuth configured is null, not an error", async () => {
  __resetTokenCache();
  assert.equal(await feedToken({ env: {} }), null);
});

await test("the audience is sent when configured", async () => {
  __resetTokenCache();
  let sentBody;
  const token = await feedToken({
    env: OAUTH_ENV,
    now: () => 0,
    fetch: async (_u, init) => {
      sentBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 86400 }), { status: 200 });
    },
  });
  assert.equal(token, "tok");
  assert.equal(sentBody.grant_type, "client_credentials");
  // Omit it and Auth0 answers 200 with a real but *opaque* token, which the
  // gateway then declines — and that reads exactly like a wrong secret.
  assert.equal(sentBody.audience, "https://portal.example.com");
});

await test("the token is cached until just before it expires", async () => {
  __resetTokenCache();
  let minted = 0;
  let clock = 0;
  const deps = () => ({
    env: OAUTH_ENV,
    now: () => clock,
    fetch: async () => {
      minted += 1;
      return new Response(JSON.stringify({ access_token: `t${minted}`, expires_in: 3600 }), { status: 200 });
    },
  });
  assert.equal(await feedToken(deps()), "t1");
  clock = 3_000_000; // still inside the hour
  assert.equal(await feedToken(deps()), "t1", "a live token must be reused");
  assert.equal(minted, 1);
  // The 60s margin: a token that expires between being read and arriving at
  // the gateway is a 401 on an otherwise correct refresh, and the retry works
  // — an intermittent failure with no pattern anybody can see.
  clock = 3_541_000; // 3600 - 60 + 1s
  assert.equal(await feedToken(deps()), "t2");
});

await test("an unreported lifetime falls back to an hour, not to forever", async () => {
  __resetTokenCache();
  let minted = 0;
  let clock = 0;
  const deps = () => ({
    env: OAUTH_ENV,
    now: () => clock,
    fetch: async () => {
      minted += 1;
      return new Response(JSON.stringify({ access_token: `t${minted}` }), { status: 200 });
    },
  });
  await feedToken(deps());
  clock = 3_541_000;
  await feedToken(deps());
  // Cached forever works until it doesn't, and then never recovers.
  assert.equal(minted, 2);
});

await test("a 200 with no access_token raises rather than returning nothing", async () => {
  __resetTokenCache();
  await assert.rejects(
    feedToken({
      env: OAUTH_ENV,
      now: () => 0,
      fetch: async () => new Response(JSON.stringify({ scope: "read" }), { status: 200 }),
    }),
    /Could not get a feed access token/,
  );
});

await test("OAuth wins over basic auth when both are set", () =>
  withEnv({ ...OAUTH_ENV, algolia_feed_auth_user: "u", algolia_feed_auth_pass: "p" }, async () => {
    __resetTokenCache();
    const stub = stubFetch([
      { match: "oauth/token", body: { access_token: "tok", expires_in: 3600 } },
      { match: "/feed", body: [{ objectID: "1" }] },
    ]);
    try {
      await fetchFeed("https://x/feed");
      const feedReq = stub.seen.find((r) => r.url.includes("/feed"));
      // A gateway that issues tokens is not also going to accept the basic
      // pair, and sending the weaker one makes the refusal look like a bad
      // credential rather than a misconfiguration.
      assert.equal(feedReq.headers.Authorization, "Bearer tok");
    } finally {
      stub.restore();
      __resetTokenCache();
    }
  }));

await test("feed_auth:false sends no token either", () =>
  withEnv(OAUTH_ENV, async () => {
    __resetTokenCache();
    const stub = stubFetch([{ match: "/feed", body: [{ objectID: "1" }] }]);
    try {
      await fetchFeed("https://x/feed", false);
      assert.equal(stub.seen[0].headers.Authorization, undefined);
      assert.equal(stub.seen.filter((r) => r.url.includes("oauth")).length, 0,
                   "no token should even be minted");
    } finally {
      stub.restore();
      __resetTokenCache();
    }
  }));

// ── refresh_index ──────────────────────────────────────────────────────────

const refreshHandlers = () => [
  { match: "/feed", body: [{ objectID: "a", Name: "SHIELD" }, { objectID: "b", Name: "COVER" }] },
  { match: "/1/indexes/part_costs/operation", method: "POST", body: { taskID: 1 } },
  { match: "/1/indexes/part_costs/task/", body: { status: "published" } },
  { match: "/task/", body: { status: "published" } },
  { match: "/batch", method: "POST", body: { taskID: 2 } },
  { match: "/operation", method: "POST", body: { taskID: 3 } },
  { match: "/1/indexes/part_costs", body: { entries: 4312 } },
];

await test("refresh is copy settings → fill a temp index → move it over", () =>
  withEnv({}, async () => {
    const stub = stubFetch(refreshHandlers());
    try {
      const out = await TOOLS.refresh_index.run({
        index: "part_costs",
        feed_url: "https://api.example.com/feed",
        feed_auth: false,
      });
      const ops = stub.seen.filter((r) => r.url.includes("/operation"));
      assert.equal(ops.length, 2, "exactly one copy and one move");
      assert.equal(ops[0].body.operation, "copy");
      // Skipping the scope is the subtle break: records arrive intact and the
      // index comes back with default searchable attributes and no custom
      // ranking, so every query answers the wrong things in the wrong order
      // and nothing anywhere looks broken.
      assert.deepEqual(ops[0].body.scope, ["settings", "synonyms", "rules"]);
      assert.match(ops[0].body.destination, /^part_costs_leo_tmp_/);
      assert.equal(ops[1].body.operation, "move");
      assert.equal(ops[1].body.destination, "part_costs");

      // Records go to the temp index, never to the live one — a batch aimed at
      // the live index is a half-filled index for everyone searching it.
      const batches = stub.seen.filter((r) => r.url.includes("/batch"));
      assert.equal(batches.length, 1);
      assert.match(batches[0].url, /part_costs_leo_tmp_/);
      assert.equal(batches[0].body.requests.length, 2);
      assert.equal(batches[0].body.requests[0].action, "updateObject");

      assert.equal(out.records_written, 2);
      assert.equal(out.records_before, 4312);
      assert.equal(out.searchable, true);
    } finally {
      stub.restore();
    }
  }));

await test("writes go to the write host, reads to -dsn", () =>
  withEnv({}, async () => {
    const stub = stubFetch(refreshHandlers());
    try {
      await TOOLS.refresh_index.run({
        index: "part_costs", feed_url: "https://api.example.com/feed", feed_auth: false,
      });
      for (const r of stub.seen) {
        if (!r.url.includes("algolia.net")) continue;
        const isWrite = r.url.includes("/operation") || r.url.includes("/batch");
        if (isWrite) {
          // A write sent to `-dsn` appears to succeed and lands on a read
          // replica: the refresh "works" and the index nobody is searching is
          // the one that changed.
          assert.ok(!r.url.includes("-dsn"), `write went to a read replica: ${r.url}`);
        } else {
          assert.ok(r.url.includes("-dsn"), `read did not use the DSN host: ${r.url}`);
        }
      }
    } finally {
      stub.restore();
    }
  }));

await test("dry_run reads the feed with no Algolia credentials at all", () =>
  withEnv({ algolia_app_id: undefined, algolia_admin_api_key: undefined }, async () => {
    // The one diagnostic that needs no permissions must not require the key
    // with the most. Demanding a write key to answer "is the feed the problem
    // or the index?" made it unrunnable by exactly the person asking.
    const stub = stubFetch([{ match: "/feed", body: [{ objectID: "a" }, { objectID: "b" }] }]);
    try {
      const out = await TOOLS.refresh_index.run({
        index: "part_costs", feed_url: "https://api.example.com/feed",
        feed_auth: false, dry_run: true,
      });
      assert.equal(out.records_in_feed, 2);
      assert.equal(out.records_in_index, null);
      assert.match(out.note, /no Algolia credentials/);
    } finally {
      stub.restore();
    }
  }));

await test("a real refresh still refuses without credentials", () =>
  withEnv({ algolia_admin_api_key: undefined }, async () => {
    // The permissive read above must not have loosened the write.
    const stub = stubFetch([{ match: "/feed", body: [{ objectID: "a" }] }]);
    try {
      await assert.rejects(
        TOOLS.refresh_index.run({
          index: "part_costs", feed_url: "https://api.example.com/feed", feed_auth: false,
        }),
        /algolia_admin_api_key/,
      );
    } finally {
      stub.restore();
    }
  }));

await test("dry_run writes nothing and still counts both sides", () =>
  withEnv({}, async () => {
    const stub = stubFetch(refreshHandlers());
    try {
      const out = await TOOLS.refresh_index.run({
        index: "part_costs", feed_url: "https://api.example.com/feed",
        feed_auth: false, dry_run: true,
      });
      assert.equal(out.records_in_feed, 2);
      assert.equal(out.records_in_index, 4312);
      assert.equal(stub.seen.filter((r) => r.method === "POST").length, 0,
                   "dry_run must issue no writes at all");
    } finally {
      stub.restore();
    }
  }));

await test("an index that does not exist yet is refreshed, not refused", () =>
  withEnv({}, async () => {
    // The settings read 404s for a brand-new index. Treating that as fatal
    // means the one case a refresh is most obviously right for — an index
    // nothing has ever filled — is the one it refuses.
    const stub = stubFetch([
      { match: "/feed", body: [{ objectID: "a" }] },
      { match: "/1/indexes/brand_new/operation", method: "POST", body: { taskID: 1 } },
      { match: "/task/", body: { status: "published" } },
      { match: "/batch", method: "POST", body: { taskID: 2 } },
      { match: "/operation", method: "POST", body: { taskID: 3 } },
      { match: "/1/indexes/brand_new", status: 404, body: { message: "Index does not exist" } },
    ]);
    try {
      const out = await TOOLS.refresh_index.run({
        index: "brand_new", feed_url: "https://api.example.com/feed", feed_auth: false,
      });
      assert.equal(out.records_before, null);
      assert.equal(out.records_written, 1);
    } finally {
      stub.restore();
    }
  }));

await test("a copy task is awaited on the source index, not the destination", () =>
  withEnv({}, async () => {
    const stub = stubFetch(refreshHandlers());
    try {
      await TOOLS.refresh_index.run({
        index: "part_costs", feed_url: "https://api.example.com/feed", feed_auth: false,
      });
      const tasks = stub.seen.filter((r) => r.url.includes("/task/"));
      // Algolia scopes a task to the index the operation was issued against.
      // Polling the destination answers "unknown task" forever, so the wait
      // becomes a three-minute hang ending in a timeout that blames publishing.
      assert.match(tasks[0].url, /\/1\/indexes\/part_costs\/task\/1$/);
      assert.match(tasks.at(-1).url, /part_costs_leo_tmp_\d+\/task\/3$/);
    } finally {
      stub.restore();
    }
  }));

// ── save_records / delete_records ──────────────────────────────────────────

await test("save_records upserts against the live index and publishes", () =>
  withEnv({}, async () => {
    const stub = stubFetch([
      { match: "/batch", method: "POST", body: { taskID: 9 } },
      { match: "/task/", body: { status: "published" } },
    ]);
    try {
      const out = await TOOLS.save_records.run({
        index: "part_costs",
        records: [{ objectID: "PL335144-LS", Name: "Laser-PASSTHROUGH COVER" }],
      });
      assert.equal(out.records_written, 1);
      assert.deepEqual(out.object_ids, ["PL335144-LS"]);
      // The narrow path must be honest about what it is not: it adds and
      // replaces, and leaves anything the index holds that the source has
      // dropped. Somebody reaching for it to fix a *deletion* needs to know.
      assert.match(out.note, /does not\s+remove/);
      assert.match(stub.seen[0].url, /\/1\/indexes\/part_costs\/batch$/);
    } finally {
      stub.restore();
    }
  }));

await test("delete_records refuses an empty list", () =>
  withEnv({}, async () => {
    await assert.rejects(
      TOOLS.delete_records.run({ index: "part_costs", object_ids: [] }),
      /non-empty/,
    );
    await assert.rejects(
      TOOLS.delete_records.run({ index: "part_costs", object_ids: ["  "] }),
      /non-empty/,
    );
  }));

await test("a batch over 1000 records is chunked, each chunk awaited", () =>
  withEnv({}, async () => {
    const stub = stubFetch([
      { match: "/batch", method: "POST", body: { taskID: 5 } },
      { match: "/task/", body: { status: "published" } },
    ]);
    try {
      // Algolia rejects an oversized batch whole, so without chunking a large
      // refresh fails at the first request and writes nothing at all.
      const records = Array.from({ length: 2300 }, (_, i) => ({ objectID: `p${i}` }));
      const out = await TOOLS.save_records.run({ index: "part_costs", records });
      const batches = stub.seen.filter((r) => r.url.includes("/batch"));
      assert.equal(batches.length, 3);
      assert.deepEqual(batches.map((b) => b.body.requests.length), [1000, 1000, 300]);
      assert.equal(stub.seen.filter((r) => r.url.includes("/task/")).length, 3);
      assert.equal(out.records_written, 2300);
    } finally {
      stub.restore();
    }
  }));

// ── Error reporting ────────────────────────────────────────────────────────

await test("Algolia's own message survives, not just the status", () =>
  withEnv({}, async () => {
    const stub = stubFetch([
      { match: "/1/indexes", status: 403, body: { message: "Method not allowed with this API key" } },
    ]);
    try {
      await assert.rejects(TOOLS.list_indices.run({}), (e) => {
        // The status alone sends a reader looking for a network fault. This
        // message names the actual cause: a search-only key.
        assert.match(e.message, /Method not allowed with this API key/);
        return true;
      });
    } finally {
      stub.restore();
    }
  }));

await test("search reports total hits and whether the count is exhaustive", () =>
  withEnv({}, async () => {
    const stub = stubFetch([
      { match: "/query", method: "POST", body: { hits: [], nbHits: 0, exhaustiveNbHits: true } },
    ]);
    try {
      const out = await TOOLS.search.run({ index: "part_costs", query: "PL335144-LS" });
      // Zero hits is the answer that started all this. It has to be reported as
      // a *result*, distinguishable from a call that never ran — which is what
      // the isError envelope on the other paths is for.
      assert.equal(out.total_hits, 0);
      assert.equal(out.exhaustive, true);
      assert.ok(stub.seen[0].body.params.includes("query=PL335144-LS"));
    } finally {
      stub.restore();
    }
  }));

await test("every tool declares its required arguments", () => {
  // A tool with a schema that requires nothing is one the model calls with
  // nothing, and `undefined` interpolated into a URL is the literal text
  // "undefined" — which Algolia honours as a real index name.
  for (const [name, t] of Object.entries(TOOLS)) {
    assert.ok(t.description.length > 40, `${name} has no useful description`);
    assert.equal(t.inputSchema.type, "object", `${name} has no object schema`);
    if (name === "list_indices") continue;
    assert.ok(Array.isArray(t.inputSchema.required) && t.inputSchema.required.includes("index"),
              `${name} does not require \`index\``);
  }
});

console.log(results.join("\n"));
console.log(failures ? `\n${failures} failing` : `\n${results.length} passing`);
process.exit(failures ? 1 : 0);
