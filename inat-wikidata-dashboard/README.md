# iNaturalist ↔ Wikidata / Wikipedia / GBIF / BHL dashboard

A static, client-side JavaScript tool that cross-references the taxa observed in an
[iNaturalist](https://www.inaturalist.org) project — or by a specific iNaturalist user —
against [Wikidata](https://www.wikidata.org), and flags which ones are still missing a
Wikipedia article in English, Japanese, Spanish and/or Portuguese. Inspired by
[iNotListed](https://github.com/wikiproject-biodiversity/iNotListed), reimplemented as
a browser tool with [Comunica](https://comunica.dev) doing the SPARQL federation
instead of a Python CLI hitting one endpoint at a time.

No backend, no build step, no npm install. Comunica is loaded on the fly from
jsDelivr's ESM bundle (`@comunica/query-sparql`).

## Running it

Any static file server works (it has to be `http://`, not `file://`, for ES module
imports and the SPARQL fetches to behave):

```bash
python3 -m http.server 8734
```

Then open <http://localhost:8734/>, pick **Project** or **User** as the scope, confirm/change
the value (defaults to the project `biohackathon-2026`), and click **Load observations**.

## How it works

1. **iNaturalist REST API** — paginates through every observation in the chosen project or by
   the chosen user (`project_id=` / `user_id=`, both accept either a slug/login or a numeric id)
   and collects the distinct taxa (scientific name, common name, photo, observation count).
2. **Comunica → [QLever](https://qlever.cs.uni-freiburg.de/wikidata)'s Wikidata
   mirror, live WDQS as a fallback** — resolves each scientific name to a Wikidata item
   (`wdt:P225`) and reads off cross-reference identifiers already stored there: GBIF
   (`P846`), iNaturalist taxon (`P3151`), Wikimedia Commons category (`P373`). QLever is
   fast and comfortably handles a `VALUES` list of dozens of names in well under a
   second — but it's a periodic dump import, not a live feed. Checked directly (via
   `wikibase:Dump schema:dateModified`, QLever's own build-time metadata), it was about
   six weeks stale as of 2026-09-19. Fine for a *match* (an item that existed six weeks
   ago still exists), useless as proof of absence: a taxon QLever finds nothing for
   might just be too recent for the snapshot. Since a false "not on Wikidata" here would
   make the QuickStatements feature below draft a duplicate item, only QLever's *misses*
   get a live re-check against WDQS (`resolveWikidata`'s second pass) — everything it
   already found is trusted as-is, so the common case stays fast and off WDQS entirely.
   A name match doesn't imply the two records are cross-linked, though: the matched
   item might still lack `P3151` back to this exact iNaturalist taxon (added by someone
   else, from a different source, before this tool existed). The **Wikidata** column
   flags that case (⚠ no iNat ID) with a one-line QuickStatements action to add just the
   missing statement — no need for the full `CREATE` draft an unmatched taxon gets — and
   it has its own stat card and filter ("WD item, no iNat ID") so it doesn't get lost
   among the Wikipedia-coverage numbers, which are a separate concern. The opposite data
   problem — an item carrying *two or more* different `P3151` values (an old iNaturalist
   taxon id left behind after a merge/split, say) — gets its own flag too (⚠ N iNat IDs —
   needs review), but deliberately no automated fix: this tool only ever proposes
   *additions*, and deciding which of several existing statements is the stale one to
   remove needs a curator checking iNaturalist directly, not a guess.
3. **Same QLever-first, WDQS-fallback pattern for sitelinks** — checks, for every
   resolved item, whether an `en`/`ja`/`es`/`pt` Wikipedia sitelink exists
   (`schema:about` / `schema:isPartOf`) — the "not listed" signal this dashboard exists
   to surface. Only taxa with *no* sitelink in any language get re-verified against live
   WDQS; a stale "missing" would wrongly send someone to write an article that already
   exists, which is precisely the failure this tool is supposed to prevent. A taxon
   missing just `ja`/`es`/`pt` isn't re-checked — species coverage in those languages is
   inherently sparse, so that "missing" is almost always simply true, and re-querying
   WDQS for every such partial case (most taxa, on a large project) is what was
   overloading it. The same "trust a match, re-check a miss" pattern
   (`sparqlFirstRowWithFallback`) also backs every other single-item Wikidata lookup in
   the app — the taxon-parent resolution and the project/user identity checks below.
4. **Comunica → Plazi TreatmentBank (QLever)** — a third batched query checks
   [SynoSpecies](https://synospecies.plazi.org)' own QLever mirror of Plazi's
   taxonomic treatments (`qlever.ld.plazi.org/sparql`) for how many published
   treatments exist per species (`dwc:genus` + `dwc:species`, joined via
   `treatment:augmentsTaxonConcept` / `definesTaxonConcept`). Coverage is narrow
   (only taxa with a digitized revision or original description) but precise —
   exact treatment title, DOI and author, shown on click.
5. **BHL literature (on demand)** — the "look up" button on each row runs a genuinely
   *federated* SPARQL query against a personal experimental Biodiversity Heritage
   Library knowledge graph (`koetai.semscape.org`): it starts in a named graph of BHL
   page metadata (Darwin Core terms), reaches out via `SERVICE` to QLever for the
   Wikidata item, and a nested `SERVICE` to WDQS for the sitelink — three sources,
   one query, nothing copied between them. That endpoint currently only has a handful
   of taxa loaded, so most lookups will correctly report no results — that's the
   knowledge graph's coverage, not a bug.
6. **Comunica → Wikimedia Commons (QLever)** — for taxa whose project-observation photo has a
   Commons-compatible license (`CC0`/`CC BY`/`CC BY-SA` — not the NC or ND variants), a batched
   query checks whether that exact iNaturalist photo is already on Commons: files sourced from
   iNaturalist carry a `P7482` ("source of file") statement whose `P973` ("described at URL")
   qualifier is the `inaturalist.org/photos/<id>` page, which is the join key. Already-uploaded
   files are linked directly and their filename fills the stub draft's infobox image.
   `schema:contentUrl` values from this endpoint sometimes carry a tracking query string
   (`?utm_source=commons.wikimedia.org&…`) after the real filename — `commonsFilenameFromUrl()`
   strips it before use; missing that produced a broken file link (found live, while building
   the image picker below, and fixed everywhere in this file that parses a `contentUrl`).
7. **Upload to Commons (on demand)** — for a compatible, not-yet-uploaded photo, opens a
   pre-filled `Special:Upload` form using upload-by-URL: `wpUploadFileURL` set to the iNaturalist
   photo, `wpLicense`/`wpDestFile`/`wpUploadDescription` pre-filled from the same data as the
   wikitext preview. This is the same mechanism (no OAuth, no backend) as
   [Tarsier](https://andrawaag.github.io/tarsier/), another WikiProject Biodiversity tool — it
   works because Commons fetches the file itself from a source host on its own live
   `MediaWiki:Copyupload-allowed-domains` allow-list, which this tool checks in real time before
   showing the button. iNaturalist's photo host (`inaturalist-open-data.s3.amazonaws.com`) is on
   that list today. You still need your own Wikimedia account and click "Upload file" on Commons
   yourself — nothing is uploaded automatically by this page.
8. **Draft a Wikipedia stub (on demand)** — click any red ✗ in the en/ja/es/pt columns.
   In the spirit of
   [taxonname-wpstubmaker](https://github.com/wikiproject-biodiversity/taxonname-wpstubmaker),
   it fetches the taxon's ancestor chain from iNaturalist and authorship/publication
   from GBIF, then fills in that language's species infobox (`{{Speciesbox}}` on
   English, `{{Ficha de taxón}}` on Spanish, `{{生物分類表}}` on Japanese,
   `{{Info/Taxonomia}}` on Portuguese) plus a lead sentence and `{{Taxonbar}}`. These are
   **drafts only** — nothing is ever posted to Wikipedia automatically; always review
   formatting, categories and notability before publishing.
   - **The lead sentence is never auto-cited to iNaturalist.** iNaturalist is
     user-generated/crowdsourced content and isn't accepted as a reliable source under
     Wikipedia's sourcing policy, so citing it as if it supports a factual claim would be
     wrong in a way a curator might not catch before publishing. It stays a
     `{{citation needed}}` marker (`{{cita requerida}}`/`{{要出典}}`/`{{carece de
     fontes}}` in the other languages) — `{{Taxonbar}}`, sourced from Wikidata, already
     covers the legitimate "here's the iNaturalist record" cross-reference. On the
     per-taxon curation page (item 11 below), a picker lets you swap in a real citation
     from this taxon's BHL literature instead (`leadCitationWikitext()`,
     `wikipediaStubPanel()`) — or paste your own URL or DOI directly. For a DOI, the item's
     citation gets built one of two ways: if the publication already has a Wikidata item
     (checked via `P356`, `fetchWikidataItemByDoi()`), the citation is `{{cite Q|Q...}}` —
     the actively-maintained successor to `{{cite doi}}` (a bot-maintained-subpage system
     deprecated around 2016), pulling the citation live from Wikidata's own statements. If
     not, Crossref's public API (`fetchCrossrefWork()`) fills in title/journal/year from
     just the DOI, cited with a plain `|doi=` parameter (never `|url=` to a doi.org
     redirect — that's what `|doi=` is for), and a QuickStatements draft to create the
     publication's own Wikidata item is offered alongside it (`buildPublicationQS()`) —
     title, `P356`, year, nothing more; like every other QuickStatements draft here, never
     run automatically.
   - **Stub drafting is gated on the Wikidata match actually being trustworthy**
     (`stubReadiness()`): an ambiguous match, a conflicted or unlinked iNaturalist id on
     the matched item all disable it — table ✗ badges render as plain, non-clickable spans
     (not buttons) and the curation page shows why instead of auto-drafting anything.
     Linking a new article to a Wikidata item this tool isn't confident is the right one
     would compound the underlying data problem rather than fix anything; each blocker is
     already surfaced (and fixable) elsewhere — the ambiguous pill, the conflict panel, the
     "link iNat ID" flow.
   - **A missing-article verdict isn't taken purely from the exact-P225 match.** Found
     live: *Bos taurus* — the strict taxon item, matched by name — has zero sitelinks,
     while the actual, 260-sitelink Wikipedia article is modelled on a separate "cattle"
     item carrying no `P225` at all, a real and not-uncommon Wikidata modelling pattern for
     well-known/domesticated species. An exact-name match can't bridge that gap on its own,
     so iNaturalist's own `taxon.wikipedia_url` — human-curated, already fetched, previously
     unused — is cross-checked per language (`inatWikipediaLangMatch()`); a match renders as
     an amber "?" badge (unconfirmed via Wikidata, not a plain ✓) rather than a false "missing."
     Separately, a stray Lexeme Sense entity was found matching a `wdt:P225` query
     live (`Bos taurus` again) and inflating the distinct-candidate count into a false
     "ambiguous" flag; `pushWikidataCandidate()` now only accepts `Q\d+`-shaped entities.
   - **A `==Taxonomy==` section**, built from cross-checking the classification
     (kingdom–genus) as reported *independently* by iNaturalist, GBIF, and NCBI Taxonomy
     (`compareTaxonomySources()`) — GBIF via `t.wikidata.gbif` when it's set, else a live
     name match same as the QuickStatements flow; NCBI via a fresh `esearch` + `esummary`
     lookup, since only the taxon id was fetched elsewhere in the app, not its lineage.
     Ranks only one source has an opinion on aren't a disagreement (there's nothing to
     compare), but a rank where two-plus sources genuinely differ — a real, fairly common
     occurrence between these three databases — is called out by name in its own
     paragraph instead of the stub silently picking one and hiding the discrepancy.
   - **An infobox image**, sourced from images already on Wikidata (`wdt:P18`) or Commons
     (structured-data "depicts", `wdt:P180`, pointing at the taxon's QID) via
     `fetchCandidateImages()` — an alternative to the observation-photo upload flow for a
     taxon that's already well documented, where re-uploading a duplicate would be pointless.
     Picking one, on the curation page's image selector panel, is what
     `commonsImageFilename()` checks first, ahead of a matched observation upload.
   - **A "first described by" sentence**, when GBIF's `authorship` field parses cleanly as
     `Author, Year` (`parseAuthority()`) — cited to GBIF's own `publishedIn` (the original
     describing publication) when available, since that's the actual source for this specific
     claim, not the generic lead sentence it used to be attached to.
9. **Propose QuickStatements (on demand)** — for a taxon with no Wikidata item (`t.wikidata ===
   null`), click "propose QuickStatements" to draft a
   [QuickStatements](https://quickstatements.toolforge.org/) v1 batch that would `CREATE` one:
   - `P31` taxon, `P105` rank (resolved live from Wikidata's own taxonomic-rank items rather than
     a hardcoded table — see `getTaxonomicRankQids()`), `P225` = the scientific name, plus a label
     in **both** `en` and `mul` (language-independent — taxon names don't vary by language, and an
     item with only one language label trips Wikidata's "label in language constraint"; `en`+`mul`
     is the same pattern this org's own `treatmentbot` uses on the taxa it creates).
   - `P3151` (iNaturalist taxon id), `P846` (GBIF backbone id, from a live `species/match` lookup)
     and `P685` (NCBI Taxonomy id, from a live `esearch` lookup scoped to `[scientific name]` so an
     ambiguous common name never silently matches the wrong lineage) — each only added when that
     database actually returned a confident match.
   - `P171` parent taxon, if the immediate parent (from iNaturalist's ancestor chain) has a Wikidata
     item. `resolveParentCandidates()` checks each lineage *independently* rather than trusting
     whichever answers first: GBIF's own id for that ancestor rank (`genusKey`/`familyKey`/… picked
     by the *child* taxon's rank, not the parent's — get this backwards and you silently resolve to
     the wrong ancestor, e.g. the family instead of the genus) joined against Wikidata's `P846`;
     the parent's name joined against `P225`; and NCBI's taxid for that same name joined against
     `P685`. When every lineage that resolved a parent lands on the *same* Wikidata item, **one**
     `P171` line is written, with every agreeing source as its own separate reference block —
     QuickStatements v1 needs the first reference's source prefixed `S248` and every one after it
     `!S248` (not `S248` again) to start a genuinely new block instead of merging into snaks of the
     first one; repeating the whole `LAST P171 …` line per source, which is what this did at first,
     instead creates duplicate statements (found by actually running a batch — see commit history).
     When lineages land on *different* items, `P171` is omitted and the panel names the discrepancy
     instead of guessing which database is right (a genuine cross-database disagreement, not
     something this tool should paper over).
   - Every derived claim carries a `stated in` (`P248`) reference back to whichever source actually
     supplied it — iNaturalist (Q16958215), GBIF (Q1531570) or NCBI (Q82494) — the same referencing
     convention used by
     [taxonname-wpstubmaker](https://github.com/wikiproject-biodiversity/taxonname-wpstubmaker)'s
     `taxon.py`.

   This drafts an edit; it never runs one. Paste the copied commands into QuickStatements
   yourself after reviewing them — in particular, QuickStatements' own duplicate-item warnings
   are the real safety net here, since this dashboard's own "not found" check is only an exact
   `P225` string match (see the synonym/splits caveat above).
10. **Is the project/user itself on Wikidata?** — a separate identity panel, unrelated to the
    per-taxon logic above, runs automatically (concurrently with the taxa pipeline) for whatever
    scope you entered:
    - **User**: checked against `P12022` (iNaturalist user ID) — values in the wild are a mix of
      login and numeric id, so both are checked in one query (see `checkUserOnWikidata()`). Not
      linked? If the iNaturalist profile has a public ORCID, that's checked against `P496` first
      (`findWikidataHumanByOrcid()`) — an ORCID match is about as reliable as an id match gets.
      Only without one does it fall back to a plain label search restricted to humans
      (`searchWikidataCandidates(name, {humansOnly: true})`), flagged as unverified.
    - **Project**: no dedicated Wikidata property exists for iNaturalist projects (checked). Real
      items instead link a project's iNaturalist URL via `P856` (official website — the common
      case) or occasionally `P973` (described at URL), so `checkProjectOnWikidata()` matches either.
      Not linked → an unrestricted label search only (no ORCID equivalent for projects).
    - Either way, the panel offers a QuickStatements draft: add the identifier/URL to a candidate
      item (`buildUserIdentityQS`/`buildProjectIdentityQS` with `mode: 'add'`), or `CREATE` a new
      item (`mode: 'create'` — `P31 Q5` human / `Q24577212` citizen science project). A new-human
      draft carries an explicit notability caution in its UI label: contributing to iNaturalist
      does not by itself make a person notable enough for a standalone Wikidata item.
11. **Per-taxon curation page** — click a taxon's name (in the table, or via
    `#taxon=<inatId>` directly — a real, bookmarkable URL hash) to open a single-taxon
    view with every outstanding action for it already built and shown, not click-to-reveal
    like the table (`renderTaxonDetail()`). Whichever single Wikidata action applies —
    propose a `CREATE`, add a missing `P3151`, or the iNat-id-conflict breakdown — and a
    drafted stub for every still-missing Wikipedia language render immediately, each with
    its own BHL-reference picker (fetched once per taxon, shared across every language's
    panel) to cite the lead sentence with something Wikipedia actually accepts instead of
    the default `{{citation needed}}`. The same row markup and the same delegated click
    handlers back both the table and this page
    (`buildTaxonRowCells()`; the handlers moved from `tbody`- to `document`-scoped clicks
    so they fire identically in either place) — no logic is duplicated between them.
    Resolving the hash still needs this run's own `currentTaxa` in memory (no backend to
    look a bare taxon id up against without a project/user already loaded), so a bookmarked
    link only resolves after loading a scope that actually contains that taxon.
12. **Synonymy & homonymy** — a panel on the curation page (`buildSynonymyInfo()`,
    `synonymyPanel()`), on-demand and per-taxon only; the lookups below don't scale to a
    batch of hundreds the way the rest of the pipeline does. RDF end to end, same
    federation spirit as everywhere else in this tool: GBIF's own SPARQL mirror on QLever
    (`qlever.dev/api/gbif`, Darwin Core RDF) instead of GBIF's REST API, Wikidata via
    QLever first with live WDQS as a fallback when QLever comes back empty
    (`sparqlAllRowsWithFallback()`, the same "trust a match, re-check a miss" reasoning as
    the bulk pipeline, generalized past just the first row).
    - **Synonyms**: every synonym GBIF records for the taxon's accepted usage
      (`fetchGbifSynonyms()`, via GBIF's `gbifv:acceptedNameUsage` — reversed, since that
      property points *from* a synonym record *to* its accepted one), cross-checked
      against Wikidata for an exact `P225` name match and, for any that resolve, whether
      it has a Wikipedia article and whether it's formally linked back with `P1420`
      ("taxon synonym", checked in both directions — which side carries the statement
      varies in practice) rather than just coincidentally sharing a name. Reports the
      count on each side (GBIF / also-on-Wikidata / with-a-Wikipedia-article). If the
      taxon itself has no Wikidata match but one of its synonyms resolves to an item that
      already has an article, that's flagged as a likely rescue — the taxon is probably
      already covered under a name Wikidata prefers, worth an alias rather than a new
      `CREATE`.
    - **Homonyms**: when the match is ambiguous (multiple Wikidata items share the exact
      scientific name — real homonymy, not the stray-Lexeme-Sense artifact already
      filtered out of candidate matching elsewhere), each candidate's own `P171` (parent
      taxon) chain is checked against what iNaturalist reports as this taxon's actual
      ancestry, up to three levels (parent/grandparent/great-grandparent, fetched in one
      query per candidate via nested `OPTIONAL`s rather than one round trip per level).
      The candidate whose chain reaches a known ancestor in the fewest hops is recommended
      as the likely correct one — an unrelated homonym from a different kingdom won't
      match within three hops at all. Advisory only, shown to the curator; never changes
      `t.wikidata` automatically.
13. **Bulk GBIF cross-check (opt-in)** — a "Cross-check against GBIF" button
    (`resolveGbifCrossCheck()`) that batches items 12's two checks across every currently
    loaded taxon at once — VALUES lists instead of one request per taxon, the same way the
    rest of the pipeline batches Wikidata — rather than the one-taxon-at-a-time queries
    the curation page's own panel runs. Deliberately not automatic: even batched, it's
    real added time on a large project, so it's its own button rather than folded into the
    main run.
    - **Multiple Wikipedia pages via synonymy** (`hasSynonymDuplication`, "Multiple WP
      (synonymy)" filter) — flags a taxon when more than one name for the same organism
      (its own, or a GBIF synonym) has its own separate Wikipedia article; a real
      "same species split across pages" risk worth a look, not merely informational.
    - **Wikidata classification vs GBIF** (`wikidataGbifMismatch`, "WD needs curation (vs
      GBIF)" filter) — flags a Wikidata item whose direct `P171` parent either doesn't
      exist at all, or disagrees with what GBIF reports at the equivalent rank
      (`GBIF_PARENT_NAME_FIELD`, mirroring `GBIF_PARENT_KEY_FIELD`'s existing rank→parent-rank
      mapping). Comparing a single hop only works because it's guarded: a disagreement is
      only flagged when the Wikidata parent's *own* rank is itself one of GBIF's six
      modelled ranks (kingdom/phylum/class/order/family/genus, checked via the same
      `getTaxonomicRankQids()` used for QuickStatements' `P105`) — found live, comparing
      unconditionally produced false positives whenever Wikidata modelled a finer
      intermediate rank GBIF's flat fields don't represent (*Indigofera*'s real `P171`
      parent is "Indigofereae", ranked *tribe* — entirely consistent with GBIF's family
      "Fabaceae", not a disagreement at all, but flagged as one before this guard was
      added). With the guard, the same test data correctly dropped from 6 flagged taxa to
      the 1 genuine case (a species Wikidata and GBIF's backbone place in different
      genera). The badge is clickable (`gbifMismatchDetail()`), not a hover-only tooltip —
      this app otherwise always expands a clicked badge into a persistent detail row, and a
      tooltip was the one place that didn't, which made the flag itself hard to act on.
      Expanding it shows the actual disagreement, a Wikidata search link either way, and —
      only for the "no `P171` at all" case — a safe QuickStatements addition if GBIF's
      expected parent resolves to exactly one Wikidata item. Deliberately not offered for
      an existing-but-disagreeing `P171`: adding a second value there would just create the
      same kind of multi-value conflict this tool already flags for `P3151` elsewhere
      (`inatIdConflictDetail`), not fix anything — that case needs a human correcting the
      existing statement on Wikidata directly.

      A second false-positive source, found the same way (a curator asking "is this
      actually a homonym?" about a live flag): more than one GBIF record can share the
      *exact same label* — "Cleome pallida" matches both the real accepted usage (genus
      *Cleome*) and an unrelated synonym record (genus *Dipterygium*, itself a synonym of a
      completely different species) that merely happens to carry the same label. `fetchGbifUsage`/
      `fetchGbifUsagesForNames` used to take whichever row an unordered SPARQL query
      returned first, which this time was the synonym — comparing Wikidata against the
      wrong genus. Both now prefer whichever row is itself the accepted usage
      (`taxonomicStatus`/absence of `acceptedNameUsage`) when a name matches more than one
      GBIF record, verified against these exact rows.

Query timings for the current run are logged live under the project input, in a small
scrolling panel — each step logs one aggregate line (batches, items, rows, elapsed time)
rather than one line per batch, so a large project (hundreds of taxa, dozens of batches
per step) doesn't turn it into an unscrollable wall of near-identical text.

### Known limitations (v1)

- Matching against Wikidata is by **exact scientific name string** (`wdt:P225`), with no
  synonym resolution. A taxon that iNaturalist has under a different name than Wikidata
  (synonyms, recent splits/lumps either side hasn't caught up to) won't resolve at all —
  `t.wikidata` stays `null`, and the "propose creating a new item" flow would offer to
  `CREATE` what might actually be a duplicate under a different name. `inatWikipediaLangMatch()`
  cross-checks iNaturalist's own `taxon.wikipedia_url` per language, but only *after* a
  taxon is already matched to a Wikidata item — it catches a missing-article false
  positive on an item this tool already found, not a missing *item* in the first place.
  The stated safety net for the create-draft case is QuickStatements' own duplicate-item
  warning, reviewed by a human before running — not synonym detection in this tool.
- Homonyms — the same scientific name attached to more than one Wikidata item — are
  resolved by preferring whichever item's `P3151` matches the iNaturalist taxon ID;
  ambiguous matches are flagged with a ⚠ in the Wikidata column.
- No OpenStreetMap integration yet. The eventual idea is to align observation
  localities with OSM places, but that's a per-observation, not per-taxon, alignment
  and needs its own query pattern.
- The Commons duplicate-check only looks at the **first photo of the first observation**
  per taxon, and only its license — it doesn't consider every photo across every
  observation of that taxon in the project.
- The upload-by-URL button only actually works while the photo's source host stays on
  Commons' allow-list, and only for the license types in `COMMONS_COMPATIBLE_LICENSES`
  (`app.js`) — if Commons ever removes iNaturalist's S3 host from the list, the button will
  correctly show "⚠ not on Commons' upload allow-list" rather than silently failing.
- Batching against QLever/WDQS is tuned for hackathon-scale projects, not a single
  iNaturalist user's entire life list. A user with thousands of observations (tested
  against one with ~2200 distinct taxa) can still trip QLever's own rate limit on the
  very first batch, and WDQS can time out even on the reduced "QLever missed this"
  subset the fallback sends it — both endpoints are public services this tool has no
  control over. `runBatchedStep` retries with backoff (longer, dedicated backoff
  specifically for a `429`, detected by string-matching the error text since Comunica
  exposes no structured status code) and paces successive batches 200ms apart, and
  `WDQS_BATCH_SIZE` (25, vs `BATCH_SIZE` 100 for QLever) sends WDQS smaller requests
  than QLever gets — but there's no amount of client-side pacing that guarantees a
  shared public endpoint responds quickly under someone else's load, or under this
  tool's own cumulative load from a long testing session. Worst case, a step logs its
  failure and moves on with whatever QLever alone already found (see the `catch` blocks
  in `resolveWikidata`/`resolveSitelinks`) rather than hanging. These retry-attempt and
  fallback-triggered lines log in amber (`log(msg, 'warn')`), not red — they're the tool
  successfully handling a slow/rate-limited public endpoint, not something broken. Red
  (`log(msg, 'err')`) is reserved for the run actually aborting. Given all that, a single
  upfront "the whole run will take N minutes" estimate would just be a guess dressed up
  as a number. Instead the status header shows which of the 5 pipeline steps is current
  (`Step 3/5: …`) plus, for whichever step is mid-batch, a live `batch 12/58 (~1m 40s
  remaining)` extrapolated from that step's own pace so far (`runBatchedStep`) — it
  self-corrects as the step runs rather than committing to a number before the step's
  actual speed (QLever-fast or WDQS-slow) is even known.
- One SPARQL batch per 100 taxa (`BATCH_SIZE` in `app.js`; 25 for WDQS specifically,
  `WDQS_BATCH_SIZE`); fine for hackathon-scale projects and tested against a single
  user's full observation history (~2,200 distinct taxa), but both remain public
  services this tool doesn't control — see the rate-limiting note above.

## Acknowledgements

This tool grew out of engagement with the Wikidata
[WikiProject Biodiversity](https://www.wikidata.org/wiki/Wikidata:WikiProject_Biodiversity)
and a series of consecutive hackathons — the [DBCLS BioHackathons](https://biohackathon.org/)
and [SWAT4HCLS](https://www.swat4hcls.org/). See
["BioHackJP24 report: Running a WikiBlitz"](https://doi.org/10.37044/osf.io/5ue2s_v1) for the
earlier work this dashboard builds on. The logo is
[Koetai](https://koetai.semscape.org)'s own Anableps mark.

## Files

- `index.html` — page structure
- `style.css` — styling (light/dark aware)
- `app.js` — all logic: iNaturalist fetch, Comunica queries, BHL/Plazi lookups, stub drafting, rendering
- `koetai-logo.svg` — header logo, from [koetai.semscape.org](https://koetai.semscape.org)
- `.claude/launch.json` — dev-server config used while building this in Claude Code
