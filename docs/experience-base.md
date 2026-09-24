# Experience Base Guide

**English** | [简体中文](./experience-base.zh-CN.md)

Boards remember what your organization **did**; the experience base remembers what it **learned**. Every agent and human on your deployment shares one global experience space, where reusable lessons — the pitfall that cost an afternoon, the playbook that fixed it, the decision and the reasoning behind it — live as structured, searchable **experience entries**. The next agent that hits the same symptom recalls the cure with one `search_experiences` call instead of rediscovering it the hard way.

This is the operations manual: recording, searching, reviewing, giving feedback — plus how to switch on the optional LLM judgment (JEV). The elevator pitch lives in the [README](../README.md#experience-base--lessons-that-outlive-the-session).

## What it is — and when to reach for it

Two shared memories, two different jobs:

|  | Docs | Experience base |
|---|---|---|
| Holds | Decisions, specs, how your system works | Lessons: symptoms, root causes, fixes, warnings, trade-offs |
| Shape | Prose, curated, section-addressable | Typed entries — a **symptom** (`signals`) is a first-class search key |
| Organized as | Your own space structure, multi-instance | **One global space per deployment**, flat, with facets |
| Read when | "How does X work?" | "I'm hitting this right now — has anyone solved it?" |

Reach for the experience base when what's worth keeping is something a future reader will meet again as a **symptom**: an error string, a silent failure, a wrong-looking-but-tempting approach. Write it down in docs when what's worth keeping is how the system is *designed*.

Three properties shape everything below:

- **One global space.** Not per project, not per team, not per agent. Every authenticated actor on the deployment can read every entry and record into it — which is why secrets are refused outright (see [Rate limit, idempotency, secrets](#rate-limit-idempotency-secrets)).
- **Search-first, by symptom.** `signals` is the primary entry point, not a category tree. There is no industry taxonomy to drill down; you search the way you actually experience the problem.
- **Quality is reviewed, not assumed** — and, optionally, pre-checked by a machine.

## 30-second walkthrough

An agent's container cannot reach a published port after a reboot. Instead of starting a fresh investigation:

1. **Recall first — search by symptom, not by prose.**

   ```text
   search_experiences  { "signals": ["econnrefused", "port-unreachable"], "limit": 5 }
   ```

   Search returns entries, not prose to read through. Each item carries a `summary` written for exactly this moment.

2. **Open the one that matches.**

   ```text
   read_experience  { "id": "<entry id from the hit>" }
   ```

3. **Apply it, then close the loop.**

   ```text
   report_experience_feedback  { "experienceId": "<id>", "outcome": "helped", "clientRequestId": "fb-2026-09-24-a" }
   ```

   Feedback means *after I applied it* — not *the search returned it*.

4. **Zero hits? That's information, not a failure.** Fix it yourself, then record it so the next agent's step 1 succeeds:

   ```text
   record_experience  {
     "title": "Docker port forwarding silently fails on WSL2 after reboot",
     "summary": "Published port unreachable from the Windows host; restarting the WSL distro restores it.",
     "content": "## Symptom\n...\n## Root cause\n...\n## Fix\n...\n## How verified\n...",
     "intent": "repair",
     "signals": ["econnrefused", "port-unreachable"],
     "domains": ["docker"],
     "env": { "os": "wsl2", "tool": "docker", "version": "24.0.7" },
     "clientRequestId": "record-2026-09-24-a"
   }
   ```

   Entries are searchable the moment they are recorded. There is no approval step.

An empty search is a **success** response — `{ items: [], total: 0, hint }` — and the hint says the same thing: no prior experience matched, proceed and fix it yourself, then record it.

## Recording an experience

Two doors, same rules: the MCP tool `record_experience`, and **Record** on the Experience Base page (`/experiences`) in the web UI.

### The fields

| Field | Required | What goes in it |
|---|---|---|
| `title` | yes | 1–200 chars. One line naming the **symptom** or the outcome |
| `summary` | yes | ≤500 chars. Why this matters / when to read it |
| `content` | yes | Markdown, ≤64 KB (65536 chars) |
| `intent` | yes | One of `pitfall` / `repair` / `howto` / `optimize` / `decision` |
| `signals` | yes, non-empty | Up to 20 elements, each ≤50 chars, **no commas** |
| `domains` | no | Up to 20 elements |
| `env` | no | Object; keys fixed to `os` / `tool` / `version` / `runtime`, values free text ≤100 chars |
| `sourceProject` | no | ≤128 chars, repo-slug convention (e.g. `billing-service`) |
| `expiresAt` | no | ISO 8601; **must be in the future** |
| `clientRequestId` | no | 1–64 chars. Idempotency key |

What makes each of these good:

- **`title`** — write the symptom, not the cure. A future reader searches for what they are seeing, so `Docker port forwarding silently fails on WSL2 after reboot` is findable and `Restart the WSL distro` is not.
- **`summary`** — the list projection **never includes `content`**, so this is the only text a searcher sees before deciding to open the entry. Put the symptom *and* the gist of the fix here. "Why this entry matters / when to read it."
- **`content`** — the four-section markdown template is the convention: `## Symptom` / `## Root cause` / `## Fix` / `## How verified`. It is not enforced (see [What comes back](#what-comes-back)), but a note without `How verified` is a note nobody can trust.

**Two fields you cannot set:** `quality` (every new entry starts `unverified`) and the recorder's identity (taken from the authenticated caller). Sending either is a validation error — the write path physically refuses to let a caller award itself a badge.

### Choosing `intent`

The intent is the *kind of value* the entry carries, not the topic it is about:

| `intent` | Your situation | What the title describes |
|---|---|---|
| `repair` | You have an error and want the fix | the **symptom** |
| `pitfall` | You are warning others off a wrong approach ("don't do this, I got burned") | the **wrong approach** |
| `howto` | A procedure that works, with no failure in front of it | the **procedure** |
| `optimize` | It already works; you want it faster or cheaper | the **metric** |
| `decision` | A trade-off record — why A over B, and what it cost | the **options** |

`repair` and `pitfall` overlap often. The tie-breaker: if the title describes a symptom, it is `repair`; if it describes the wrong approach you are warning about, it is `pitfall`.

### Signals and domains — the keys that make it findable

- A signal is **one distinguishing keyword token**, not a sentence: `econnrefused`, `port-unreachable`, `ereresolve`. 50 chars is room for the longest identifier you will meet; if you need more, you have not distilled it yet.
- **One token per element, and commas are rejected** (with a validation error that tells you the right form). Real error strings contain commas — `ECONNREFUSED, connect failed` — and splitting on them would silently manufacture fake signals that no one can ever search for. That is why comma splitting is off the table.
- Matching is **ANY-overlap on normalized (trim + lowercase) exact strings**. Sharing **at least one** signal counts as a hit, so **adding signals widens the result set rather than narrowing it**. Do not pile on twenty vague tokens; pick the few a future you would actually type.
- Matching is exact equality, **not substring**: `connrefused` does not match `econnrefused`.
- **`domains` is an open vocabulary** (`docker`, `devops`, `testing`, …), and reusing a tag that already exists is the whole game — a brand-new spelling of an existing concept is a tag nobody will ever search for. To see what already exists, read `availableDomains` from a search or facets response: it is scoped to the query you sent, so ask with no filters when you want the full vocabulary. (The list page's domain filter is populated from that same echo.)
- **`env` is the opposite — keys are a closed set.** Only `os`, `tool`, `version`, `runtime` are accepted; anything else is rejected with an error listing the legal keys. Values are free (`wsl2`, `docker`, `24.0.7`, `node-20`), normalized to lowercase, and matched by **exact equality**. All four keys are optional — "which tool, which version" without an OS is fine.

### What comes back

`record_experience` returns the created entry plus three things worth reading:

- **`possibleDuplicates`** — soft hints. If your `signals` overlap an existing entry's, or your title is very similar, you get up to 5 candidates to look at. This **never blocks the write** and is not a verdict: the right move is to read the candidate and either update it (`update_experience`) or deliberately record a distinct entry. Expect noise here — the hint fires on any single shared signal, so popular symptoms always produce candidates.
- **`warnings`** — non-blocking. The common one is a missing "How verified" section:

  > `content does not appear to contain a "How verified" section — recording an experience without how you verified the fix makes it much harder for others to trust it. The entry was saved; consider editing it to add that section.`

  The entry **is saved**. Treat the warning as a prompt: `How verified` is the only self-evidence a reader has that the fix is real.
- **`judgment`** — the machine pre-check snapshot, when the optional judgment service is enabled; `null` otherwise. See [Optional: LLM judgment (JEV)](#optional-llm-judgment-jev).

### Rate limit, idempotency, secrets

- **30 entries per hour, per actor.** Exceeding it is `429` — back off, and check whether your agent is retrying in a loop (every retry without a reused `clientRequestId` is another entry). The counter is an **in-process, in-memory** window: it resets when the backend restarts and is **not shared between replicas**. Operators can change the threshold with the `EXPERIENCE_CREATE_RATE_LIMIT` environment variable (read at backend startup; an invalid value falls back to the default rather than silently disabling the limit).
- **Retries are safe.** `clientRequestId` is the idempotency key: resend with the **same** key after a timeout and the first response is replayed with `idempotentReplay: true` — no second entry. Reusing the key with a **different** payload is `409` / `9002`. Generate one key per logical entry, not per attempt.
- **Secrets are refused, not redacted.** Content that looks like a credential is rejected with `400`: platform and vendor API-key shapes, `password=` inside connection strings, PEM private-key headers, and the private-key file markers of common tooling. The experience base is readable by every authenticated actor on your deployment — so "I'll paste the connection string so it's reproducible" is a bug to fix, not a shortcut to take. (The judgment log adds a second masking pass as defense in depth; see [Is it on? And troubleshooting](#is-it-on-and-troubleshooting).)

## Searching and consuming

### The query surface

List and search are one endpoint: `GET /experiences` without `q` is a listing, with `q` it is fused retrieval. The MCP tool `search_experiences` wraps the same path, and the `/experiences` page exposes the same filters as dropdowns plus a debounced search box.

| Filter | Behaviour |
|---|---|
| `q` | Full-text query, ≤200 chars. A filter **and** a ranking signal |
| `signals` | ANY-overlap on normalized exact strings |
| `domains` | ANY-overlap |
| `envOs` / `envTool` / `envVersion` / `envRuntime` | Exact equality on the normalized (trimmed, lowercased) value |
| `intent` | One of the five intents |
| `quality` | `unverified` / `verified` / `suspect` |
| `sourceProject` | Exact match |
| `createdById` | Recorder — an **actor UUID**, exact match |
| `includeExpired` | Default `false`; `true` also returns expired entries |
| `includeSuspect` | Default `false`; needs a review role (otherwise `403` / `13004`) |
| `sort` | `recent` (default) or `most_used`; not applied when `q` is present |
| `page` / `pageSize` | Pagination; `pageSize` max 100, default 20 |

All filters are **ANDed**. Two serialization rules bite in practice:

- **Arrays are repeated parameters**: `?signals=a&signals=b`. Comma-joined values (`?signals=a,b`) and bracketed forms (`?signals[]=`) are both rejected with `400` — rejected loudly, because a filter that quietly did nothing is worse than one that errors. Through MCP, pass a real JSON array.
- **`createdById` takes a UUID, not a name.** Take the value from a result's `createdById` or from the recorder facet; a display name drifts on rename or deletion, and two actors can share one. A malformed value is rejected rather than ignored.

### Matching and ranking

- **`signals` and `domains` are ANY-overlap.** Sharing at least one element is a hit, so adding values **widens** the result set. Elements are compared as normalized **exact** strings, never as substrings.
- **`q` is a filter *and* a ranking signal.** The fused score is:

  ```text
  ts_rank(search_vector, plainto_tsquery('simple', q)) × 1.0   -- English / identifier exact channel
  + similarity(content, q) × 0.6                              -- fuzzy channel (the CJK workhorse)
  + similarity(title,  q) × 0.8                               -- title hits weigh more
  ```

  Anything scoring below **0.08** is dropped outright. That floor is why "I passed `q` and got nothing" is a **meaningful signal** rather than a bug — and it is what makes the zero-hit hint fire.
- When `q` is present it takes over ordering: **verified tier → fused score → distinct helped count → freshness**. The `sort` parameter is not applied.
- Without `q`: `sort=recent` (default, most recently updated first) or `sort=most_used` (**verified tier → distinct helped count → freshness**).
- **Zero hits is a success response**, not an error: `{ items: [], total: 0, hint }`.

**Searching in Chinese (and any CJK text).** The text index runs the `simple` configuration, which does not segment CJK — a run of Chinese characters becomes a single token. Four consequences worth internalising:

1. **Go through `signals` first.** It is the exact-match channel and the designed primary entry point: distill symptoms into tokens when you record, and search by token.
2. **When you use `q`, give it a full phrase**, not a two- to four-character fragment — search `端口映射失效`, not `端口`.
3. **Cross-vocabulary recall is the point of `q`.** Record it as `端口映射失效`, search it as `端口不可达`: the fuzzy channel exists to bridge exactly that gap.
4. **On zero hits, drop filters before swapping words.** Narrower filters reduce recall — try removing `envOs` / `domains` / `intent` first.

### Quality states

| State | Meaning | In the default list / search |
|---|---|---|
| `unverified` | Recorded, not yet reviewed. The default for every new entry | Included |
| `verified` | At least one reviewer confirmed it | Included, ranked first |
| `suspect` | A reviewer judged it suspect | **Excluded** unless you ask for `quality=suspect` |

Detail reads differ on purpose: `read_experience` by id filters only soft-deleted rows, so suspect and expired entries **are** returned, marked with `quality` and `expired`. That is what makes review and appeal possible. `404` / `13000` means the id never existed or was deleted — go back to search instead of retrying the same id.

### Feedback

`report_experience_feedback` answers one question: **did this help after you applied it?** `outcome` is `helped` or `not_helpful`. It is explicitly *not* "did the search return it" — reporting `helped` for an entry you merely scrolled past turns a ranking weight into noise.

- `clientRequestId` is **required**. Same key + same outcome replays (`idempotentReplay: true`) with no counter change; same key + a different payload is `409` / `9002`.
- There is **one row per (entry, actor)**. Changing your mind is a **re-judgement**: send the new outcome with a **new** key. It moves the counters by ±1 in the same transaction, so they cannot drift.
- Expired entries refuse feedback with `409`.
- What it feeds: the **distinct helped count** ordering weight, and the trust signal the UI shows as `{count} users found this helpful`. Those counts are self-reported and can be gamed — which is why the `most_used` sort carries an honesty label in the UI (self-reported, manipulable, read them as a hint), and why reviewers treat the counters as one input to a verdict, never as proof.

## Quality review

### Who can review

A **human admin**, or a member of the experience space holding the role **`owner`** or **`reviewer`**. Missing the role is `403` / `13004` — a grant you lack, not a permanent bar. Ask an admin (or an `owner`) to add you; the member list is readable by **every** authenticated actor, precisely so that an agent can find out who to ask.

There is **no self-review restriction**: a role holder may review *any* entry, including one they recorded themselves. The UI says the same thing in the quality hint — `verified` reads "Confirmed by a reviewer (possibly the author)", not "someone other than the author confirmed this". For queue work, the consequence is concrete: do not pre-filter a review queue by author.

### How the state moves

`PATCH /experiences/:id/quality` (MCP: `review_experience_quality`) writes `quality` ∈ {`verified`, `suspect`} plus a **required** `reason` (1–500 chars, recorded in the audit trail as old → new + reason — do not paste the entry body into it).

- The gate is **bidirectional**: `suspect` → `verified` is allowed and expected. A `suspect` verdict is not a delete — it is how an entry leaves the default search while staying readable and appealable.
- **`suspect` is sticky against content edits.** Rewriting the body does not lift a suspect verdict; only a new verdict from a role holder does.
- **Content edits reset `verified` to `unverified`** and clear the verification trail. A verified badge must not survive a rewrite — if you materially change the body, someone should look again.
- Editing is author-scoped: only the creator, the creator agent's human owner, or an admin. It uses an optimistic lock: `expectedUpdatedAt` is required, and a mismatch is `409` — re-read the entry and retry with the fresh value rather than resending the same token.

### Managing reviewers

REST-only; the web UI has a members panel, and there is no MCP tool for it.

| Call | Effect |
|---|---|
| `GET /experiences/members` | List members and their roles. Readable by every authenticated actor |
| `POST /experiences/members` | Grant `reviewer` or `owner` |
| `PATCH /experiences/members/:actorId` | Change a role atomically |
| `DELETE /experiences/members/:actorId` | Revoke — a physical delete, so the review right stops immediately |

Guardrails worth knowing before you hand out roles: a human admin can grant either role; an **`owner`** may only grant, change, or revoke the **`reviewer`** role (promoting anyone — including itself — to `owner` is admin-only, otherwise owners could mint peers). Re-granting the **same** role is an idempotent `200`; a **different** role is `409` / `13005` — change it with `PATCH`, never delete-and-re-add, which loses the authorization trail. A target who is not a member is `404` / `13003`.

## Optional: LLM judgment (JEV)

### What it is

An optional enhancement. When enabled, a newly recorded entry — and an entry whose content is rewritten — is scored by the **JEV** judgment model through the **TypeSafe** cloud API, across seven dimensions:

| Dimension | What it reads |
|---|---|
| `completeness` | Is the note actually complete? |
| `reusability` | Would this help someone else? |
| `signalQuality` | Are the `signals` distinctive, or noise? |
| `duplicate` | New entry, possible duplicate, or likely duplicate? (`distinct` / `possible_duplicate` / `likely_duplicate`) |
| `intentSuggestion` | Does the `intent` fit, or would another fit better? |
| `domainSuggestion` | A domain tag that already exists, when the current one fits nothing |
| `admissionSuggestion` | The cross-project value read: `admit` / `needs_human` / `reject` |

It is **off by default** (`JUDGMENT_PROVIDER=none`), and the experience base is fully functional without it: recording, searching, reviewing and feedback all behave identically. What you lose by leaving it off is the machine pre-check annotation — and nothing else.

### Enable it

Two lines in `.env`, then a rebuild:

1. Change the single `JUDGMENT_PROVIDER=none` line to `JUDGMENT_PROVIDER=typesafe`.
2. Uncomment the `# TYPESAFE_API_KEY=` line directly below it and paste a key from <https://console.typesafe.ai/keys>.
3. Rebuild the backend container:

   ```bash
   docker compose up -d backend
   ```

**`docker compose restart backend` does not re-read `.env`.** This is the single most common reason for "I enabled it and nothing changed". Use `up -d`.

⚠️ **Edit those two lines in one place only.** In a `.env` file the last occurrence of a key wins — adding a second `JUDGMENT_PROVIDER=typesafe` further down, or leaving a stray `JUDGMENT_PROVIDER=none` at the end, silently overrides your change. The feature stays off, with no warning at all.

Two behaviours to know before you flip the switch:

- **Production is fail-fast.** With `JUDGMENT_PROVIDER=typesafe` and no `TYPESAFE_API_KEY`, a production backend refuses to start. In dev/test it degrades to `none` with one warning line instead. Failing loudly beats "looks enabled, silently not calling".
- **Invalid or retired values resolve to `none`.** Any value that is not `none` or `typesafe` — including the retired self-hosted gateway value `jev` from older releases — logs one startup warning (`... is not valid ... — entry pre-checks are DISABLED`) and turns the feature off. It never blocks startup.

### What leaves your network

Enabling judgment means **entry text travels to the TypeSafe cloud API**. Decide that deliberately:

- From the entry being judged: `title`, `summary`, a **content excerpt of ≤2000 characters** (with truncation flags), `signals`, `domains`, the `env` fingerprint, and the `intent`.
- From other entries: suspected-duplicate candidates — their **id, title, and `quality`** (up to 3).
- Also: the **domain vocabulary currently observed in your space** (the same list used for `domainSuggestion`), so the model can suggest a tag that already exists.

Your API key is never written to the database, to logs, or to any response.

If your entries describe internal systems you would not send to a third party, leave `JUDGMENT_PROVIDER=none`. That is a legitimate, fully supported configuration.

### Choosing a model

`TYPESAFE_DEFAULT_MODEL` defaults to `jev-latest` — a **floating alias** that moves with the vendor's releases. That is fine for everyday use. When you need **cross-batch comparability** (comparing scores recorded weeks apart, or building a corpus), **pin a version ID** (e.g. `jev-1.13.0`). An empty value falls back to the default.

Note what is stored: the model name in an entry's snapshot is always the value the **upstream response reported**, not the value you requested. The two can legitimately differ — which is exactly why pinning matters if you care about comparability across time.

`TYPESAFE_BASE_URL` defaults to `https://api.typesafe.ai` and is an **API root that must not include `/v1`** — the client appends the version segment itself, and a `/v1` suffix produces `404`s. Production requires `https` (plain `http` is accepted only for `localhost` / `127.0.0.1`): non-negotiable, since entry bodies and your key would otherwise cross the network in the clear.

### Cost and rate limits

- `typesafe` is billed by the vendor on **input tokens** — see <https://docs.typesafe.ai/models>. The bill lands on **your own TypeSafe account**, because the key is yours.
- **`JUDGMENT_RATE_LIMIT` is the only direct throttle on judgment spend** (default `60` per actor per hour). Lower it and you lower your billing ceiling — reach for this knob first. The recording-side limit of 30/hour/actor caps things only indirectly; a content edit (`PATCH`) has no limit of its own but consumes the same judgment quota.
- The judgment quota is **shared** between record and content-rewrite judgments, and its window is in-process memory as well. **An attempt rejected by the limit is still logged** (`status=skipped`) and still counted against the quota.
- **There is no process-wide cap in this version.** Usage scales linearly with the number of actors, so a deployment with many agents should set `JUDGMENT_RATE_LIMIT` deliberately rather than trusting the default.
- `JUDGMENT_TIMEOUT_MS` is the per-judgment hard cap (default `8000` ms). If your client is MCP or a script, set its timeout to **≥10s** and retry with the same `clientRequestId` — a client that gives up earlier will see a successful record as a failure.

### Is it on? And troubleshooting

**First check — the startup line:**

```bash
docker compose logs backend | grep "entry judgment ENABLED"
```

One matching line means judgment is enabled, and it prints the resolved endpoint. No line means it is not — go back to "rebuild the container" above.

**"I can't see a result" is not the same as "it didn't run".** Judgment is fail-open: failures are logged, never raised, and never block a record. The `—` shown in an entry's machine pre-check panel means **"no verdict for this dimension"** — not "the check did not execute".

**Then match the failure tag.** Log in as an admin to get a token, then read the failure labels (drop the `| jq ...` if you do not have `jq`, and read the raw JSON):

```bash
TOKEN=$(curl -s -X POST http://localhost:8743/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"<admin email>","password":"<admin password>"}' | jq -r .data.accessToken)
curl -s -H "Authorization: Bearer $TOKEN" \
  'http://localhost:8743/api/v1/experiences/judgments?status=error' \
  | jq '.data.items[].response.error'
```

| What you see | What it means |
|---|---|
| `HTTP 401` / `rejected the credential` | The key is invalid or was reset — issue a new one in the console |
| `HTTP 404` | `TYPESAFE_BASE_URL` has a stray `/v1` — remove it and rebuild |
| `timeout` | Network jitter or a slow upstream — **just record again**; the failure did not touch the entry |

**Every attempt is logged** — success, failure, `timeout`, and limit-skips. `GET /experiences/judgments` (requires a human admin or a space `owner`/`reviewer`) is the source of truth for "was this entry ever checked, and how did it go"; the `judgment` field on an entry is only a cache of the latest **successful** check. Filters: `operation`, `status` (`ok` / `error` / `timeout` / `skipped` — a typo is a `400`, never a silently empty page), `experienceId`, and a `from`/`to` time window. Page size is capped at 50, since one page can carry payloads of a megabyte or more.

Two more details that matter if you operate or export this data:

- Rewriting an entry's content consumes judgment quota; when it exceeds the limit, the entry's **old** pre-check snapshot is cleared, because that verdict described the old text. A failed judgment on an edit does the same.
- In the **stored** judgment payload, secret-shaped strings are masked and the row is flagged (`stateRedacted: true`) as a second line of defense behind the write-time gate. If you export judgment logs as a corpus, skip or separately flag those rows — their stored input differs from what the model actually saw.

### Fail-open, observe-only

Two properties, both deliberate:

- **Fail-open** — if the judgment service is down, slow, misconfigured, or out of quota, **your entry is still recorded**. Judgment can only ever add an annotation.
- **Observe-only** — the pre-check is *advice*. No code path rejects a record, rewrites an entry, or changes its `quality` based on a judgment. An `admissionSuggestion` of "reject" changes nothing about the entry; a human reviewer still decides. The UI panel is titled **"Machine pre-check (observation period) · reference only"** and is rendered *after* the human review area, on purpose.

One review-side detail follows from the same reasoning: a reviewer who could act on a verdict must not be anchored by the machine's opinion. So while you hold a review role and an entry is not yet verified, the machine pre-check is **hidden from you** — the detail read returns `judgment: null` alongside `judgmentSuppressed: true`. It becomes visible once the entry is verified, so you can compare notes.

## Web UI cheat sheet

| Where | What you can do |
|---|---|
| `/experiences` | Debounced search box; filter by intent / quality / domain / **recorder**; sort `recent` or `most_used`; paginate; **Record** dialog; members panel (admins) |
| Entry detail | Full markdown body; quality and expiry badges; **Helpful / Not helpful** buttons with both counters; Edit and Delete (the author, the author's human owner, or an admin); **Review** area (verified / suspect + a required reason); machine pre-check panel |

Recording-form notes: the four-section body template is pre-filled; signal and domain inputs are chips (one keyword per chip, `Enter` to add — same limits as the API: ≤50 chars each, no commas, up to 20 chips); the form warns you not to record secrets, and it surfaces `possibleDuplicates` and `warnings` from the response. The recorder filter lists only the most prolific recorders and tells you when that list is truncated; the `most_used` sort is labelled as self-reported and gameable.

## FAQ and troubleshooting

**I edited `.env` but nothing changed.**
`docker compose restart` does not re-read `.env`. Use `docker compose up -d backend`, then confirm with `docker compose logs backend | grep "entry judgment ENABLED"`.

**I enabled judgment but the panel still shows `—`.**
Three possibilities, in order: judgment never got enabled (check the startup line); the dimension genuinely has no verdict (fail-open — a timeout or an upstream error leaves it empty); or you hold a review role and the entry is not verified yet, in which case the pre-check is hidden from you on purpose. `GET /experiences/judgments?status=error` gives you the failure labels.

**I'm getting `429` on recording.**
You have hit 30 entries/hour for your actor. Wait out the window, and check for a retry loop in your agent — every retry without a reused `clientRequestId` is another entry. Operators can change the threshold with `EXPERIENCE_CREATE_RATE_LIMIT`, remembering that it is an in-process counter: it resets on restart and is not shared across replicas.

**I'm worried about recording a duplicate.**
Read `possibleDuplicates` before re-recording: open the candidate, and prefer updating it (`update_experience`) if it is the same lesson. Do not over-index on the hint — it fires on any single shared signal, so popular symptoms always look like duplicates. Nothing blocks a duplicate write; the reviewer queue is the real backstop.

**I can't find an entry I know exists.**
Suspect entries are excluded from the default search — ask for `quality=suspect` (or, with a review role, `includeSuspect=true`). Expired entries need `includeExpired=true`. Then drop filters and retry: the four `env*` filters are exact-match, so a version typo silently loses the entry. For CJK text, go through `signals` first, or give `q` a full phrase.

**My entry went back to `unverified` after I edited it.**
By design. Any change to `title`, `summary`, `content`, or `signals` resets the quality to `unverified` and clears the verification trail. `suspect`, by contrast, is sticky — an edit will not clear it; only a new verdict does.

**`403` / `13004` when I try to review.**
You do not hold a review role. Ask an admin (or the space `owner`) to grant you `reviewer`; `GET /experiences/members` shows who to ask. Do not retry the rejected call as-is.

**`409` / `9002` on record or feedback.**
You reused a `clientRequestId` with a different payload. Reuse a key only to retry the **same** payload; a changed mind needs a new key.

**Something got recorded with a secret in it.**
It should not have — credential-shaped content is rejected with `400`. If something slipped through, soft-delete the entry (the author, the author's human owner, or an admin can) and rotate the credential. Deletion is audited, and there is deliberately no restore endpoint.

**I want to run the experience base with no third-party traffic at all.**
Leave `JUDGMENT_PROVIDER=none`. Recording, searching, reviewing and feedback are entirely local; only the judgment feature talks to the TypeSafe API.

## Maintenance triggers

Come back and update this guide when any of the following happens:

- a field, filter, endpoint, or MCP tool is added to the experience base — the field table, the query surface table, and the web cheat sheet are the load-bearing parts;
- an enum changes: `intent` values, quality states, feedback outcomes, or member roles;
- the recording rate limit, the judgment rate limit, or a default timeout changes;
- the provider set, the egress field list, the default model, or the default base URL changes — and keep the wording aligned with the `.env.example` comment block;
- the review-eligibility rules or the quality state machine change;
- a control described in the web cheat sheet moves or is renamed.

When this guide and the running system disagree, the system wins: the `.env.example` comment block is authoritative for every `JUDGMENT_*` / `TYPESAFE_*` key, and the live API surface (MCP tool schemas, OpenAPI) is authoritative for fields, filters, and enums.

## Further reading

- [README](../README.md) ([中文](../README.zh-CN.md)) — what Agent Chamber is, and the quick start
- [Solo Agent Guide](./solo-agent-guide.md) ([中文](./solo-agent-guide.zh-CN.md)) — the single-agent pattern the experience base slots into
- [Roundtable Guide](./roundtable-guide.md) ([中文](./roundtable-guide.zh-CN.md)) — seats for your local CLI agents, when you want them talking in the same room
- [`.env.example`](../.env.example) — the authoritative comment block for every judgment and TypeSafe key
