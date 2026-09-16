# iNaturalist ↔ Wikidata / Wikipedia / GBIF / BHL dashboard

A static, client-side JavaScript tool that cross-references the taxa observed in an
[iNaturalist](https://www.inaturalist.org) project against
[Wikidata](https://www.wikidata.org), and flags which ones are still missing a
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

Then open <http://localhost:8734/>, confirm/change the project slug (defaults to
`biohackathon-2026`), and click **Load observations**.

## How it works

1. **iNaturalist REST API** — paginates through every observation in the project and
   collects the distinct taxa (scientific name, common name, photo, observation count).
2. **Comunica → [QLever](https://qlever.cs.uni-freiburg.de/wikidata)'s Wikidata
   mirror** — resolves each scientific name to a Wikidata item (`wdt:P225`) and reads
   off cross-reference identifiers already stored there: GBIF (`P846`), iNaturalist
   taxon (`P3151`), Wikimedia Commons category (`P373`). QLever is used here instead of
   the official Wikidata Query Service because it comfortably handles a `VALUES` list
   of dozens of names in well under a second.
3. **Comunica → Wikidata Query Service** — a second query checks, for every resolved
   item, whether an `en`/`ja`/`es` Wikipedia sitelink exists
   (`schema:about` / `schema:isPartOf`). Anything missing is the "not listed" signal
   the dashboard highlights.
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
6. **Draft a Wikipedia stub (on demand)** — click any red ✗ in the en/ja/es columns.
   In the spirit of
   [taxonname-wpstubmaker](https://github.com/wikiproject-biodiversity/taxonname-wpstubmaker),
   it fetches the taxon's ancestor chain from iNaturalist and authorship/publication
   from GBIF, then fills in that language's species infobox (`{{Speciesbox}}` on
   English, `{{Ficha de taxón}}` on Spanish, `{{生物分類表}}` on Japanese) plus a lead
   sentence, a reference and `{{Taxonbar}}`. These are **drafts only** — nothing is
   ever posted to Wikipedia automatically; always review formatting, categories and
   notability before publishing.

Query timings for the current run are logged live under the project input.

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
- Wikimedia Commons is currently just a category link (`P373`); a media-preview panel
  (via the Commons SPARQL endpoint or the MediaWiki API) is a natural next step.
- One SPARQL batch per 40 taxa; fine for hackathon-scale projects, untested at
  iNaturalist's largest project sizes (BATCH_SIZE in `app.js` is the place to tune
  this, alongside the `MAX_OBSERVATIONS` safety cap).

## Files

- `index.html` — page structure
- `style.css` — styling (light/dark aware)
- `app.js` — all logic: iNaturalist fetch, Comunica queries, BHL/Plazi lookups, stub drafting, rendering
- `.claude/launch.json` — dev-server config used while building this in Claude Code
