# iNaturalist ↔ Wikidata / Wikipedia / GBIF / BHL dashboard

A static, client-side JavaScript tool that cross-references the taxa observed in an
[iNaturalist](https://www.inaturalist.org) project — or by a specific iNaturalist user —
against [Wikidata](https://www.wikidata.org), and flags which ones are still missing a
Wikipedia article in English, Japanese and/or Spanish. Inspired by
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
3. **Same QLever-first, WDQS-fallback pattern for sitelinks** — checks, for every
   resolved item, whether an `en`/`ja`/`es` Wikipedia sitelink exists
   (`schema:about` / `schema:isPartOf`) — the "not listed" signal this dashboard exists
   to surface. Only taxa with at least one missing language get re-verified against live
   WDQS; a stale "missing" would wrongly send someone to write an article that already
   exists, which is precisely the failure this tool is supposed to prevent. The same
   "trust a match, re-check a miss" pattern (`sparqlFirstRowWithFallback`) also backs
   every other single-item Wikidata lookup in the app — the taxon-parent resolution and
   the project/user identity checks below.
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
8. **Draft a Wikipedia stub (on demand)** — click any red ✗ in the en/ja/es columns.
   In the spirit of
   [taxonname-wpstubmaker](https://github.com/wikiproject-biodiversity/taxonname-wpstubmaker),
   it fetches the taxon's ancestor chain from iNaturalist and authorship/publication
   from GBIF, then fills in that language's species infobox (`{{Speciesbox}}` on
   English, `{{Ficha de taxón}}` on Spanish, `{{生物分類表}}` on Japanese) plus a lead
   sentence, a reference and `{{Taxonbar}}`. These are **drafts only** — nothing is
   ever posted to Wikipedia automatically; always review formatting, categories and
   notability before publishing.
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

Query timings for the current run are logged live under the project input, in a small
scrolling panel — each step logs one aggregate line (batches, items, rows, elapsed time)
rather than one line per batch, so a large project (hundreds of taxa, dozens of batches
per step) doesn't turn it into an unscrollable wall of near-identical text.

### Known limitations (v1)

- Matching against Wikidata is by **exact scientific name string** (`wdt:P225`). A
  taxon that iNaturalist has under a different name than Wikidata (synonyms, recent
  splits/lumps) won't resolve, even though iNaturalist itself may already link to an
  article under the old name (shown by iNaturalist's own `taxon.wikipedia_url`, which
  this tool doesn't yet cross-check).
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
- One SPARQL batch per 40 taxa; fine for hackathon-scale projects, untested at
  iNaturalist's largest project sizes (BATCH_SIZE in `app.js` is the place to tune
  this, alongside the `MAX_OBSERVATIONS` safety cap).

## Files

- `index.html` — page structure
- `style.css` — styling (light/dark aware)
- `app.js` — all logic: iNaturalist fetch, Comunica queries, BHL/Plazi lookups, stub drafting, rendering
- `.claude/launch.json` — dev-server config used while building this in Claude Code
