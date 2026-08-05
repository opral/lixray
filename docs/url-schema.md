# LixRay URL Schema Specification

Status: **design reference** · Updated 2026-07-22

Implementation note: the current hard-cut schema uses one `namespaces` model for
personal and organization ownership, one global `handles` pool, and internal
`lixes` records rendered as “workspaces” in the UI. Handle and slug redirects,
tombstones, renames, and transfer semantics described later in this document are
future design material and are explicitly out of scope for the current release.

Scope: the public URL grammar of lixray.com, the identity model behind it (handles, namespaces,
workspaces), and the Postgres schema that implements it. v1 ships latest-only URLs, no raw-bytes
serving, one shared handle pool for users and orgs, and a minimal entity set — but the grammar
reserves every extension point now, because URL grammar is a public API with unenumerable
consumers (regexes, agent memories, oEmbed registries) and cannot be changed later without a
Figma-class ecosystem migration.

---

## 1. Grammar

```
url          = "https://lixray.com" path [ query ] [ fragment ]
path         = "/@" handle                          ; namespace profile
             | "/@" handle "/" slug [pin] sub       ; workspace + sub-resources
             | "/" product-route                    ; app-owned, unlimited, forever

sub          = ""                                   ; workspace overview
             | "/file/" file-path                   ; file viewer         (v1)
             | "/dir" [ "/" file-path ]             ; directory listing   (v1; bare = root)
             | "/raw/"  file-path                   ; raw bytes           (RESERVED)
             | "/llms.txt"                          ; machine index       (RESERVED)
             | "/" verb …                           ; future closed-set verbs (RESERVED)

pin          = "@" changeset-id                     ; immutable permalink (RESERVED)
query        = "?" query-param *( "&" query-param )
query-param  = invite-param | future-query-param
invite-param = "invite=" opaque-token               ; edit capability (RESERVED)
opaque-token = 32*256( ALPHA / DIGIT / "_" / "-" )  ; implementation currently emits 64 hex chars

handle       = lowercase [a-z0-9], internal hyphens (never consecutive, never at edges),
               max 39 chars: ^[a-z0-9](?:-?[a-z0-9]){0,38}$ AND char_length ≤ 39
               (the regex alone admits up to 77 chars; the length cap is a separate check)
slug         = same grammar, max 100 chars
changeset-id = ^[a-z0-9][a-z0-9._-]{0,63}$          ; MUST NOT contain "/"; "latest","main" reserved
file-path    = "/"-separated segments, RFC 3986 percent-encoded, NFC-normalized
verb (v1)    = "file" | "dir" | "team"
verb (rsvd)  = raw diff change changes history blame settings edit new embed
               archive zip releases agents threads blob tree folder files sync
```

Examples: `lixray.com/@samuel` · `lixray.com/@google/android/file/gearbox/housing.step` ·
`lixray.com/@google/android@01hx4f…/file/launch-plan.md` (future pin).

---

## 2. Decisions and arguments

### D1 — `@` sigil on namespaces; the bare root is app-owned by grammar

**Decision.** Namespaces are addressed as `/@{handle}`. Everything not starting `/@` is product
space (`/settings`, `/docs`, `/api`, …), forever.

**Why.** (a) No reserved-word governance: bare-root platforms carry an eternal blocklist (GitHub
~300 names incl. `404`; Gitea retroactively confiscated `v2` when the OCI protocol demanded it;
Hugging Face froze every product word as an unregisterable username). (b) A new product route can
never break a canonical user URL — collision is impossible by construction. (c) Zero-lookup URL
classification: `/@` ⇒ user space; agents, unfurlers, and MCP servers parse without a database.
(d) `@` reads as "account" universally; precedent at scale: YouTube's 2022 handle migration
(consolidating its `/c/`–`/user/`–`/channel/` zoo), TikTok, Medium, Threads, Mastodon, JSR
(`jsr.io/@std/http`). (e) `@` is legal in path segments per RFC 3986 (unlike `~`, which some
tools mangle to `%7E`).

**Rejected.** _Bare root_ (GitHub-style): buys familiarity at the cost of the eternal blocklist
and retroactive-confiscation risk; every pain story in the research (GitLab `/-/`, Gitea `v2`,
HF) was a bare-root retrofit. _`/x/{ns}` prefix_ (Reddit/PyPI-style): same guarantee but three
opaque characters; prefixes fit resource types (packages, posts), sigils fit identities.

**Consequences.** All UI/API output MUST emit only the `@` form. A bare `/{handle}` MUST NOT be
interpreted as a namespace alias or looked up in the handle registry, even when it matches an
active handle; non-product bare-root paths return 404. This keeps every non-`/@` path available to
the product forever. Flipping canonical to bare root later is a breaking ecosystem migration and
MUST be treated as impossible.

### D2 — Exactly two name levels, forever

**Decision.** `@{handle}/{slug}` — namespaces MUST NOT nest.

**Why.** With two fixed levels, the verb at segment 3 parses statically. GitLab allowed nested
groups and the verb position became ambiguous; the fix (`/-/` delimiter) took a 5-year dual-route
migration and hard link rot at 17.0. If nesting ever returns to the roadmap, adopt `/-/` **before**
shipping it.

### D3 — Fixed verb segment `file` / `dir`; closed verb set; self-healing

**Decision.** Files mount at `/file/{path}`, directories at `/dir/{path}`. The verb set is
closed and documented; `/file/` on a directory MUST 301 to `/dir/` and vice versa (GitHub does
the equivalent blob/tree correction in both directions, verified).

**Why.** (a) Bare `/{slug}/{path}` would let user file trees swallow the sub-workspace URL space,
forcing reserved words _inside user trees_ (GitLab's `PROJECT_WILDCARD_ROUTES` disaster — users
owned `tree`, `raw`, `badges` before GitLab reserved them). (b) Two verbs make the URL
self-describing: the router picks the renderer before any storage lookup (relevant to SlateDB
roundtrip economics); self-healing redirects mean wrong guesses still land. (c) **Vocabulary
rule: mass-user words, never VCS jargon** — `file` over `blob`, `dir` over `tree`. The audience
is "your team and agents", not git natives; `blob`/`tree` mean nothing outside git, and
guessable grammar wins with both humans and agents.

**Rejected.** Single content verb (router probes type — loses self-description and pre-lookup
routing); `/-/` delimiter (unneeded under D2); `tree` (GitHub muscle memory, but git jargon —
stays reserved; MAY 301 to `/dir/` as a courtesy alias for git-native fingers); `folder` (the
maximal consumer word, but `dir` is the established URL abbreviation and half the length — stays
reserved); `files` (one keystroke from `file`; near-identical verbs in a closed set are a
permanent typo tax — stays reserved).

### D4 — Version pin: `{slug}@{changeset-id}`, reserved now, shipped later

**Decision.** v1 URLs mean "current state". The future immutable permalink attaches the pin to
the workspace segment: `/@{ns}/{ws}@{cs}/file/{path}`. `@` is outside slug grammar, so parsing is
unambiguous by string inspection alone, forever. Unpinned = latest.

**Why.** (a) Retrofit safety: a later positional ref slot (`/file/{ref}/{path}`) is fatally
ambiguous against v1's `/file/{path}` (`/file/main/readme.md` — ref or folder?). This is GitHub's
permanent scar (slashed branch names force DB-lookup URL splitting; ambiguous refs banned only in
2023; Bitbucket never solved it — slashed-ref URLs 404, bug open for years). (b) One mechanism
pins every verb (`@{cs}/dir/…`, `@{cs}/diff/…`). (c) Developers already read `@scope/pkg@version`
(npm/unpkg/JSR) — `@google/android@01hx…` is native syntax to this audience. (d) CDN policy by
string inspection: pinned ⇒ `cache-control: public, max-age=31536000, immutable`; floating ⇒
short TTL + ETag. GitHub's failure to split these (SHA-pinned raw gets `max-age=300`) created the
entire jsDelivr/RawGit proxy ecosystem; for LixRay every floating resolve is a SlateDB roundtrip,
so the immutable tier is the cost model.

**Rejected.** Positional ref (ambiguity above); mandatory ref from day one (uglifies every v1
share link for a deferred feature); typed marker in path head (`/file/sha/{id}/{path}` — collides
with legitimate filenames unless user trees are constrained; backwards); query param `?v=`
(a pin is identity, not view state — query params get stripped in citations and mangled by
shorteners; identity belongs in the path, view state in query, anchors in fragment).

**Consequences.** Once served, a pinned `(ns, ws, changeset, path)` MUST never resolve to
different bytes — across deletion, rename, and slug reuse. This is what makes agent caches and
embedded references safe (PyPI/npm/Go-proxy guarantee).

### D5 — Raw bytes: deferred, slot reserved, domain decided

**Decision.** No raw serving in v1; the viewer never echoes user bytes verbatim (sanitized
rendering only). When raw ships: sibling verb `/raw/{path}` as a mechanical `/file/`→`/raw/`
segment swap, where lixray.com does authz and 302s to a **separate registrable domain**
(lixrayusercontent.com-class), never a subdomain.

**Why.** Segment swap = zero-lookup rewrite rule, advertisable in one line of llms.txt.
Subdomains are same-site: `Domain=.lixray.com` cookies flow into (and are settable from) raw
responses — session fixation, cookie bombing, shared renderer processes; PSL-listing your own
subdomain does not stop downward cookie flow. GitHub's 2013 forced github.io migration is the
retrofit cost. Buy the domain and submit it to the Public Suffix List before first use
(propagation lags months).

**Rejected.** Suffix append (`.raw`/`.md`) — dots are data in file paths; suffix routing is why
Rails/Reddit ban dots in slugs. `?raw=true` — citation-fragile; GitHub itself 302s it away.
`Accept:` negotiation — invisible in the URL, Vary cache footgun (Cloudflare ships it and forgets
`Vary: Accept`); MAY exist as a bonus, never primary.

### D6 — Anchors: fragments now, query params only when unfurls must differ

`#L10-L20` for line anchors (client-side scroll). Fragments never reach the server (verified:
GitHub OG output is byte-identical for any `#L` anchor), so if a selection must change the Slack
card, use `?line=10-20` — Slack caches per exact URL, so variants get distinct unfurls. Additive;
nothing to reserve beyond convention.

### D6a — `?invite=` is the reserved workspace edit-capability parameter

**Decision.** `invite` is reserved in the published query grammar. A Share action mints one
opaque, reusable token and appends it to the otherwise byte-identical canonical URL:
`/@{ns}/{ws}/file/{path}?invite={token}`. The token maps only to its sharer, this workspace, and
an edit grant. It never identifies a person, grants organization membership, or changes the
resource identity in the path.

The plain canonical URL is public read-only. Therefore the Share toggle is not a second
permission model: **Can edit** copies the capability URL; **Read only** copies the canonical URL.
No recipient email, ACL, or invitation-acceptance resource is modeled in v1.
Joining creates a personal namespace if needed, but MUST NOT infer or add organization membership
from the recipient's email domain.

**Canonicalization.** A browser that opens a valid capability MUST resolve it, retain it only in
browser session state, and replace the address-bar URL with the canonical URL before normal
in-app navigation continues. Re-sharing from the bar therefore shares public read access, not an
edit grant. A malformed, revoked, or expired token MUST likewise clean to the canonical public
read view without a dead end. Implementations MUST send `Referrer-Policy: no-referrer` while this
flow exists.

**Why query, not path.** An edit grant is state rather than resource identity. The query slot keeps
the D3 verb set closed and composes mechanically with every existing and future resource URL,
including pins. Query stripping by shorteners degrades safely to the already-public read page;
it does not make the URL unresolvable.

### D7 — Canonicalization and path hygiene

- One canonical URL per resource. Non-canonical casing MUST 301 (uniqueness is enforced on the
  lowercase form; do not imitate GitHub's serve-200-at-every-casing).
- No trailing slash on canonical URLs; 301 the variant.
- Percent-encode per RFC 3986; decode exactly once; reject `%2F`, `%5C`, `%00`, and post-decode
  dot-segments at the edge **with the same normalizer the app uses** (edge/origin normalization
  disagreement is an attack class behind a CDN).
- Filenames NFC-normalized at write time; NFC/NFD and case-only sibling files rejected at
  creation (beats git's macOS case-collision checkouts). Windows-illegal names (`CON`, trailing
  dot/space, …) warned or rejected — they sync-poison workspaces.
- Encoded path length capped ~2,048 bytes.
- ASCII-only handles/slugs (homoglyph squatting is an attack class amplified by agents that
  dereference URLs without judgment); Unicode lives in display names, not identifiers.

### D8 — Identity lifecycle: names are aliases, IDs are truth

- Every namespace and workspace has an immutable ID (UUIDv7/ULID) minted at creation. Storage,
  permissions, stars, mentions, containers, and agent state key on IDs, never on names.
- Rename ⇒ old name becomes a permanent 301 (`redirect` state) on **every** surface (pages, file
  URLs, future raw/sync/API). GitHub's partial coverage (profiles/gists don't redirect) is a
  documented pain and phishing source.
- A live redirect MUST never be silently shadowed by a new registration (root cause of
  repo-jacking: >10k Go/Swift packages pointed at renamed GitHub owners; GitHub's retirement
  countermeasure was bypassed 4× via restore/transfer/race). The check lives in **one**
  uniqueness constraint hit by every name-materializing path (create, rename, transfer, restore,
  import).
- Delete ⇒ tombstone: HTTP 410 page ("deleted on DATE"), name held (30–90d cooldown; permanent
  retirement above a popularity threshold measured in fetches/agent-syncs). Free self-serve
  deletion only within ~72h of creation (npm model).
- Dispute/squatting policy written at launch (npm/crates.io both let it fester with none).
- Principal deletion (account close / GDPR) is an application flow, never a cascade: the
  principal's namespaces transfer to the system-owned **ghost organization** in the same
  transaction (GitHub's ghost model — keeps mention/permission FKs intact and the
  exactly-one-owner constraint satisfied), their active handles tombstone, and surviving
  references render via the ghost sentinel.

### D9 — Namespaces MUST be taggable

**Decision.** `@{handle}` is simultaneously the URL segment and the mention token. Typing
`@samuel` in any text surface (change reviews, comments, agent threads, workspace docs) MUST
resolve against the same handle registry that routes URLs, and MUST link to `lixray.com/@samuel`
by pure string concatenation — no mapping table, no lookup divergence.

**Rules.**

- Mentions are **stored as `namespace_id`** (immutable) and **rendered with the current handle** —
  renames never break or misdirect historical mentions.
- Mentioning a handle in `redirect` state resolves to its namespace and renders the canonical
  current handle.
- Notification fan-out: user-owned namespace ⇒ notify the user; org-owned ⇒ per org notification
  settings (member fan-out).
- Agent identities (Claude, ChatGPT, … as actors in the activity feed) get mentionable handles
  the public can never register — seeded as **`active` handles on system-owned namespaces**
  (owned by the platform organization), NOT as `reserved` registry rows: a `reserved` row has no
  `namespace_id` to store in mentions and routes to 404, which would make `@claude` unmentionable
  and its profile URL dead. (GitHub Apps `name[bot]` precedent.) Impersonation of agent actors
  must be structurally impossible.
- Team mentions (`@org/team`) are a future extension; not in v1 grammar.

**Why.** This coherence is the sigil's dividend (YouTube built handles _for_ tagging — channel
names weren't unique); it collapses "who is this" (URL), "notify them" (mention), and "who did
this" (activity feed actor) into one registry, which agents can also resolve mechanically.

### D10 — Machine consumption (reserved, cheap, differentiating)

- `/@{ns}/{ws}/llms.txt`: auto-generated per-workspace index (spec-legal at subpaths; Cloudflare
  ships per-product llms.txt). Root `lixray.com/llms.txt` documents the grammar itself.
- Publish the grammar as RFC 6570 templates (`https://lixray.com/@{ns}/{ws}/file/{+path}`) — a
  documented parsing contract (Figma's openapi.yaml precedent). Anonymous, SSR'd LixRay URLs are
  MCP-spec-sanctioned resource URIs as-is.
- Public pages MUST be server-rendered with content in initial HTML (no major AI crawler except
  Google executes JS; a JS-only viewer is invisible to AI search and un-citable).
- Private resources MUST be indistinguishable from nonexistent (404 + sign-in CTA; uniform OG;
  unfurl caches hold leaks ≥7 days with no purge API).

---

## 3. Reserved handles (seed at launch)

Two mechanisms, both inside the `@` pool — routing collisions are impossible (D1), so this is
brand policy only:

1. **`reserved` registry rows** (pure name blocks, route to 404): `admin`, `support`,
   `security`, `billing`, `settings`, `login`, `official`, `api`, `help`, `staff`, `system`,
   `lixray-*`, and similar confusables. Grow freely — reserving inside the pool never breaks
   routing.
2. **System-owned active namespaces** (need working URLs and mentionability, per D9): `lixray`,
   `lix`, `ghost`/`deleted` (sentinel owner for deleted principals, see D8), and agent actor
   handles (`claude`, `chatgpt`, `gemini`, `codex`, `copilot`, …).

---

## 4. Postgres schema (Supabase)

Principles: `auth.users` is the principal anchor; orgs/memberships are first-class app tables;
**one registry table per name pool** so uniqueness, redirects, tombstones, reservations, and the
never-shadow rule are a single constraint (race-free by construction); names resolve to immutable
IDs; RLS enforces "URL says which tenant, JWT proves membership".

```sql
-- principals ---------------------------------------------------------------
create table organizations (
  id           uuid primary key default gen_random_uuid(),
  display_name text not null,
  created_at   timestamptz not null default now()
);

create table memberships (
  org_id  uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role    text not null check (role in ('owner','admin','member')),
  primary key (org_id, user_id)
);

-- namespaces: the entity behind a handle ------------------------------------
create table namespaces (
  id            uuid primary key default gen_random_uuid(),
  display_name  text,                                   -- unicode allowed here, not in handles
  owner_user_id uuid references auth.users(id),
  owner_org_id  uuid references organizations(id),
  is_primary    boolean not null default false,         -- the owner's identity handle
  created_at    timestamptz not null default now(),
  check (num_nonnulls(owner_user_id, owner_org_id) = 1) -- exactly one owner
);
-- one primary namespace per principal (username semantics)
create unique index ns_primary_user on namespaces (owner_user_id)
  where is_primary and owner_user_id is not null;
create unique index ns_primary_org  on namespaces (owner_org_id)
  where is_primary and owner_org_id is not null;

-- handles: THE @-pool. One row per handle string ever used. -----------------
create table handles (
  handle       text primary key
               check (handle ~ '^[a-z0-9](?:-?[a-z0-9]){0,38}$'
                      and char_length(handle) <= 39),
  squat_key    text generated always as (replace(handle, '-', '')) stored,
  state        text not null check (state in ('active','redirect','reserved','tombstone')),
  namespace_id uuid references namespaces(id),
  reason       text,                                    -- for reserved/tombstone rows
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz,                             -- set on tombstone: cooldown clock + 410 page date
  -- active/redirect require a namespace; tombstones MAY keep theirs (restore/dispute evidence)
  check (state not in ('active','redirect') or namespace_id is not null)
);
create unique index handles_squat on handles (squat_key);   -- npm moniker rule
create unique index handles_one_active_per_ns on handles (namespace_id)
  where state = 'active';

-- workspaces + their slug pool (same registry pattern, scoped per namespace) -
create table workspaces (
  id           uuid primary key default gen_random_uuid(),
  namespace_id uuid not null references namespaces(id),
  display_name text,
  visibility   text not null default 'private' check (visibility in ('public','private')),
  created_at   timestamptz not null default now()
);

create table workspace_slugs (
  namespace_id uuid not null references namespaces(id) on delete cascade,
  slug         text not null
               check (slug ~ '^[a-z0-9](?:-?[a-z0-9]){0,99}$'
                      and char_length(slug) <= 100),
  squat_key    text generated always as (replace(slug, '-', '')) stored,
  state        text not null check (state in ('active','redirect','tombstone')),
  workspace_id uuid references workspaces(id),
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  primary key (namespace_id, slug),
  check (state not in ('active','redirect') or workspace_id is not null)
);
create unique index ws_slugs_squat on workspace_slugs (namespace_id, squat_key);
create unique index ws_one_active_slug on workspace_slugs (workspace_id)
  where state = 'active';

-- mentions store the immutable id, never the handle string -------------------
-- e.g. mentions(namespace_id uuid references namespaces(id), source_type, source_id, …)
```

**How the registry works.**

- _Routing_ `/@{h}/{s}`: lower-case `h`, look up `handles` — `active` ⇒ serve; `redirect` ⇒ 301
  to the namespace's active handle (partial unique index guarantees at most one; see deletion
  rule below); `tombstone` ⇒ 410; `reserved`/missing ⇒ 404. Namespace profiles are public, so
  this is safe at the handle tier. **Workspace slugs resolve visibility-first** (invariant 9):
  resolve `s` to its workspace, apply the visibility/RLS check, and only then emit 301
  (redirect) or 410 (tombstone) — an anonymous request touching a _private_ workspace's current,
  former, or deleted slug gets the uniform 404. Emitting 301/410 before the visibility check
  leaks existence, rename targets, and deletion dates to anonymous crawlers whose caches you
  cannot purge.
- _First claim_: a single `INSERT` — the PK blocks exact duplicates, `handles_squat` blocks
  case/punctuation twins (`launch-plan` vs `launchplan`), and because redirect/reserved/tombstone
  rows live in the same table, shadowing a live redirect or claiming a reserved/retired name
  fails on the same constraint.
- _Re-materialization_ (restore, post-cooldown reuse, rename-back): the PK row already exists, so
  these are **guarded state-transition UPDATEs**, the only other legal materializing primitive:
  `UPDATE handles SET state='active', namespace_id=$ns, deleted_at=null
 WHERE handle=$h AND state='tombstone' AND deleted_at < now() - interval '90 days'`
  — require rowcount = 1, else abort. INSERT-or-guarded-UPDATE both serialize on the same PK
  row, so the repo-jacking race (GitHub's retirement was bypassed 4× via restore/transfer/race)
  stays structurally closed across every materializing path.
- _Rename_ (one transaction): `UPDATE handles SET state='redirect'
WHERE handle=$old AND state='active' AND namespace_id=$ns` (rowcount MUST be 1 — an unguarded
  update is a hijack primitive against other namespaces' live handles) + materialize `$new` as
  `active`. Old URLs 301 forever; mentions and permissions are untouched (they hold
  `namespace_id`).
- _Delete_ (one transaction): the active handle → `tombstone` (set `deleted_at`) **and all of the
  entity's `redirect` rows → `tombstone`** — otherwise they would dangle, pointing at a namespace
  with no active handle to 301 to. Same rule for `workspace_slugs` on workspace deletion.
- _Transfer_: update `namespaces.owner_*` — every URL, mention, and workspace survives verbatim.
- Intentional property: tombstoned rows keep their `squat_key` claimed, so punctuation variants
  of retired names stay blocked (repo-jacking hygiene); only the exact string can return, via the
  guarded transition. Known edge case: `handles_squat` also blocks an owner renaming to a
  punctuation-variant of their _own_ former handle (`launch-plan` → `launchplan`); resolve via
  support tooling that retires the old row in the same transaction. Accepted cost of the
  race-free design.

**RLS sketch** (illustrative, not exhaustive). On Supabase, **every** table MUST have RLS
enabled: tables in the exposed schema default to RLS-off, and the anon key can otherwise
enumerate `workspace_slugs` (every private workspace's name), `memberships` (org rosters),
`namespaces`, and `organizations` straight through the auto-generated PostgREST Data API —
gutting invariant 9 regardless of routing behavior. Server-side routing reads (which must see
redirect/tombstone rows the anon role cannot) go through `security definer` functions or the
service role. Note also: `owner_user_id references auth.users(id)` defaults to NO ACTION, which
is intentional — Supabase account deletion must run the D8 ghost-org application flow, never a
cascade.

```sql
alter table organizations  enable row level security;
alter table memberships    enable row level security;
alter table namespaces     enable row level security;
alter table handles        enable row level security;
alter table workspaces     enable row level security;
alter table workspace_slugs enable row level security;

create policy workspaces_public_read on workspaces
  for select using (visibility = 'public');

create policy workspaces_member_all on workspaces
  for all using (
    exists (select 1 from namespaces n
            where n.id = workspaces.namespace_id
              and (n.owner_user_id = auth.uid()
                   or exists (select 1 from memberships m
                              where m.org_id = n.owner_org_id
                                and m.user_id = auth.uid())))
  );
```

The invariant carried over from the current worker architecture: the URL names the tenant, the
JWT proves membership, and RLS is where they are checked against each other — neither is trusted
alone.

---

## 5. Normative invariants (summary)

1. Canonical URLs use the `@` form; UI/API MUST NOT emit bare-root user URLs.
2. Namespaces never nest; the verb set at segment 3 is closed and documented.
3. `@` never appears in slug grammar; `/` never appears in changeset-id grammar.
4. Names are mutable aliases over immutable IDs; nothing durable keys on a name.
5. Renames 301 forever on every surface; live redirects are never shadowed; deletions tombstone
   (410) with cooldown; popular names retire permanently.
6. A pinned `(ns, ws, changeset, path)` never resolves to different bytes.
7. Namespaces are taggable: mention tokens = URL segments, stored as IDs, rendered as current
   handles; agent handles come from reserved space only.
8. User bytes are never echoed verbatim from lixray.com; raw serving (when it ships) 302s to a
   separate registrable, PSL-listed domain.
9. v1 workspace URLs resolve globally for public read. If private resources are introduced later,
   they MUST be indistinguishable from nonexistent to anonymous requests — including through
   redirects and tombstones (resolve → visibility check → only then 301/410; else uniform 404)
   and through the Data API (RLS on every table).
10. Public pages are server-rendered; the URL grammar is published as a parsing contract and
   treated as a breaking-change surface (like an API signature).
11. `invite` is a reserved query parameter for a workspace-scoped edit capability; the canonical
    URL never includes it and public read never requires it.

## 6. Open questions

- Container/SlateDB store keying must move from org-id to workspace UUID when the two-level
  model lands (today workspace == org, keyed `getByName(orgId)`).
- Timing of the usercontent domain purchase + PSL submission (months of lead time; do well
  before raw ships).
- Popularity threshold + metric for permanent name retirement (fetches? agent-syncs? stars?).
