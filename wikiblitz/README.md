# WikiBlitz finder — species missing a Wikipedia article

➡️ **Live:** https://wikiproject-biodiversity.github.io/wikiblitz/

A single-page tool for Wikipedia curators: pick a **scope**, pick one or more **target
Wikipedia languages**, and get a worklist of species that have a **Wikidata item but no
article in that language edition** — ready to create or translate. Built to power
*wiki-blitzes* (focused editing events).

Everything runs live in the browser against public endpoints — no backend, no key, no login.

## Scopes

- **Taxon** — type a taxon (autocompleted from **iNaturalist**), resolved to the GBIF
  backbone; finds all accepted species under it.
- **Country** — pick a country; finds the species recorded there (GBIF occurrences),
  most-recorded first.
- **iNaturalist project** — search a project; pulls its observed species
  (`species_counts`) and maps them to Wikidata via the iNaturalist-taxon property (P3151).
- **iNaturalist user** — same, for one user's observed species.
- **Area (OSM)** — search an area (national park, region…) via **Nominatim**, combined
  with a **taxon** (required). Runs the spatial join on the `osm-planet` endpoint
  (which owns the indexed polygon), pulling in only that taxon's records for the area's
  **country** (a cheap pre-filter) and testing `geof:sfContains` against the polygon.
  Keep the taxon focused (a family/order); very large groups like all birds may time out.

## How "missing" is decided

For the scoped taxa, a single Wikidata (QLever) query checks, per item, whether a
sitelink to `https://<lang>.wikipedia.org/` exists (`schema:about` / `schema:isPartOf`,
restricted to `wikibase:wikiGroup "wikipedia"`). **Missing** = a Wikidata item exists
(via GBIF id P846 or iNat id P3151) but that sitelink does not. The query also fetches the
species image (P18) and the English / interface-language article titles, to power the
**Create** (red-link) and **Translate** (Special:ContentTranslation) buttons.

When a taxon has **no Wikidata image (P18)**, its card links to
[**Tarsier**](https://andrawaag.github.io/tarsier/) deep-linked by Wikidata id
(`?qid=…`) — so the curator lands ready to find an openly-licensed image and upload it to
Wikimedia Commons. (A missing article often comes with a missing image; this closes both
gaps in one workflow.)

## Data sources

| Source | Used for | Endpoint |
|--------|----------|----------|
| GBIF (RDF on QLever) | taxon descendants, country occurrences, in-area records | `https://qlever.dev/api/gbif` |
| Wikidata (QLever) | item, image, identifiers, article existence per language | `https://qlever.dev/api/wikidata` |
| OpenStreetMap (QLever) | area polygons for the spatial (in-area) scope | `https://qlever.dev/api/osm-planet` |
| iNaturalist API | taxon & project autocomplete, project species | `https://api.inaturalist.org/v1` |
| Nominatim | resolve an area name to an OSM relation + country | `https://nominatim.openstreetmap.org` |

## Multilingual & multi-target

The interface follows the browser language (en, nl, fr, de, es, it, pt; English
fallback) and can be switched. The **target** Wikipedia editions (where gaps are hunted)
are chosen as a set of language chips — check **several at once**; a taxon is listed when
it lacks an article in **at least one** chosen language, and each card shows a per-language
✓ (exists) / ✎ (create-link) chip. The summary breaks the gap count down per language.

## Worklist export

**Copy worklist** puts a Markdown table on the clipboard — one row per taxon, a column
per chosen language, ✅ where an article exists and a clickable ❌ create-link where it's
missing — ready to paste into an event/blitz page. (Format modelled on iNotListed's report.)

## Notes / limits

- Each scope is capped (250 taxa; iNat projects 200) for responsiveness; the summary says
  when it was capped. Pick a narrower taxon / smaller scope for full coverage.
- **Area (OSM) requires a taxon** and works by pre-filtering GBIF to the area's country
  before the polygon test. This is necessary: an *unfiltered* "all taxa inside a polygon"
  cross-endpoint GeoSPARQL join took ~100 s in testing (QLever can't share a spatial index
  across the gbif and osm-planet endpoints). The country pre-filter brings a focused taxon
  down to a few seconds. Multi-country areas are limited to the area's primary country.

## Credits & related

- Inspired by **[iNotListed](https://codeberg.org/wikiproject-biodiversity/iNotListed)**
  (WikiProject Biodiversity) — a CLI that finds missing Wikipedia articles from iNaturalist
  + Wikidata. This app borrows its multi-language report idea and adds GBIF taxon/country
  and OSM-area scopes, a live browser UI, images and create/translate links.
- Companion app: [EU invasive-species spread](https://www.micelio.be/eu-invasive-spread-gbif/)
  ([repo](https://github.com/Micelio/eu-invasive-spread-gbif)). Same GBIF×QLever stack.
