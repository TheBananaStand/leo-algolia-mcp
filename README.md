# leo-algolia-mcp

Algolia search indices as a Leo package, over MCP — list them, search them,
refresh one from a feed, and upsert or delete individual records.

## Why this exists

An app writes a record to its own database. Its search index is a *separate*
store that ingests on a schedule. Between the write and the next ingest the
record is real everywhere except the one place people look for it.

On the Proluxe ERP that landed as: a user created part `PL335144-LS`, found it
fine in Engineering → Parts, and got zero hits for it in the Costing BOM
picker — which searches the Algolia index `part_costs`. A control query for an
older part returned two correct hits, which is what proves the picker works and
the index is just behind.

The ERP has six endpoints that **produce** index payloads —

```
GET /algolia/parts      → part_costs
GET /algolia/catalog    → catalog
GET /algolia/customers  → customers
GET /algolia/contacts   → contacts
GET /algolia/vendors    → vendor
GET /algolia/products   → products
```

— and nothing anywhere that pushes one. Its Go helper
(`shared/services/algolia.go`) is `NewAlgoliaClient` / `GetIndex` /
`SearchIndex`: search only, no write. So there was no reindex to ask for, and
"wait for the next sync" was the whole remedy.

## Tools

| Tool | |
|---|---|
| `list_indices` | Every index, its record count, when it last built, and how many tasks are still pending. The first call when a record exists in the source system and search cannot find it — a stale `updated_at` says the index never ingested it. |
| `search` | Search one index. Reproduce the query that failed; after a refresh, prove the record is findable instead of assuming it. |
| `refresh_index` | Replace an index's entire contents from a JSON feed, atomically. The fix for an index that ingests on a schedule and has not caught up. |
| `save_records` | Upsert specific records. The narrow path for one newly created record — far cheaper than replacing a whole index, and the right call right after something is added by API. |
| `delete_records` | Remove records by objectID. |

So the Proluxe case is one call:

```
refresh_index  index=part_costs  feed_url=https://api.proluxe.com/algolia/parts
```

### Every write waits for the index to publish

Algolia indexing is asynchronous: a batch returns a `taskID` immediately and the
records become searchable some time later. A server that answered at the
`taskID` would report "refreshed" and the very next search would still miss —
the original bug, with a reassuring message on top. Every write here polls
`waitForTask` before answering, so "refreshed" means "go and look".

A wait that runs out says so **and says the records were accepted**, because
"it failed" would send somebody to re-run a write that already landed.

### `refresh_index` is three steps, and each one is load-bearing

It reimplements what the official clients call `replaceAllObjects`:

1. **Copy settings, synonyms and rules** to a temporary index. Skipping this is
   the subtle way to break search: the records arrive intact and the index comes
   back with default searchable attributes and no custom ranking, so every query
   returns the wrong things in the wrong order and nothing *looks* broken.
2. **Fill the temporary index**, in batches of 1000 (Algolia rejects a larger
   one whole), waiting for each.
3. **Move it over the real one.** A move is atomic — there is never a moment
   where the index people are searching is half full. Clearing the live index
   and refilling it is the obvious alternative and gives every search during the
   refill zero results.

`dry_run` stops after the feed and reports both counts, which is the only way to
answer "is the feed the problem or the index?" without writing anything.

### objectID

Algolia identifies a record by `objectID` and **generates one** for a record
that arrives without it. So a feed missing the field does not error — it appends
the whole feed as new records on every refresh, the index doubles, the old
copies stay searchable, and the duplicates rank against each other. This refuses
a record with no id, by position, and `object_id_field` names the field that
carries one. It is **copied, not moved**: a caller naming `Id` means "that is
also the id", not "take it away".

An empty feed is refused for the same class of reason — an upstream outage
answering `[]` would otherwise replace the index with nothing and take search
down across the whole app.

## Configuration

Leo hands an entitled setting to this process under its settings key, verbatim
and lower-case, so the descriptor's `settings_read` and `process.env.<key>` have
to agree or the credential silently never arrives.

| Key | |
|---|---|
| `algolia_app_id` | required |
| `algolia_admin_api_key` | required — the key with **write** access. A search-only key lists and searches but cannot refresh anything, and Algolia refuses it with "Method not allowed with this API key". |
| `algolia_feed_auth_user` | optional — basic auth for `refresh_index`'s feed, when the feed is protected (Proluxe's `/algolia/*` are) |
| `algolia_feed_auth_pass` | optional |

Without the two required ones the server still starts and lists its tools; every
call answers naming the missing keys and where to enter them.

Reads go to `https://{appId}-dsn.algolia.net` and writes to
`https://{appId}.algolia.net`. A write sent to `-dsn` appears to succeed and
lands on a read replica, so the refresh "works" and the index nobody is
searching is the one that changed — the test suite pins this.

## Development

```bash
npm install
npm test            # no network needed
```

The tests cover what fails *quietly*, with an injected `fetch`: a record with no
objectID, an empty feed, a write aimed at a read replica, a copy whose task is
awaited on the wrong index (which hangs for three minutes and then blames
publishing), a `replaceAllObjects` that forgets the settings scope, a batch over
1000, a `dry_run` that writes anything at all, and an Algolia error message
swallowed in favour of its status code.

## Not this

This refreshes an index on demand. It does **not** make the ERP push on write,
which is the durable fix: `POST /algolia/reindex/:index` in `proluxe-api`, next
to the six feed endpoints, using the Algolia client already vendored in
`shared/services`. That is a change in a different repo and deploys through
Cloud Build; until it exists, this is how a newly created part becomes findable
without waiting for the scheduled sync.
