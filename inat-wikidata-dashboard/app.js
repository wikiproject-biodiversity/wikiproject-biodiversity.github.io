// iNaturalist × Wikidata/Wikipedia/GBIF/BHL dashboard
// All client-side. SPARQL federation via Comunica (https://comunica.dev).

const INAT_API = 'https://api.inaturalist.org/v1';
const QLEVER_ENDPOINT = 'https://qlever.dev/api/wikidata';
const WDQS_ENDPOINT = 'https://query.wikidata.org/sparql';
const BHL_ENDPOINT = 'https://koetai.semscape.org/u/0000-0001-9773-4008/bhl/sparql';
const PLAZI_ENDPOINT = 'https://qlever.ld.plazi.org/sparql'; // SynoSpecies' QLever mirror of Plazi TreatmentBank
const COMMONS_ENDPOINT = 'https://qlever.dev/api/wikimedia-commons'; // QLever's Wikimedia Commons structured-data mirror
const GBIF_ENDPOINT = 'https://qlever.dev/api/gbif'; // QLever's GBIF backbone mirror (Darwin Core RDF), used for synonym/homonym lookups

// iNaturalist license codes that are actually reusable on Commons (public domain / attribution-only).
// cc-by-nc, cc-by-nd, cc-by-nc-sa, cc-by-nc-nd and "all rights reserved" (null) are NOT Commons-compatible.
// `template` is for the wikitext preview; `wpLicense` is the exact key Special:Upload's license
// dropdown expects (same values used by github.com/andrawaag/andrawaag.github.io's Tarsier tool).
const COMMONS_COMPATIBLE_LICENSES = {
  'cc0': { template: '{{cc-zero}}', wpLicense: 'Cc-zero' },
  'cc-by': { template: '{{cc-by-4.0}}', wpLicense: 'cc-by-4.0' },
  'cc-by-sa': { template: '{{cc-by-sa-4.0}}', wpLicense: 'cc-by-sa-4.0' },
};

const LANGS = [
  { code: 'en', wiki: 'https://en.wikipedia.org/' },
  { code: 'ja', wiki: 'https://ja.wikipedia.org/' },
  { code: 'es', wiki: 'https://es.wikipedia.org/' },
  { code: 'pt', wiki: 'https://pt.wikipedia.org/' },
];

const BATCH_SIZE = 100; // VALUES lists this size run in well under 200ms on QLever (tested); bigger batches means fewer requests, which matters more than batch size for staying under a public endpoint's rate limit
const WDQS_BATCH_SIZE = 25; // WDQS itself, not just QLever, evidently struggles with 100-item VALUES lists under current load (observed timing out even on the already-reduced "misses only" re-check set) — smaller requests to the one endpoint this tool can't avoid entirely
const MAX_OBSERVATIONS = 5000; // safety cap for a single run

let comunicaEngine = null;

async function getEngine() {
  if (!comunicaEngine) {
    const { QueryEngine } = await import('https://cdn.jsdelivr.net/npm/@comunica/query-sparql@5.4.1/+esm');
    comunicaEngine = new QueryEngine();
  }
  return comunicaEngine;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Run a SPARQL SELECT via Comunica against a well-behaved SPARQL endpoint
// (one that returns proper application/sparql-results+json), with retry/backoff.
async function sparqlViaComunica(query, endpoint, { retries = 3, label = '', silent = false } = {}) {
  const engine = await getEngine();
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const t0 = performance.now();
    try {
      const bindingsStream = await engine.queryBindings(query, {
        sources: [{ type: 'sparql', value: endpoint }],
        httpTimeout: 15000,
      });
      const rows = await bindingsStream.toArray();
      const out = rows.map(b => {
        const o = {};
        for (const [k, v] of b) o[k.value] = v.value;
        return o;
      });
      if (!silent) log(`${label || endpoint} — ${out.length} rows in ${Math.round(performance.now() - t0)}ms`);
      return out;
    } catch (e) {
      lastErr = e;
      // Always logged, even when silent: a failed/retried batch is exactly the kind of
      // thing the aggregate summary line (logged by the caller) would otherwise hide.
      log(`${label || endpoint} — attempt ${attempt + 1} failed: ${e.message}`, 'warn');
      if (attempt < retries) {
        // A 429 means "you're going too fast", not "try again in a moment" — backing off
        // on the same short schedule as a generic timeout just trips it again on the next
        // batch. Comunica surfaces the status in the error text (there's no structured
        // code to read), so detect it there and wait substantially longer.
        const isRateLimited = /\b429\b/.test(e.message);
        await sleep(isRateLimited ? 4000 * (attempt + 1) : 800 * (attempt + 1));
      }
    }
  }
  throw lastErr;
}

// Runs `fn` once per chunk of `items` (each call gets that chunk's array), keeping every
// per-batch SPARQL log line silent, then logs ONE aggregate line for the whole step —
// large projects can mean dozens of batches per step, and a line each turns the log into
// an unscrollable wall of near-identical text. `fn` returns the row count for its batch.
async function runBatchedStep(items, label, fn, batchSize = BATCH_SIZE) {
  const batches = chunk(items, batchSize);
  const t0 = performance.now();
  let totalRows = 0;
  for (let i = 0; i < batches.length; i++) {
    totalRows += await fn(batches[i]);
    const done = i + 1;
    // Estimated from THIS step's own pace so far, not a fixed guess — a batch to QLever
    // and a batch to WDQS cost wildly different amounts, and WDQS's own cost swings with
    // live load, so the only honest estimate is one that corrects itself as the step
    // actually runs. Only shown once there's more than one batch to make it worth showing.
    if (batches.length > 1) {
      const elapsed = performance.now() - t0;
      const remaining = batches.length - done;
      const etaMs = (elapsed / done) * remaining;
      setStatusProgress(`batch ${done}/${batches.length}${remaining > 0 ? ` (~${formatDuration(etaMs)} remaining)` : ''}`);
    }
    // A short gap between requests, not just within retries of one — a public endpoint's
    // rate limit is usually requests-per-window, and firing dozens of successful batches
    // back to back (each takes well under a second) can look like a burst even with no
    // single request being slow. Skipped after the last batch so it doesn't pad the tail.
    if (i < batches.length - 1) await sleep(200);
  }
  const n = batches.length;
  log(`${label} — ${n} batch${n === 1 ? '' : 'es'}, ${items.length} item${items.length === 1 ? '' : 's'}, ${totalRows} row${totalRows === 1 ? '' : 's'}, ${Math.round(performance.now() - t0)}ms`);
  return totalRows;
}

function formatDuration(ms) {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 5) return 'a few seconds';
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

// Plain SPARQL-over-HTTP fetch, for endpoints whose Content-Type header
// doesn't match what Comunica's result parser expects (application/json
// instead of application/sparql-results+json) even though the body is
// valid SPARQL JSON results.
async function sparqlViaFetch(query, endpoint, { label = '' } = {}) {
  const t0 = performance.now();
  const url = `${endpoint}?query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Accept: 'application/sparql-results+json' } });
  if (!res.ok) throw new Error(`${label || endpoint} HTTP ${res.status}`);
  const json = await res.json();
  const rows = (json.results && json.results.bindings) || [];
  const out = rows.map(b => {
    const o = {};
    for (const k of Object.keys(b)) o[k] = b[k].value;
    return o;
  });
  log(`${label || endpoint} — ${out.length} rows in ${Math.round(performance.now() - t0)}ms`);
  return out;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sparqlStringLiteral(s) {
  return JSON.stringify(s);
}

// "Genus species" or "Genus species subspecies" -> { genus, species }. Returns null
// for anything not shaped like a binomial (genus-only, family/order/subfamily names).
function splitBinomial(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2 && /^[a-z]/.test(parts[1])) {
    return { genus: parts[0], species: parts[1] };
  }
  return null;
}

// ---------- iNaturalist ----------

// scopeType: 'project' (iNaturalist project slug/id) or 'user' (iNaturalist login/id) —
// both accept either a slug/login string or a numeric id interchangeably via the same
// REST param shape (project_id= / user_id=), so this only needs to pick the param name.
async function fetchScopedTaxa(scopeType, scopeValue, onProgress) {
  const param = scopeType === 'user' ? 'user_id' : 'project_id';
  const noun = scopeType === 'user' ? 'user' : 'project';
  const observations = [];
  let page = 1;
  const perPage = 200;
  while (observations.length < MAX_OBSERVATIONS) {
    const url = `${INAT_API}/observations?${param}=${encodeURIComponent(scopeValue)}&per_page=${perPage}&page=${page}&order_by=id`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`iNaturalist API HTTP ${res.status} (is "${scopeValue}" a valid ${noun} ${scopeType === 'user' ? 'login/id' : 'slug/id'}?)`);
    const json = await res.json();
    if (page === 1 && json.total_results === 0) {
      throw new Error(`No observations found for ${noun} "${scopeValue}".`);
    }
    observations.push(...json.results);
    onProgress(observations.length, json.total_results);
    if (observations.length >= json.total_results || json.results.length === 0) break;
    page++;
    await sleep(150); // be polite to the API
  }

  const byTaxon = new Map();
  for (const obs of observations) {
    const t = obs.taxon;
    if (!t || !t.name) continue;
    if (!byTaxon.has(t.id)) {
      byTaxon.set(t.id, {
        inatId: t.id,
        name: t.name,
        commonName: t.preferred_common_name || '',
        rank: t.rank,
        photo: t.default_photo ? t.default_photo.square_url : null,
        inatWikipediaUrl: t.wikipedia_url || null,
        obsCount: 0,
        obsPhoto: null, // first Commons-relevant photo actually attached to a matching observation
      });
    }
    const entry = byTaxon.get(t.id);
    entry.obsCount++;
    if (!entry.obsPhoto && obs.photos && obs.photos.length) {
      const p = obs.photos[0];
      entry.obsPhoto = {
        photoId: p.id,
        licenseCode: p.license_code, // null = "all rights reserved", not usable
        squareUrl: p.url,
        originalUrl: p.url ? p.url.replace(/\/(square|small|medium|large)\./, '/original.') : null,
        attribution: p.attribution || '',
        observerLogin: obs.user ? obs.user.login : '',
        obsUri: obs.uri,
        inatPhotoUrl: `https://www.inaturalist.org/photos/${p.id}`,
      };
    }
  }
  return [...byTaxon.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- Wikidata resolution ----------

// wdt:P225 is meant to live only on ordinary items (Q...), but SPARQL happily matches
// any entity with that predicate — including, found live on a real query (Bos taurus),
// a stray Lexeme Sense (L...-S...). That's not a competing taxon item, just noise that
// would otherwise inflate the distinct-QID count and trip a false "ambiguous" flag.
function pushWikidataCandidate(byName, r) {
  if (!/\/Q\d+$/.test(r.wdTaxon)) return;
  const list = byName.get(r.taxonLabel) || [];
  list.push({
    qid: r.wdTaxon.split('/').pop(),
    uri: r.wdTaxon,
    gbif: r.gbif || null,
    inat: r.inat || null,
    commonsCat: r.commonsCat || null,
  });
  byName.set(r.taxonLabel, list);
}

async function resolveWikidata(taxa) {
  const byName = new Map();
  await runBatchedStep(taxa, 'Wikidata lookup (QLever)', async (batch) => {
    const values = batch.map(t => sparqlStringLiteral(t.name)).join(' ');
    const query = `PREFIX wdt: <http://www.wikidata.org/prop/direct/>
SELECT ?taxonLabel ?wdTaxon ?gbif ?inat ?commonsCat WHERE {
  VALUES ?taxonLabel { ${values} }
  ?wdTaxon wdt:P225 ?taxonLabel .
  OPTIONAL { ?wdTaxon wdt:P846 ?gbif }
  OPTIONAL { ?wdTaxon wdt:P3151 ?inat }
  OPTIONAL { ?wdTaxon wdt:P373 ?commonsCat }
}`;
    const rows = await sparqlViaComunica(query, QLEVER_ENDPOINT, { silent: true });
    for (const r of rows) pushWikidataCandidate(byName, r);
    return rows.length;
  });

  // QLever's Wikidata mirror is a periodic dump import (observed ~6 weeks stale on
  // 2026-09-19, via wikibase:Dump schema:dateModified) — fine for a match (an item
  // that existed 6 weeks ago still exists), useless as proof of absence. A taxon QLever
  // found nothing for might just be too recent for the snapshot, and mistaking that for
  // "not on Wikidata" is exactly the failure mode that would make the QuickStatements
  // "propose creating a new item" flow draft a duplicate — so re-check only the misses,
  // against live WDQS, rather than trusting a negative from a stale copy.
  const unmatched = taxa.filter(t => !(byName.get(t.name) || []).length);
  if (unmatched.length) {
    try {
      await runBatchedStep(unmatched, 'Wikidata lookup — re-checking QLever misses against live WDQS', async (batch) => {
        const values = batch.map(t => sparqlStringLiteral(t.name)).join(' ');
        const query = `PREFIX wdt: <http://www.wikidata.org/prop/direct/>
SELECT ?taxonLabel ?wdTaxon ?gbif ?inat ?commonsCat WHERE {
  VALUES ?taxonLabel { ${values} }
  ?wdTaxon wdt:P225 ?taxonLabel .
  OPTIONAL { ?wdTaxon wdt:P846 ?gbif }
  OPTIONAL { ?wdTaxon wdt:P3151 ?inat }
  OPTIONAL { ?wdTaxon wdt:P373 ?commonsCat }
}`;
        // retries: 1 (not the default 3) — this is a best-effort re-check with a safe
        // fallback (keep QLever's answer) right below, so it's not worth burning up to
        // a minute-plus per stuck batch retrying the one endpoint that's already struggling.
        const rows = await sparqlViaComunica(query, WDQS_ENDPOINT, { silent: true, retries: 1 });
        for (const r of rows) pushWikidataCandidate(byName, r);
        return rows.length;
      }, WDQS_BATCH_SIZE);
    } catch (e) {
      log(`WDQS re-check failed (${e.message}) — keeping QLever's ${unmatched.length} unmatched as-is`, 'warn');
    }
  }

  for (const t of taxa) {
    const candidates = byName.get(t.name) || [];
    // The query's OPTIONAL joins (gbif/inat/commonsCat) each produce one row per VALUE,
    // so a single item with e.g. two P3151 statements (an old + current iNaturalist
    // taxon id both left on it) comes back as two rows for the same QID — not two
    // competing items. Count distinct QIDs, not rows, or that shows up as a false
    // "ambiguous" on an item that isn't ambiguous at all.
    const distinctQids = [...new Set(candidates.map(c => c.qid))];
    let chosen = null;
    let ambiguous = false;
    let inatIdConflict = null;
    if (distinctQids.length === 1) {
      chosen = candidates.find(c => c.inat === String(t.inatId)) || candidates[0];
      // Unlike the row-count artifact above, genuinely distinct P3151 *values* on the
      // one item are a real data problem — an old and current iNaturalist taxon id both
      // left on it, say — worth a curator's attention even though this tool can't safely
      // guess which one to remove.
      const distinctInatValues = [...new Set(candidates.map(c => c.inat).filter(Boolean))];
      if (distinctInatValues.length > 1) inatIdConflict = distinctInatValues;
    } else if (distinctQids.length > 1) {
      chosen = candidates.find(c => c.inat === String(t.inatId)) || candidates[0];
      ambiguous = true;
    }
    t.wikidata = chosen;
    t.wikidataAmbiguous = ambiguous;
    t.wikidataCandidateCount = distinctQids.length;
    t.wikidataCandidateQids = distinctQids;
    t.wikidataInatIdConflict = inatIdConflict;
  }
  return taxa;
}

// ---------- Wikipedia sitelinks ----------

function sitelinkQuery(values, selectVars, optionals) {
  return `PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX schema: <http://schema.org/>
SELECT ?wdTaxon ${selectVars} WHERE {
  VALUES ?wdTaxon { ${values} }
  ${optionals}
}`;
}

async function resolveSitelinks(taxa) {
  const withWd = taxa.filter(t => t.wikidata);
  const optionals = LANGS.map(l =>
    `OPTIONAL { ?article_${l.code} schema:about ?wdTaxon ; schema:isPartOf <${l.wiki}> . }`
  ).join('\n  ');
  const selectVars = LANGS.map(l => `?article_${l.code}`).join(' ');

  const byQid = new Map();
  // QLever primary (fast, avoids WDQS's rate-limiting under this tool's batch load).
  await runBatchedStep(withWd, 'Wikipedia sitelinks (QLever)', async (batch) => {
    const values = batch.map(t => `wd:${t.wikidata.qid}`).join(' ');
    const rows = await sparqlViaComunica(sitelinkQuery(values, selectVars, optionals), QLEVER_ENDPOINT, { silent: true });
    for (const r of rows) {
      const qid = r.wdTaxon.split('/').pop();
      const langs = {};
      for (const l of LANGS) langs[l.code] = r[`article_${l.code}`] || null;
      byQid.set(qid, langs);
    }
    return rows.length;
  });

  // Same staleness reasoning as resolveWikidata: a sitelink QLever found is still
  // real, but "no sitelink" from a ~6-week-old snapshot could just mean the Wikipedia
  // article was written more recently than that — precisely the false negative this
  // tool exists to avoid (it would tell someone to write an article that already
  // exists). Re-verify only QIDs with NO sitelink in any language — that's the case
  // staleness would actually flip. A QID with, say, an en article but no ja/es one
  // isn't a staleness artifact to re-check: ja/es coverage of species is inherently
  // sparse, so "missing" there is almost always just true, and re-querying WDQS for
  // every such partial case (most large projects' taxa) is what was overloading it.
  const toRecheck = withWd.filter(t => {
    const langs = byQid.get(t.wikidata.qid);
    return !langs || LANGS.every(l => !langs[l.code]);
  });
  if (toRecheck.length) {
    try {
      await runBatchedStep(toRecheck, 'Wikipedia sitelinks — re-checking QLever misses against live WDQS', async (batch) => {
        const values = batch.map(t => `wd:${t.wikidata.qid}`).join(' ');
        const rows = await sparqlViaComunica(sitelinkQuery(values, selectVars, optionals), WDQS_ENDPOINT, { silent: true, retries: 1 });
        for (const r of rows) {
          const qid = r.wdTaxon.split('/').pop();
          const langs = {};
          for (const l of LANGS) langs[l.code] = r[`article_${l.code}`] || null;
          byQid.set(qid, langs);
        }
        return rows.length;
      }, WDQS_BATCH_SIZE);
    } catch (e) {
      log(`WDQS re-check failed (${e.message}) — keeping QLever's answer for ${toRecheck.length} taxa as-is`, 'warn');
    }
  }

  for (const t of withWd) {
    t.wikipedia = byQid.get(t.wikidata.qid) || Object.fromEntries(LANGS.map(l => [l.code, null]));
  }
  return taxa;
}

// ---------- Plazi TreatmentBank ----------

// Batch step: how many published treatments exist per species. Only taxa whose
// scientific name looks like a binomial are checked (Plazi's TaxonConcepts are
// keyed on dwc:genus + dwc:species, not a combined scientificName literal).
async function resolvePlazi(taxa) {
  const binomial = taxa
    .map(t => ({ t, split: splitBinomial(t.name) }))
    .filter(x => x.split);

  const counts = new Map(); // "Genus|species" -> count
  await runBatchedStep(binomial, 'Plazi treatments', async (batch) => {
    const values = batch.map(x => `(${sparqlStringLiteral(x.split.genus)} ${sparqlStringLiteral(x.split.species)})`).join(' ');
    const query = `PREFIX dwc: <http://rs.tdwg.org/dwc/terms/>
PREFIX treatment: <http://plazi.org/vocab/treatment#>
SELECT ?genus ?species (COUNT(DISTINCT ?t) AS ?n) WHERE {
  VALUES (?genus ?species) { ${values} }
  ?tc dwc:genus ?genus ; dwc:species ?species .
  ?t (treatment:augmentsTaxonConcept|treatment:definesTaxonConcept) ?tc .
}
GROUP BY ?genus ?species`;
    const rows = await sparqlViaComunica(query, PLAZI_ENDPOINT, { silent: true });
    for (const r of rows) counts.set(`${r.genus}|${r.species}`, parseInt(r.n, 10));
    return rows.length;
  });

  const binomialSet = new Set(binomial.map(x => x.t));
  for (const t of taxa) {
    if (!binomialSet.has(t)) {
      t.plaziCount = null; // rank not supported (genus/family/order/subfamily name)
      continue;
    }
    const split = binomial.find(x => x.t === t).split;
    t.plaziGenusSpecies = split;
    t.plaziCount = counts.get(`${split.genus}|${split.species}`) || 0;
  }
  return taxa;
}

// On-demand: the actual treatment titles/DOIs/authors for one species.
async function fetchPlaziDetail(genus, species) {
  const query = `PREFIX dwc: <http://rs.tdwg.org/dwc/terms/>
PREFIX treatment: <http://plazi.org/vocab/treatment#>
PREFIX dc: <http://purl.org/dc/elements/1.1/>
SELECT DISTINCT ?t ?title ?doi ?creator WHERE {
  ?tc dwc:genus ${sparqlStringLiteral(genus)} ; dwc:species ${sparqlStringLiteral(species)} .
  ?t (treatment:augmentsTaxonConcept|treatment:definesTaxonConcept) ?tc .
  OPTIONAL { ?t dc:title ?title }
  OPTIONAL { ?t treatment:publishedIn ?doi }
  OPTIONAL { ?t dc:creator ?creator }
}
LIMIT 20`;
  return sparqlViaComunica(query, PLAZI_ENDPOINT, { label: `Plazi detail for "${genus} ${species}"` });
}

// ---------- Wikimedia Commons (license check + duplicate check) ----------

// Batch step: for every taxon with a Commons-compatible observation photo, check
// whether that exact iNaturalist photo has already been uploaded to Commons. Files
// sourced from iNaturalist carry a "source of file" (P7482) statement whose
// "described at URL" (P973) qualifier is the https://www.inaturalist.org/photos/<id>
// page — that's the join key.
async function resolveCommonsStatus(taxa) {
  const candidates = taxa.filter(t => t.obsPhoto && COMMONS_COMPATIBLE_LICENSES[t.obsPhoto.licenseCode]);
  if (candidates.length === 0) return taxa;

  const existing = new Map(); // inatPhotoUrl -> { entity, pageUrl }
  await runBatchedStep(candidates, 'Commons duplicate check', async (batch) => {
    const values = batch.map(t => `<${t.obsPhoto.inatPhotoUrl}>`).join(' ');
    const query = `PREFIX p: <http://www.wikidata.org/prop/>
PREFIX pq: <http://www.wikidata.org/prop/qualifier/>
PREFIX schema: <http://schema.org/>
SELECT ?url ?file ?contentUrl WHERE {
  VALUES ?url { ${values} }
  ?file p:P7482 ?stmt ;
        schema:contentUrl ?contentUrl .
  ?stmt pq:P973 ?url .
}`;
    const rows = await sparqlViaComunica(query, COMMONS_ENDPOINT, { silent: true });
    for (const r of rows) {
      const filename = commonsFilenameFromUrl(r.contentUrl);
      existing.set(r.url, { entity: r.file, pageUrl: `https://commons.wikimedia.org/wiki/File:${filename}` });
    }
    return rows.length;
  });

  for (const t of candidates) {
    t.obsPhoto.commonsFile = existing.get(t.obsPhoto.inatPhotoUrl) || null;
  }
  return taxa;
}

function suggestedCommonsFilename(t) {
  const safe = t.name.replace(/[\[\]{}|#<>]/g, '').trim();
  return `${safe} - iNaturalist ${t.obsPhoto.photoId}.jpg`;
}

function commonsDescription(t) {
  const p = t.obsPhoto;
  const wdRef = t.wikidata ? ` ([[:d:${t.wikidata.qid}]])` : '';
  return `${t.name}${t.commonName ? ` (${t.commonName})` : ''}, from iNaturalist observation ${p.obsUri}${wdRef}`;
}

function buildCommonsWikitext(t) {
  const p = t.obsPhoto;
  const licenseTemplate = COMMONS_COMPATIBLE_LICENSES[p.licenseCode].template;
  const category = t.wikidata && t.wikidata.commonsCat ? t.wikidata.commonsCat : t.name;
  const gbifBlock = t.wikidata && t.wikidata.gbif ? `\n{{Gbif|${t.wikidata.gbif}}}` : '';
  return `=={{int:filedesc}}==
{{Information
| description = {{en|1=${commonsDescription(t)}}}
| date        =
| source      = [${p.inatPhotoUrl} iNaturalist photo ${p.photoId}]
| author      = [https://www.inaturalist.org/people/${encodeURIComponent(p.observerLogin)} ${p.observerLogin}] (via iNaturalist, ${p.attribution})
| permission  =
| other versions =
}}

=={{int:license-header}}==
${licenseTemplate}

[[Category:${category}]]${gbifBlock}
<!-- DRAFT — review author/license/category before uploading. Not uploaded automatically. -->`;
}

// Same Special:Upload prefill pattern used by Tarsier (github.com/andrawaag/andrawaag.github.io/tree/main/tarsier):
// upload-by-URL works without OAuth as long as the source host is on Commons' live
// copy-upload domain allow-list, which we check separately (see commonsDomainStatus).
function buildCommonsUploadUrl(t) {
  const p = t.obsPhoto;
  const category = t.wikidata && t.wikidata.commonsCat ? t.wikidata.commonsCat : t.name;
  const desc = `{{Information\n` +
    `|description={{en|1=${commonsDescription(t)}}}\n` +
    `|date=\n` +
    `|source=[${p.inatPhotoUrl} iNaturalist photo ${p.photoId}]\n` +
    `|author=[https://www.inaturalist.org/people/${encodeURIComponent(p.observerLogin)} ${p.observerLogin}] (via iNaturalist, ${p.attribution})\n` +
    `|permission=\n|other versions=\n}}\n\n` +
    `[[Category:${category}]]\n`;
  return 'https://commons.wikimedia.org/wiki/Special:Upload' +
    `?wpUploadDescription=${encodeURIComponent(desc)}` +
    `&wpLicense=${encodeURIComponent(COMMONS_COMPATIBLE_LICENSES[p.licenseCode].wpLicense)}` +
    `&wpDestFile=${encodeURIComponent(suggestedCommonsFilename(t))}` +
    `&wpSourceType=url` +
    `&wpUploadFileURL=${encodeURIComponent(p.originalUrl)}`;
}

// Live check against Commons' MediaWiki:Copyupload-allowed-domains — upload-by-URL only
// actually works from a host on this list; cached for the session since it rarely changes.
let commonsDomainListPromise = null;
function loadCommonsDomainList() {
  if (!commonsDomainListPromise) {
    commonsDomainListPromise = fetch('https://commons.wikimedia.org/w/api.php?action=query&prop=revisions' +
      '&titles=MediaWiki:Copyupload-allowed-domains&rvprop=content&rvslots=main&format=json&formatversion=2&origin=*')
      .then(r => r.json())
      .then(d => {
        const txt = d.query.pages[0].revisions[0].slots.main.content;
        return txt.split('\n').map(l => l.replace(/#.*/, '').trim()).filter(l => l && l[0] !== '<');
      })
      .catch(() => { commonsDomainListPromise = null; throw new Error('domain list unavailable'); });
  }
  return commonsDomainListPromise;
}
function domainMatches(host, pattern) {
  pattern = pattern.toLowerCase();
  if (host === pattern) return true;
  if (pattern.startsWith('*.') && host === pattern.slice(2)) return true;
  const rx = '^' + pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^.]+') + '$';
  try { return new RegExp(rx).test(host); } catch (e) { return false; }
}
async function isCommonsUploadDomainAllowed(host) {
  const list = await loadCommonsDomainList();
  return list.some(p => domainMatches(host, p));
}

// ---------- BHL (on-demand, per taxon) ----------

async function fetchBHL(scientificName) {
  const query = `PREFIX dwc: <http://rs.tdwg.org/dwc/terms/>
PREFIX dcterms: <http://purl.org/dc/terms/>
PREFIX bhl: <https://www.biodiversitylibrary.org/vocab/>
SELECT DISTINCT ?title ?containerTitle ?date ?part WHERE {
  GRAPH <https://koetai.semscape.org/u/0000-0001-9773-4008/bhl/data> {
    VALUES ?taxonLabel { ${sparqlStringLiteral(scientificName)} }
    ?page dwc:scientificName ?taxonLabel .
    ?part bhl:hasPage ?page ; dcterms:title ?title ; dcterms:date ?date .
    OPTIONAL { ?part bhl:containerTitle ?containerTitle }
  }
}
ORDER BY ?date
LIMIT 20`;
  return sparqlViaFetch(query, BHL_ENDPOINT, { label: `BHL literature for "${scientificName}"` });
}

// ---------- Wikipedia stub drafting ----------
// Similar in spirit to https://github.com/wikiproject-biodiversity/taxonname-wpstubmaker :
// pull together iNaturalist + GBIF + Wikidata facts already resolved above and draft a
// ready-to-review stub for a Wikipedia language that doesn't have an article yet.
// These are DRAFTS. They are not posted anywhere automatically — always have a human
// review formatting, categories and notability before publishing to Wikipedia.

const RANK_ORDER = ['kingdom', 'phylum', 'class', 'order', 'family', 'genus', 'species'];

async function fetchINatTaxonDetail(id) {
  const res = await fetch(`${INAT_API}/taxa/${id}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`iNaturalist taxon detail HTTP ${res.status}`);
  const json = await res.json();
  return json.results[0];
}

async function fetchGbifSpecies(gbifId) {
  const res = await fetch(`https://api.gbif.org/v1/species/${gbifId}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`GBIF species HTTP ${res.status}`);
  return res.json();
}

// Loads (and caches on the taxon object) the extra data needed to draft a stub: the
// iNaturalist ancestor chain (for rank hierarchy + parent taxon) and, independently, a
// GBIF classification and an NCBI Taxonomy classification — three lineages from three
// databases that don't share a single source of truth, so where they land the same
// taxon in a different family/order/etc is exactly the kind of thing worth a stub's own
// "Taxonomy" section flagging rather than silently picking one (see taxonomyComparison).
async function ensureStubContext(t) {
  if (t._stubContext) return t._stubContext;
  const detail = await fetchINatTaxonDetail(t.inatId);
  const ranks = {};
  for (const a of (detail.ancestors || [])) {
    if (RANK_ORDER.includes(a.rank)) ranks[a.rank] = a.name;
  }
  if (RANK_ORDER.includes(detail.rank)) ranks[detail.rank] = detail.name;
  const parent = (detail.ancestors && detail.ancestors.length)
    ? detail.ancestors[detail.ancestors.length - 1]
    : null;

  let gbif = null;
  if (t.wikidata && t.wikidata.gbif) {
    try { gbif = await fetchGbifSpecies(t.wikidata.gbif); } catch (e) { log(`GBIF lookup failed: ${e.message}`, 'warn'); }
  } else {
    // No P846 on Wikidata to look up directly — fall back to GBIF's own name match,
    // same as the QuickStatements context does, so the taxonomy comparison isn't limited
    // to taxa that already happen to be cross-referenced on Wikidata.
    try {
      const match = await fetchGbifMatch(t.name);
      if (match && match.matchType && match.matchType !== 'NONE') gbif = match;
    } catch (e) { log(`GBIF match failed: ${e.message}`, 'warn'); }
  }

  let ncbiRanks = {};
  try {
    const ncbiTaxonId = await fetchNcbiTaxonId(t.name);
    if (ncbiTaxonId) ncbiRanks = await fetchNcbiLineage(ncbiTaxonId);
  } catch (e) { log(`NCBI Taxonomy lookup failed: ${e.message}`, 'warn'); }

  t._stubContext = { detail, ranks, parent, gbif, ncbiRanks };
  return t._stubContext;
}

const TAXONOMY_COMPARE_RANKS = ['kingdom', 'phylum', 'class', 'order', 'family', 'genus'];

// Cross-checks the classification (kingdom..genus) as reported independently by
// iNaturalist, GBIF and NCBI Taxonomy. Ranks only ONE source has an opinion on aren't a
// disagreement — there's nothing to compare — only ranks where two-plus sources both
// have a value AND that value differs count. Returns which sources actually contributed
// anything (an absent GBIF/NCBI match is common and not itself worth mentioning) and the
// list of ranks that disagree, each with which source said what.
function compareTaxonomySources(ctx) {
  const gbifRanks = {};
  if (ctx.gbif) for (const r of TAXONOMY_COMPARE_RANKS) if (ctx.gbif[r]) gbifRanks[r] = ctx.gbif[r];
  const sources = [
    ['iNaturalist', ctx.ranks],
    ['GBIF', gbifRanks],
    ['NCBI Taxonomy', ctx.ncbiRanks || {}],
  ].filter(([, r]) => Object.keys(r).length > 0);

  const disagreements = [];
  for (const rank of TAXONOMY_COMPARE_RANKS) {
    const values = {};
    for (const [name, r] of sources) if (r[rank]) values[name] = r[rank];
    if (new Set(Object.values(values)).size > 1) disagreements.push({ rank, values });
  }
  return { sourceNames: sources.map(([name]) => name), disagreements };
}

// ---------- Synonymy & homonymy ----------
// On-demand, per-taxon only (curation page) — the nested-OPTIONAL and multi-name lookups
// below don't scale to a batch of hundreds like the rest of the pipeline does, so this
// stays out of the fast bulk pass entirely. RDF end to end: GBIF's own data via QLever's
// mirror (not the GBIF REST API) for names/synonyms, Wikidata via QLever first and live
// WDQS as a fallback when QLever comes back empty — the same federation this whole app is
// built to demonstrate, rather than reaching for a REST endpoint out of convenience.

// QLever primary, live WDQS fallback if QLever comes back completely empty — same "trust
// a match, re-check a miss" reasoning as the bulk pipeline (sparqlFirstRowWithFallback),
// generalized to return every row instead of just the first, for the multi-row lookups
// this feature needs (several synonym names or candidate items at once).
async function sparqlAllRowsWithFallback(query, label) {
  const primary = await sparqlViaComunica(query, QLEVER_ENDPOINT, { silent: true, label });
  if (primary.length) return primary;
  try {
    return await sparqlViaComunica(query, WDQS_ENDPOINT, { silent: true, retries: 1, label });
  } catch (e) {
    log(`WDQS re-check failed for "${label}" (${e.message}) — trusting QLever's empty result`, 'warn');
    return [];
  }
}

// GBIF's QLever mirror models each usage as a dwc:Taxon with rdfs:label holding the clean
// canonical name (confirmed live, on both an accepted usage and one of its synonyms) — the
// UNIONs with dwc:species/dwc:scientificName are just a safety net in case some record
// lacks a label. gbifv:acceptedNameUsage is only present when the matched record is
// itself a synonym, pointing at the accepted one.
async function fetchGbifUsage(name) {
  const query = `PREFIX dwc: <http://rs.tdwg.org/dwc/terms/>
PREFIX gbifv: <https://rs.gbif.org/terms/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?taxon ?accepted WHERE {
  { ?taxon rdfs:label ${sparqlStringLiteral(name)} } UNION
  { ?taxon dwc:species ${sparqlStringLiteral(name)} } UNION
  { ?taxon dwc:scientificName ${sparqlStringLiteral(name)} }
  OPTIONAL { ?taxon gbifv:acceptedNameUsage ?accepted }
}`;
  const rows = await sparqlViaComunica(query, GBIF_ENDPOINT, { silent: true, label: `GBIF usage lookup for "${name}"` });
  if (!rows.length) return null;
  const row = rows[0];
  return { taxonUri: row.taxon, acceptedUri: row.accepted || row.taxon, isSynonym: !!row.accepted };
}

// The reverse of acceptedNameUsage — every record that points AT this accepted usage is
// one of its synonyms.
async function fetchGbifSynonyms(acceptedUri) {
  const query = `PREFIX gbifv: <https://rs.gbif.org/terms/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?syn ?name WHERE {
  ?syn gbifv:acceptedNameUsage <${acceptedUri}> .
  OPTIONAL { ?syn rdfs:label ?name }
}`;
  const rows = await sparqlViaComunica(query, GBIF_ENDPOINT, { silent: true, label: 'GBIF synonyms' });
  return [...new Set(rows.map(r => r.name).filter(Boolean))];
}

// Same exact-P225-match pattern the main pipeline uses, batched over a handful of
// synonym names instead of a whole project's taxa. Filters to real items only (see
// pushWikidataCandidate's comment — a stray Lexeme Sense matched a P225 query live once).
async function fetchWikidataItemsForNames(names) {
  const map = new Map();
  if (!names.length) return map;
  const values = names.map(n => sparqlStringLiteral(n)).join(' ');
  const query = `PREFIX wdt: <http://www.wikidata.org/prop/direct/>
SELECT ?name ?item WHERE { VALUES ?name { ${values} } ?item wdt:P225 ?name }`;
  const rows = await sparqlAllRowsWithFallback(query, 'Wikidata lookup for synonym names');
  for (const r of rows) {
    if (!/\/Q\d+$/.test(r.item)) continue;
    const qid = r.item.split('/').pop();
    (map.get(r.name) || map.set(r.name, []).get(r.name)).push(qid);
  }
  return map;
}

async function fetchSitelinksForQids(qids) {
  const map = new Map();
  if (!qids.length) return map;
  const values = qids.map(q => `wd:${q}`).join(' ');
  const optionals = LANGS.map(l => `OPTIONAL { ?article_${l.code} schema:about ?item ; schema:isPartOf <${l.wiki}> . }`).join('\n  ');
  const selectVars = LANGS.map(l => `?article_${l.code}`).join(' ');
  const query = `PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX schema: <http://schema.org/>
SELECT ?item ${selectVars} WHERE { VALUES ?item { ${values} } ${optionals} }`;
  const rows = await sparqlAllRowsWithFallback(query, 'Sitelinks for synonym items');
  for (const r of rows) {
    const qid = r.item.split('/').pop();
    const langs = {};
    for (const l of LANGS) langs[l.code] = r[`article_${l.code}`] || null;
    map.set(qid, langs);
  }
  return map;
}

// P1420 ("taxon synonym") is Wikidata's formal way to link a synonym item to the item it's
// a synonym of — checked in both directions, since which side carries the statement
// varies in practice. Distinguishes "this name is genuinely modelled as a synonym on
// Wikidata" from "a same-named item happens to exist for an unrelated reason".
async function fetchTaxonSynonymLinks(qids) {
  if (!qids.length) return [];
  const values = qids.map(q => `wd:${q}`).join(' ');
  const query = `PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX wd: <http://www.wikidata.org/entity/>
SELECT ?item ?synOf WHERE { VALUES ?item { ${values} } { ?item wdt:P1420 ?synOf } UNION { ?synOf wdt:P1420 ?item } }`;
  const rows = await sparqlAllRowsWithFallback(query, 'P1420 synonym links');
  return rows.map(r => ({ item: r.item.split('/').pop(), synOf: r.synOf.split('/').pop() }));
}

// For an ambiguous match (multiple Wikidata items share this taxon's scientific name —
// real homonymy, not the stray-Lexeme artifact already filtered out elsewhere), find
// which candidate's own P171 (parent taxon) chain actually agrees with what iNaturalist
// reports for THIS taxon. One query per candidate, using nested OPTIONALs to fetch up to
// three ancestor levels (parent/grandparent/great-grandparent) at once rather than one
// round trip per level — enough to separate genuinely different lineages (an unrelated
// homonym from another kingdom won't match at any of the three) without walking the
// whole tree. The candidate whose chain matches a known ancestor in the FEWEST hops is
// the more likely one — this is advisory for the curator, not auto-applied to `t.wikidata`.
async function disambiguateHomonyms(qids, ancestorNames) {
  const results = [];
  for (const qid of qids) {
    const query = `PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX wd: <http://www.wikidata.org/entity/>
SELECT ?a1n ?a2n ?a3n WHERE {
  wd:${qid} wdt:P171 ?a1 .
  OPTIONAL { ?a1 wdt:P225 ?a1n }
  OPTIONAL {
    ?a1 wdt:P171 ?a2 .
    OPTIONAL { ?a2 wdt:P225 ?a2n }
    OPTIONAL {
      ?a2 wdt:P171 ?a3 .
      OPTIONAL { ?a3 wdt:P225 ?a3n }
    }
  }
}`;
    try {
      const rows = await sparqlAllRowsWithFallback(query, `Homonym disambiguation for ${qid}`);
      const row = rows[0] || {};
      const chain = [row.a1n, row.a2n, row.a3n].filter(Boolean);
      const depth = [row.a1n, row.a2n, row.a3n].findIndex(name => name && ancestorNames.includes(name));
      results.push({ qid, depth: depth === -1 ? null : depth + 1, chain });
    } catch (e) {
      results.push({ qid, depth: null, chain: [], error: e.message });
    }
  }
  return results;
}

// Orchestrates the whole synonymy/homonymy check for one taxon — homonym disambiguation
// when the match is ambiguous, and a GBIF-sourced synonym check always attempted (an
// informational cross-reference regardless of match status, and the closest thing to a
// "rescue" path when `t.wikidata` is null because iNaturalist and Wikidata simply
// disagree on which name is current).
async function buildSynonymyInfo(t, ctx) {
  const info = {};

  if (t.wikidataAmbiguous && t.wikidataCandidateQids && t.wikidataCandidateQids.length > 1) {
    const ancestorNames = ctx ? Object.values(ctx.ranks).filter(Boolean) : [];
    try {
      info.homonym = await disambiguateHomonyms(t.wikidataCandidateQids, ancestorNames);
    } catch (e) { info.homonymError = e.message; }
  }

  try {
    const usage = await fetchGbifUsage(t.name);
    if (usage) {
      const synonymNames = (await fetchGbifSynonyms(usage.acceptedUri)).filter(n => n !== t.name);
      const wdMatches = await fetchWikidataItemsForNames(synonymNames);
      const allQids = [...new Set([].concat(...wdMatches.values()))];
      const sitelinks = await fetchSitelinksForQids(allQids);
      const linkCheckQids = t.wikidata ? [...new Set([...allQids, t.wikidata.qid])] : allQids;
      const synLinks = await fetchTaxonSynonymLinks(linkCheckQids);
      info.synonyms = { names: synonymNames, wdMatches, sitelinks, synLinks, acceptedUri: usage.acceptedUri, isSynonym: usage.isSynonym };
    }
  } catch (e) { info.synonymsError = e.message; }

  return info;
}

function synonymyPanel(t, info) {
  const sections = [];

  if (info.homonym) {
    const ranked = [...info.homonym].sort((a, b) => (a.depth ?? 99) - (b.depth ?? 99));
    const best = ranked.find(r => r.depth != null);
    const rows = ranked.map(r => {
      const isCurrent = t.wikidata && r.qid === t.wikidata.qid;
      const status = r.depth != null
        ? `matches a known ancestor at ${r.depth} hop${r.depth === 1 ? '' : 's'} (${r.chain.slice(0, r.depth).join(' › ')})`
        : (r.error ? `lookup failed: ${escapeHtml(r.error)}` : 'no known ancestor found within 3 hops');
      return `<li>${isCurrent ? "<strong>→ this taxon's current match</strong> — " : ''}<a href="https://www.wikidata.org/wiki/${r.qid}" target="_blank" rel="noopener">${r.qid}</a> — ${status}</li>`;
    }).join('');
    const recommendation = !best
      ? `None of the candidates' parent chains matched a known ancestor within 3 hops — can't recommend one over another from this alone.`
      : (t.wikidata && best.qid === t.wikidata.qid)
        ? `This tool's own pick (${t.wikidata.qid}) already has the shortest matching path — likely correct.`
        : `<a href="https://www.wikidata.org/wiki/${best.qid}" target="_blank" rel="noopener">${best.qid}</a> has a shorter matching path than the current pick — likely the better match. Consider adding its iNaturalist id (P3151) so future runs pick it automatically.`;
    sections.push(`<div><strong>Homonym disambiguation</strong> — by shortest path to a known ancestor (parent/grandparent/great-grandparent via P171):
      <ul>${rows}</ul>
      <p class="identity-note">${recommendation}</p>
    </div>`);
  }

  if (info.synonyms) {
    const { names, wdMatches, sitelinks, synLinks, acceptedUri, isSynonym } = info.synonyms;
    const onWikidataNames = names.filter(n => (wdMatches.get(n) || []).length);
    const withArticleNames = [];
    let rescue = null;
    const rows = names.map(name => {
      const qids = wdMatches.get(name) || [];
      if (!qids.length) return `<li><em>${escapeHtml(name)}</em> — not on Wikidata</li>`;
      return qids.map(qid => {
        const langs = sitelinks.get(qid) || {};
        const withArticle = LANGS.filter(l => langs[l.code]);
        if (withArticle.length) withArticleNames.push(name);
        const isSyn = synLinks.some(l => l.item === qid || l.synOf === qid);
        if (!t.wikidata && withArticle.length && !rescue) rescue = { name, qid, langs: withArticle.map(l => l.code) };
        return `<li><a href="https://www.wikidata.org/wiki/${qid}" target="_blank" rel="noopener">${qid}</a> — <em>${escapeHtml(name)}</em>` +
          `${withArticle.length ? ` — has ${withArticle.map(l => l.code).join('/')} Wikipedia` : ' — no Wikipedia article'}` +
          `${isSyn ? ' — P1420-linked as a synonym on Wikidata' : ' — same name exists on Wikidata but not P1420-linked as a synonym'}</li>`;
      }).join('');
    }).join('');
    const rescueNote = rescue
      ? `<p class="identity-note"><strong>Possible rescue:</strong> this taxon wasn't matched to Wikidata under its iNaturalist name, but its GBIF synonym <em>${escapeHtml(rescue.name)}</em> resolves to <a href="https://www.wikidata.org/wiki/${rescue.qid}" target="_blank" rel="noopener">${rescue.qid}</a>, which already has a ${rescue.langs.join('/')} Wikipedia article — very likely the right item. Consider adding <em>${escapeHtml(t.name)}</em> as an alias there, or as an additional P225 value.</p>`
      : '';
    const gbifNote = isSynonym
      ? `<p class="identity-note"><em>${escapeHtml(t.name)}</em> is itself a GBIF synonym — counts below are for its accepted usage.</p>`
      : '';
    sections.push(`<div><strong>Synonyms</strong> — ${names.length} on <a href="${acceptedUri}" target="_blank" rel="noopener">GBIF</a>, ${onWikidataNames.length} also exist as Wikidata items, ${withArticleNames.length} of those have a Wikipedia article.
      ${gbifNote}
      ${names.length ? `<ul>${rows}</ul>` : ''}
      ${rescueNote}
    </div>`);
  } else if (info.synonymsError) {
    sections.push(`<div><strong>Synonyms</strong> — could not check: ${escapeHtml(info.synonymsError)}</div>`);
  }

  if (!sections.length) return '';
  return `<div class="identity-panel taxon-action-panel"><h3>Synonymy &amp; homonymy</h3>${sections.join('')}</div>`;
}

function todayISO() { return new Date().toISOString().slice(0, 10); }

// The bare "Filename.jpg" for a taxon's photo, if it's already on Commons
// (either matched by resolveCommonsStatus, or freshly prepared this session).
function commonsImageFilename(t) {
  // A curator's explicit pick (from the curation page's image selector, sourced from
  // images already on Wikidata/Commons for this taxon) wins over this run's own
  // observation photo — that photo may not even be uploaded yet, while a selected image
  // is already live and license-cleared.
  if (t._selectedImage) return t._selectedImage;
  const pageUrl = t.obsPhoto && t.obsPhoto.commonsFile && t.obsPhoto.commonsFile.pageUrl;
  return pageUrl ? decodeURIComponent(pageUrl.split('File:').pop()) : '';
}

function commonsThumbUrl(filename, width = 150) {
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(filename)}?width=${width}`;
}

// Commons' schema:contentUrl sometimes carries tracking query params
// (?utm_source=commons.wikimedia.org&…) appended after the real filename — found live,
// via QLever's wikimedia-commons mirror, while building the image picker below. Strip
// them before treating whatever follows the last "/" as the actual filename; every place
// in this file that turns a contentUrl into a filename goes through this.
function commonsFilenameFromUrl(url) {
  return decodeURIComponent(url.split('/').pop().split('?')[0]);
}

// Existing images already on Wikidata (direct P18) or Commons (structured-data "depicts"
// pointing at this taxon's QID) — an alternative to the observation-photo upload flow for
// populating a stub's infobox image, since a taxon that's been on Wikidata for a while
// often already has a properly licensed, curated image nobody needs to re-upload.
async function fetchCandidateImages(t) {
  if (!t.wikidata) return [];
  const images = [];
  try {
    const rows = await sparqlViaComunica(
      `PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX wd: <http://www.wikidata.org/entity/>
SELECT ?image WHERE { wd:${t.wikidata.qid} wdt:P18 ?image }`,
      QLEVER_ENDPOINT, { silent: true });
    for (const r of rows) {
      images.push({ filename: commonsFilenameFromUrl(r.image), source: 'Wikidata' });
    }
  } catch (e) { log(`Wikidata image lookup failed: ${e.message}`, 'warn'); }
  try {
    const rows = await sparqlViaComunica(
      `PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX schema: <http://schema.org/>
SELECT ?contentUrl WHERE { ?file wdt:P180 wd:${t.wikidata.qid} ; schema:contentUrl ?contentUrl } LIMIT 12`,
      COMMONS_ENDPOINT, { silent: true });
    for (const r of rows) {
      const filename = commonsFilenameFromUrl(r.contentUrl);
      if (!images.some(i => i.filename === filename)) images.push({ filename, source: 'Commons' });
    }
  } catch (e) { log(`Commons depicts lookup failed: ${e.message}`, 'warn'); }
  return images;
}

async function ensureCandidateImages(t) {
  if (t._candidateImages) return t._candidateImages;
  t._candidateImages = await fetchCandidateImages(t);
  return t._candidateImages;
}

// iNaturalist is user-generated/crowdsourced content and isn't a reliable source under
// Wikipedia's sourcing policy — it should never be the <ref> "proving" a factual claim,
// only ever the target of an external database link (which {{Taxonbar}}, sourced from
// Wikidata, already covers). So the lead sentence gets a {{citation needed}} marker
// until a curator supplies something actually citable — on the taxon curation page, by
// picking a BHL literature record (see the BHL reference picker there) — at which point
// `citation` is a real {title, containerTitle, date, url} to cite instead.
const CITATION_NEEDED = { en: '{{citation needed}}', es: '{{cita requerida}}', ja: '{{要出典}}', pt: '{{carece de fontes}}' };

// {{cite doi}} (a bot-maintained subpage-per-DOI system) was deprecated and discontinued
// around 2016 — the current, still-live convention is a plain |doi= parameter on the
// normal citation templates, which Citation Style 1's {{cite web}} accepts same as
// {{cite journal}} does. When a DOI is known, cite it directly (|doi=) rather than
// wrapping it in a doi.org URL — |url= is then redundant (the template resolves the
// link itself) so it's dropped in that case.
function leadCitationWikitext(lang, citation) {
  if (!citation) return CITATION_NEEDED[lang] || CITATION_NEEDED.en;
  // The publication already has a Wikidata item — cite it live from there ({{cite Q}}) as
  // the modern equivalent of the deprecated {{cite doi}}, same template name in wide use
  // across languages, rather than repeating title/journal/date inline.
  if (citation.qid) return `<ref>{{cite Q|${citation.qid}}}</ref>`;
  const accessDate = todayISO();
  const linkPart = citation.doi ? ` |doi=${citation.doi}` : ` |url=${citation.url}`;
  if (lang === 'es') {
    return `<ref>{{cita web |título=${citation.title}${citation.containerTitle ? ` |sitioweb=${citation.containerTitle}` : ''}${citation.date ? ` |fecha=${citation.date}` : ''}${linkPart} |fechaacceso=${accessDate}}}</ref>`;
  }
  if (lang === 'ja') {
    return `<ref>{{cite web |title=${citation.title}${citation.containerTitle ? ` |website=${citation.containerTitle}` : ''}${citation.date ? ` |date=${citation.date}` : ''}${linkPart} |accessdate=${accessDate}}}</ref>`;
  }
  if (lang === 'pt') {
    return `<ref>{{citar web |título=${citation.title}${citation.containerTitle ? ` |site=${citation.containerTitle}` : ''}${citation.date ? ` |data=${citation.date}` : ''}${linkPart} |acessodata=${accessDate}}}</ref>`;
  }
  return `<ref>{{cite web |title=${citation.title}${citation.containerTitle ? ` |website=${citation.containerTitle}` : ''}${citation.date ? ` |date=${citation.date}` : ''}${linkPart} |access-date=${accessDate}}}</ref>`;
}

// GBIF's `authorship` field is normally just "Author, Year" (parens around it mean the
// species has since been moved to a different genus than the one it was described in —
// standard zoological/botanical nomenclature convention, not something to strip). Split
// name from year for the "first described by" sentence; anything that doesn't match this
// shape (multiple authors joined oddly, "ex" formulas, etc.) is left alone rather than
// forcing a sentence that might misparse it.
function parseAuthority(authority) {
  if (!authority) return null;
  const m = String(authority).trim().match(/^\(?\s*([^(),]+?)\s*,\s*(\d{4})\s*\)?$/);
  return m ? { author: m[1].trim(), year: m[2] } : null;
}

const DESCRIBED_BY_I18N = {
  en: (a, y) => ` It was first described by ${a} in ${y}.`,
  es: (a, y) => ` Fue descrita por primera vez por ${a} en ${y}.`,
  ja: (a, y) => ` ${a}によって${y}年に初めて記載された。`,
  pt: (a, y) => ` Foi descrita pela primeira vez por ${a} em ${y}.`,
};

// GBIF's own `publishedIn` (the original describing publication) is the actual citation
// for THIS claim specifically — more so than the generic lead sentence it used to be
// attached to, since it's literally the record of that description.
function describedByWikitext(gbif, lang) {
  const parsed = gbif && parseAuthority(gbif.authorship);
  if (!parsed) return '';
  const sentence = (DESCRIBED_BY_I18N[lang] || DESCRIBED_BY_I18N.en)(parsed.author, parsed.year);
  const ref = gbif.publishedIn ? `<ref>${gbif.publishedIn}</ref>` : '';
  return sentence + ref;
}

// Per-language phrasing for the taxonomy cross-check section — kept as small a set of
// building blocks as the four templates elsewhere in this file use, rather than four
// fully separate prose generators.
const TAXONOMY_I18N = {
  en: {
    heading: '==Taxonomy==',
    ranks: { kingdom: 'Kingdom', phylum: 'Phylum', class: 'Class', order: 'Order', family: 'Family', genus: 'Genus' },
    follows: (list) => `Classification follows ${list}.`,
    disagree: "These sources don't fully agree on the classification — verify before publishing:",
    placesIn: (src, val) => `${src} places it in ''${val}''`,
  },
  es: {
    heading: '==Taxonomía==',
    ranks: { kingdom: 'Reino', phylum: 'Filo', class: 'Clase', order: 'Orden', family: 'Familia', genus: 'Género' },
    follows: (list) => `La clasificación sigue a ${list}.`,
    disagree: 'Estas fuentes no coinciden del todo en la clasificación — verificar antes de publicar:',
    placesIn: (src, val) => `${src} la ubica en ''${val}''`,
  },
  ja: {
    heading: '==分類==',
    ranks: { kingdom: '界', phylum: '門', class: '綱', order: '目', family: '科', genus: '属' },
    follows: (list) => `分類は${list}に基づく。`,
    disagree: '出典間で分類の一部が一致していない — 公開前に確認が必要:',
    placesIn: (src, val) => `${src}では${val}`,
  },
  pt: {
    heading: '==Taxonomia==',
    ranks: { kingdom: 'Reino', phylum: 'Filo', class: 'Classe', order: 'Ordem', family: 'Família', genus: 'Gênero' },
    follows: (list) => `A classificação segue ${list}.`,
    disagree: 'Estas fontes não concordam totalmente na classificação — verificar antes de publicar:',
    placesIn: (src, val) => `${src} a coloca em ''${val}''`,
  },
};

// A "==Taxonomy==" section built from whichever of iNaturalist/GBIF/NCBI Taxonomy this
// taxon actually matched in (a missing GBIF or NCBI match is common and silently
// skipped, not itself worth a note), listing the classification and — the actually
// useful part — calling out any rank where the sources land the taxon differently
// instead of quietly picking one, since that disagreement is real information a curator
// needs to see before publishing.
function taxonomyWikitext(ctx, lang) {
  const i18n = TAXONOMY_I18N[lang] || TAXONOMY_I18N.en;
  const { sourceNames, disagreements } = compareTaxonomySources(ctx);
  if (!sourceNames.length) return '';
  const gbifRanks = ctx.gbif || {};
  const lines = TAXONOMY_COMPARE_RANKS
    .map(rank => {
      const value = ctx.ranks[rank] || gbifRanks[rank] || (ctx.ncbiRanks && ctx.ncbiRanks[rank]);
      return value ? `* ${i18n.ranks[rank]}: ${value}` : null;
    })
    .filter(Boolean)
    .join('\n');
  if (!lines) return '';
  let disagreeBlock = '';
  if (disagreements.length) {
    const items = disagreements
      .map(d => `* ${i18n.ranks[d.rank]}: ` + Object.entries(d.values).map(([src, v]) => i18n.placesIn(src, v)).join('; '))
      .join('\n');
    disagreeBlock = `\n\n${i18n.disagree}\n${items}`;
  }
  return `\n\n${i18n.heading}\n${i18n.follows(sourceNames.join(', '))}\n${lines}${disagreeBlock}`;
}

function buildStubEn(t, ctx, citation) {
  const { ranks, parent, gbif } = ctx;
  const authority = (gbif && gbif.authorship) || (ranks.species ? '' : '');
  const exordium = t.commonName
    ? `'''''${t.name}''''', also known by its common name '''${t.commonName}'''`
    : `'''''${t.name}'''''`;
  const parentName = parent ? parent.name : (ranks.genus || ranks.family || '');
  const commonsBlock = t.wikidata && t.wikidata.commonsCat ? `\n{{Commons category|${t.wikidata.commonsCat}}}` : '';
  const taxonbar = t.wikidata ? `\n{{Taxonbar|from=${t.wikidata.qid}}}` : '';

  return `{{Speciesbox
| image = ${commonsImageFilename(t)}
| parent = ${parentName}
| taxon = ${t.name}
| authority = ${authority}
}}

${exordium} is a [[${t.rank}]] from the [[${parent ? parent.rank : ''}]] ''[[${parentName}]]''. ${leadCitationWikitext('en', citation)}${describedByWikitext(gbif, 'en')}${taxonomyWikitext(ctx, 'en')}

==References==
{{Reflist}}
${commonsBlock}${taxonbar}
{{taxon-stub}}
<!-- DRAFT generated from iNaturalist + GBIF + Wikidata data — review before publishing. -->`;
}

function buildStubEs(t, ctx, citation) {
  const { ranks, parent, gbif } = ctx;
  const authority = (gbif && gbif.authorship) || '';
  const fichaFields = [
    ['nombre', t.name],
    ['imagen', commonsImageFilename(t)],
    ['reino', ranks.kingdom || ''],
    ['filo', ranks.phylum || ''],
    ['clase', ranks.class || ''],
    ['orden', ranks.order || ''],
    ['familia', ranks.family || ''],
    ['género', ranks.genus || ''],
    ['especie', t.name],
    ['autor', authority],
  ].map(([k, v]) => `| ${k} = ${v}`).join('\n');
  const taxonbar = t.wikidata ? `\n{{taxonbar|from=${t.wikidata.qid}}}` : '';

  return `{{Ficha de taxón
${fichaFields}
}}

'''''${t.name}'''''${t.commonName ? ` es el nombre científico de '''${t.commonName}'''` : ''}, una especie de ${t.rank} perteneciente a ${parent ? parent.name : (ranks.family || '')}. ${leadCitationWikitext('es', citation)}${describedByWikitext(gbif, 'es')}${taxonomyWikitext(ctx, 'es')}

== Referencias ==
{{listaref}}
${taxonbar}
<!-- BORRADOR generado a partir de datos de iNaturalist, GBIF y Wikidata — revisar antes de publicar. Verifica la plantilla de esbozo adecuada. -->`;
}

function buildStubJa(t, ctx, citation) {
  const { ranks, parent, gbif } = ctx;
  const authority = (gbif && gbif.authorship) || '';
  const bunruiFields = [
    ['名称', t.commonName || t.name],
    ['画像', commonsImageFilename(t)],
    ['界', ranks.kingdom || ''],
    ['門', ranks.phylum || ''],
    ['綱', ranks.class || ''],
    ['目', ranks.order || ''],
    ['科', ranks.family || ''],
    ['属', ranks.genus || ''],
    ['種', t.name],
    ['学名', `''${t.name}'' ${authority}`.trim()],
    ['和名', t.commonName || ''],
  ].map(([k, v]) => `|${k} = ${v}`).join('\n');
  const taxonbar = t.wikidata ? `\n{{Taxonbar|from=${t.wikidata.qid}}}` : '';

  return `{{生物分類表
${bunruiFields}
}}

'''${t.name}'''${t.commonName ? `（${t.commonName}）` : ''}は、${parent ? parent.name : (ranks.family || '')}に属する${t.rank}の一種である。${leadCitationWikitext('ja', citation)}${describedByWikitext(gbif, 'ja')}${taxonomyWikitext(ctx, 'ja')}

== 脚注 ==
{{Reflist}}
${taxonbar}
<!-- iNaturalist・GBIF・Wikidataのデータから自動生成した下書きです。公開前に内容と適切なスタブテンプレートを確認してください。 -->`;
}

function buildStubPt(t, ctx, citation) {
  const { ranks, parent, gbif } = ctx;
  const authority = (gbif && gbif.authorship) || '';
  const infoFields = [
    ['nome', t.commonName || t.name],
    ['imagem', commonsImageFilename(t)],
    ['reino', ranks.kingdom || ''],
    ['filo', ranks.phylum || ''],
    ['classe', ranks.class || ''],
    ['ordem', ranks.order || ''],
    ['família', ranks.family || ''],
    ['género', ranks.genus || ''],
    ['espécie', t.name],
    ['binomial', t.name],
    ['binomial_autoridade', authority],
  ].map(([k, v]) => `| ${k} = ${v}`).join('\n');
  const taxonbar = t.wikidata ? `\n{{Taxonbar|from=${t.wikidata.qid}}}` : '';

  return `{{Info/Taxonomia
${infoFields}
}}

'''''${t.name}'''''${t.commonName ? `, conhecida popularmente como '''${t.commonName}'''` : ''} é uma espécie de ${t.rank} pertencente a ${parent ? parent.name : (ranks.family || '')}. ${leadCitationWikitext('pt', citation)}${describedByWikitext(gbif, 'pt')}${taxonomyWikitext(ctx, 'pt')}

== Referências ==
{{reflist}}
${taxonbar}
{{esboço-biologia}}
<!-- RASCUNHO gerado a partir de dados do iNaturalist, GBIF e Wikidata — revise antes de publicar. Verifique se o modelo de esboço é o mais adequado. -->`;
}

// citation: optional {title, containerTitle, date, url} — a genuinely citable source
// (e.g. a BHL literature record picked on the taxon curation page) to reference the lead
// sentence with, instead of leaving it a {{citation needed}} marker.
async function buildStub(t, lang, citation) {
  const ctx = await ensureStubContext(t);
  if (lang === 'en') return buildStubEn(t, ctx, citation);
  if (lang === 'es') return buildStubEs(t, ctx, citation);
  if (lang === 'ja') return buildStubJa(t, ctx, citation);
  if (lang === 'pt') return buildStubPt(t, ctx, citation);
  throw new Error(`No stub template for language "${lang}"`);
}

function editUrl(lang, title) {
  return `https://${lang}.wikipedia.org/w/index.php?title=${encodeURIComponent(title)}&action=edit`;
}

// ---------- Propose QuickStatements for a missing Wikidata item ----------
// For a taxon that resolveWikidata() couldn't find (t.wikidata === null), draft a
// QuickStatements v1 batch that would CREATE it, sourced from the linked databases
// this dashboard already talks to: iNaturalist (rank, ancestor chain, taxon id), GBIF
// (backbone taxon id, via a name match since there's no Wikidata item to have carried
// it) and NCBI Taxonomy (taxid, same reasoning). This is a DRAFT — reviewed and run by
// a human via quickstatements.toolforge.org, never submitted by this page itself.

const QS_REF_INATURALIST = 'Q16958215'; // "stated in" target for iNaturalist-sourced claims
const QS_REF_GBIF = 'Q1531570'; // "stated in" target for GBIF-sourced claims
const QS_REF_NCBI = 'Q82494'; // "stated in" target for NCBI Taxonomy-sourced claims

function qsString(s) {
  return JSON.stringify(s); // QuickStatements string literals use the same "…" + backslash escaping as JSON
}

async function fetchGbifMatch(name) {
  const res = await fetch(`https://api.gbif.org/v1/species/match?name=${encodeURIComponent(name)}&verbose=false`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`GBIF species/match HTTP ${res.status}`);
  return res.json();
}

// GBIF's match result carries the parent's own backbone id directly (genusKey for a
// species, familyKey for a genus, …) — a stable-id join against Wikidata's P846 is far
// more reliable than matching the parent's name as a string.
const GBIF_PARENT_KEY_FIELD = {
  species: 'genusKey', subspecies: 'speciesKey', variety: 'speciesKey', form: 'speciesKey',
  genus: 'familyKey', subgenus: 'genusKey',
  family: 'orderKey', subfamily: 'familyKey', tribe: 'familyKey', subtribe: 'familyKey',
  order: 'classKey', suborder: 'orderKey',
  class: 'phylumKey', subclass: 'classKey',
  phylum: 'kingdomKey', subphylum: 'phylumKey',
};

// NCBI Taxonomy's esearch, scoped to the "scientific name" field so an ambiguous common
// name never silently matches the wrong lineage; only returns an id on an unambiguous hit.
async function fetchNcbiTaxonId(name) {
  const res = await fetch(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=taxonomy&retmode=json` +
    `&term=${encodeURIComponent(`${name}[scientific name]`)}`,
    { headers: { Accept: 'application/json' } }
  );
  if (!res.ok) throw new Error(`NCBI esearch HTTP ${res.status}`);
  const json = await res.json();
  const ids = (json.esearchresult && json.esearchresult.idlist) || [];
  return ids.length === 1 ? ids[0] : null;
}

// NCBI's esummary returns the full ancestor chain (`lineageex`, one {taxid,
// scientificname, rank} per node) for a taxon id — this is what lets the drafted stub's
// taxonomy section cross-check iNaturalist and GBIF against a third, independent source
// rather than just repeating whichever one the infobox already came from.
async function fetchNcbiLineage(taxid) {
  const res = await fetch(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=taxonomy&id=${encodeURIComponent(taxid)}&retmode=json`,
    { headers: { Accept: 'application/json' } }
  );
  if (!res.ok) throw new Error(`NCBI esummary HTTP ${res.status}`);
  const json = await res.json();
  const rec = json.result && json.result[String(taxid)];
  const lineage = (rec && rec.lineageex) || [];
  const ranks = {};
  for (const node of lineage) {
    const rank = (node.rank || '').toLowerCase();
    if (RANK_ORDER.includes(rank)) ranks[rank] = node.scientificname;
  }
  return ranks;
}

// Every single-row "does X already exist on Wikidata" lookup in this tool goes through
// here. Same staleness logic as the batched pipeline (QLever's Wikidata mirror runs
// ~6 weeks behind live, per wikibase:Dump schema:dateModified) — trust a match, but a
// miss from QLever could just mean "too recent for the snapshot", and these lookups
// specifically feed the "propose creating a new item" flows, where a false negative
// means drafting a duplicate. So a QLever miss gets one live WDQS re-check before it's
// treated as a real "not found".
async function sparqlFirstRowWithFallback(query, label) {
  const primary = await sparqlViaComunica(query, QLEVER_ENDPOINT, { silent: true });
  if (primary.length) return primary;
  try {
    return await sparqlViaComunica(query, WDQS_ENDPOINT, { silent: true, retries: 1 });
  } catch (e) {
    log(`WDQS re-check failed for "${label}" (${e.message}) — trusting QLever's empty result`, 'warn');
    return [];
  }
}

async function resolveWikidataByExternalId(prop, value) {
  const rows = await sparqlFirstRowWithFallback(
    `PREFIX wdt: <http://www.wikidata.org/prop/direct/>
SELECT ?wdTaxon WHERE { ?wdTaxon wdt:${prop} ${sparqlStringLiteral(String(value))} } LIMIT 1`,
    `Wikidata lookup by ${prop}=${value}`
  );
  return rows.length ? rows[0].wdTaxon.split('/').pop() : null;
}

// Wikidata's items for each taxonomic rank (Q7432 = species, Q34740 = genus, …), built
// once from live data instead of a hardcoded table: every item that's an instance of
// "taxonomic rank" (Q427626), keyed by its English label. A couple of labels (e.g.
// "order") have more than one Wikidata item behind them; the one actually used by
// thousands of real P105 statements wins over an obscure/legacy duplicate.
let rankQidsPromise = null;
function getTaxonomicRankQids() {
  if (!rankQidsPromise) {
    rankQidsPromise = (async () => {
      const rows = await sparqlViaComunica(
        `PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?rank ?label WHERE {
  ?rank wdt:P31 wd:Q427626 .
  ?rank rdfs:label ?label .
  FILTER(lang(?label) = "en")
}`,
        QLEVER_ENDPOINT,
        { label: 'Taxonomic rank items' }
      );
      const byLabel = new Map(); // label -> [qid, ...]
      for (const r of rows) {
        const qid = r.rank.split('/').pop();
        const label = r.label.toLowerCase();
        (byLabel.get(label) || byLabel.set(label, []).get(label)).push(qid);
      }
      const ambiguous = [...byLabel.values()].filter(qids => qids.length > 1).flat();
      const usageCounts = new Map();
      if (ambiguous.length) {
        const values = ambiguous.map(q => `wd:${q}`).join(' ');
        const countRows = await sparqlViaComunica(
          `PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX wd: <http://www.wikidata.org/entity/>
SELECT ?rank (COUNT(?item) AS ?n) WHERE {
  VALUES ?rank { ${values} }
  ?item wdt:P105 ?rank .
} GROUP BY ?rank`,
          QLEVER_ENDPOINT,
          { label: 'Disambiguating taxonomic ranks' }
        );
        for (const r of countRows) usageCounts.set(r.rank.split('/').pop(), parseInt(r.n, 10));
      }
      const result = new Map();
      for (const [label, qids] of byLabel) {
        const best = qids.length === 1 ? qids[0]
          : qids.reduce((a, b) => (usageCounts.get(b) || 0) > (usageCounts.get(a) || 0) ? b : a);
        result.set(label, best);
      }
      return result;
    })();
  }
  return rankQidsPromise;
}

// Does the immediate parent taxon already have a Wikidata item? Checked independently
// against each lineage this dashboard has data for — iNaturalist's ancestor name, GBIF's
// own parent id (genus/family/order/… key, picked by the *child* taxon's rank, not the
// parent's — get this backwards and you silently resolve to the wrong ancestor), and
// NCBI's taxid for that same ancestor name — rather than trusting the first one that
// answers. When independent sources agree on the same Wikidata item, that agreement
// itself is worth recording (every source that confirmed it becomes its own reference
// on the one P171 statement); when they land on *different* items, that's a genuine
// taxonomic discrepancy between databases worth surfacing, not silently picking a winner.
async function resolveParentCandidates(taxonRank, parent, gbifMatch) {
  const candidates = []; // { qid, source: 'iNaturalist'|'GBIF'|'NCBI', refQid }

  const gbifKeyField = GBIF_PARENT_KEY_FIELD[(taxonRank || '').toLowerCase()];
  const parentGbifId = gbifMatch && gbifKeyField ? gbifMatch[gbifKeyField] : null;
  if (parentGbifId) {
    const qid = await resolveWikidataByExternalId('P846', parentGbifId).catch(() => null);
    if (qid) candidates.push({ qid, source: 'GBIF', refQid: QS_REF_GBIF });
  }

  if (parent) {
    const qid = await resolveWikidataByExternalId('P225', parent.name).catch(() => null);
    if (qid) candidates.push({ qid, source: 'iNaturalist', refQid: QS_REF_INATURALIST });

    const parentNcbiId = await fetchNcbiTaxonId(parent.name).catch(() => null);
    if (parentNcbiId) {
      const ncbiQid = await resolveWikidataByExternalId('P685', parentNcbiId).catch(() => null);
      if (ncbiQid) candidates.push({ qid: ncbiQid, source: 'NCBI', refQid: QS_REF_NCBI });
    }
  }

  return candidates;
}

async function ensureQuickStatementsContext(t) {
  if (t._qsContext) return t._qsContext;
  const detail = await fetchINatTaxonDetail(t.inatId);
  const parent = (detail.ancestors && detail.ancestors.length)
    ? detail.ancestors[detail.ancestors.length - 1]
    : null;
  const [gbifMatch, ncbiTaxonId, rankQids] = await Promise.all([
    fetchGbifMatch(t.name).catch(() => null),
    fetchNcbiTaxonId(t.name).catch(() => null),
    getTaxonomicRankQids().catch(() => new Map()),
  ]);
  const parentCandidates = await resolveParentCandidates(t.rank, parent, gbifMatch).catch(() => []);
  const parentByQid = new Map(); // qid -> [candidate, ...] agreeing on it
  for (const c of parentCandidates) {
    (parentByQid.get(c.qid) || parentByQid.set(c.qid, []).get(c.qid)).push(c);
  }
  t._qsContext = { detail, parent, gbifMatch, ncbiTaxonId, parentCandidates, parentByQid, rankQids };
  return t._qsContext;
}

// A taxon whose scientific name already matched an existing Wikidata item, but that
// item has no P3151 back to this iNaturalist taxon — a single-statement add, not a
// full CREATE draft, so it needs none of buildQuickStatements()'s lineage lookups.
function buildInatIdLinkQS(t) {
  return `${t.wikidata.qid}\tP3151\t${qsString(String(t.inatId))}\tS248\t${QS_REF_INATURALIST}`;
}

async function buildQuickStatements(t) {
  const ctx = await ensureQuickStatementsContext(t);
  const rankQid = ctx.rankQids.get((t.rank || '').toLowerCase());
  const descParent = ctx.parent ? ctx.parent.name : '';
  let description = t.rank || 'taxon';
  if (descParent) description += ` of ${descParent}`;
  if (t.commonName) description += ` (${t.commonName})`;

  const lines = ['CREATE'];
  lines.push(`LAST\tP31\tQ16521`); // instance of: taxon
  if (rankQid) lines.push(`LAST\tP105\t${rankQid}`); // taxon rank
  lines.push(`LAST\tP225\t${qsString(t.name)}`); // taxon name
  // `mul` (language-independent) alongside `en`: taxon names are identical across
  // languages, and Wikidata's "label in language constraint" flags an item with only
  // one language on it — this is the same en+mul pattern this org's own treatmentbot
  // uses on the taxa it creates (verified against Q130466854, Cutocoris distinctus).
  lines.push(`LAST\tLen\t${qsString(t.name)}`);
  lines.push(`LAST\tLmul\t${qsString(t.name)}`);
  lines.push(`LAST\tAen\t${qsString(t.name)}`);
  lines.push(`LAST\tDen\t${qsString(description)}`);
  // Only write P171 when every lineage that resolved a parent agrees on the same item,
  // with every agreeing source as its own separate reference block on that ONE
  // statement line. Repeating the whole "LAST P171 …" line per source (what this used
  // to do) instead creates duplicate statements — confirmed the hard way against a real
  // batch. Plain repeated "S248" pairs on one line would merge into snaks of a *single*
  // reference instead of separate ones; QuickStatements' documented fix is prefixing
  // every reference group after the first with "!" instead of "S" to start a new group.
  // Divergent lineages are surfaced in the panel text instead of guessed at here.
  if (ctx.parentByQid.size === 1) {
    const [qid, sources] = [...ctx.parentByQid.entries()][0];
    const refPairs = sources.map((c, i) => `${i === 0 ? 'S' : '!S'}248\t${c.refQid}`).join('\t');
    lines.push(`LAST\tP171\t${qid}\t${refPairs}`);
  }
  lines.push(`LAST\tP3151\t${qsString(String(t.inatId))}\tS248\t${QS_REF_INATURALIST}`);
  if (ctx.gbifMatch && ctx.gbifMatch.usageKey && ctx.gbifMatch.matchType && ctx.gbifMatch.matchType !== 'NONE') {
    lines.push(`LAST\tP846\t${qsString(String(ctx.gbifMatch.usageKey))}\tS248\t${QS_REF_GBIF}`);
  }
  if (ctx.ncbiTaxonId) {
    lines.push(`LAST\tP685\t${qsString(String(ctx.ncbiTaxonId))}\tS248\t${QS_REF_NCBI}`);
  }
  return lines.join('\n');
}

// Human-readable summary of how (or whether) the parent taxon resolved, for the detail
// panel: agreement across lineages is worth showing off, divergence is worth flagging
// rather than silently resolved one way, per source.
function describeParentResolution(ctx) {
  if (!ctx.parent) return '';
  if (ctx.parentByQid.size === 0) {
    return `Parent taxon <em>${ctx.parent.name}</em> has no Wikidata item in any lineage checked — P171 omitted.`;
  }
  if (ctx.parentByQid.size === 1) {
    const [qid, sources] = [...ctx.parentByQid.entries()][0];
    const names = sources.map(c => c.source).join(' and ');
    return `Parent taxon <em>${ctx.parent.name}</em> resolved to ` +
      `<a href="https://www.wikidata.org/wiki/${qid}" target="_blank" rel="noopener">${qid}</a> — ` +
      `${names} agree${sources.length > 1 ? `, all ${sources.length} cited as references on that claim` : ''}.`;
  }
  const perSource = [...ctx.parentByQid.entries()].map(([qid, sources]) =>
    `${sources.map(c => c.source).join('/')} → <a href="https://www.wikidata.org/wiki/${qid}" target="_blank" rel="noopener">${qid}</a>`
  ).join(', ');
  return `⚠ Parent taxon lineages disagree for <em>${ctx.parent.name}</em>: ${perSource}. ` +
    `Not added automatically (P171 omitted) — this is a real discrepancy between databases, not a bug; resolve it manually.`;
}

// ---------- Identity linking: is the iNaturalist project/user itself on Wikidata? ----------
// Distinct from the per-taxon QuickStatements above — this is about the *scope* being
// explored (the project or user entered at the top), not the species observed in it.

const P_INAT_USER_ID = 'P12022'; // "numeric identifier for a person who contributes to iNaturalist" — values in the wild are a mix of login and numeric id, both accepted by inaturalist.org/people/<either>
const Q_HUMAN = 'Q5';
const Q_CITIZEN_SCIENCE_PROJECT = 'Q24577212';

async function fetchINatUser(login) {
  const res = await fetch(`${INAT_API}/users/${encodeURIComponent(login)}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`iNaturalist user lookup HTTP ${res.status}`);
  const json = await res.json();
  if (!json.results || !json.results.length) throw new Error(`iNaturalist user "${login}" not found`);
  return json.results[0];
}

async function fetchINatProject(slug) {
  const res = await fetch(`${INAT_API}/projects/${encodeURIComponent(slug)}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`iNaturalist project lookup HTTP ${res.status}`);
  const json = await res.json();
  if (!json.results || !json.results.length) throw new Error(`iNaturalist project "${slug}" not found`);
  return json.results[0];
}

// P12022 values in the wild are a mix of login strings and numeric ids (both work on
// inaturalist.org/people/), so check both forms in one query rather than picking one.
async function checkUserOnWikidata(inatUser) {
  const values = [inatUser.login, String(inatUser.id)].map(sparqlStringLiteral).join(' ');
  const rows = await sparqlFirstRowWithFallback(
    `PREFIX wdt: <http://www.wikidata.org/prop/direct/>
SELECT ?item WHERE { ?item wdt:${P_INAT_USER_ID} ?v . VALUES ?v { ${values} } } LIMIT 1`,
    `iNaturalist user ${inatUser.login} on Wikidata`
  );
  return rows.length ? rows[0].item.split('/').pop() : null;
}

// No dedicated "iNaturalist project ID" Wikidata property exists (checked: none found).
// Real-world precedent instead links the project's iNaturalist URL via P856 (official
// website, the common case) or P973 (described at URL, seen occasionally) — so check both.
async function checkProjectOnWikidata(inatProject) {
  const needle = sparqlStringLiteral(`inaturalist.org/projects/${inatProject.slug}`);
  const rows = await sparqlFirstRowWithFallback(
    `PREFIX wdt: <http://www.wikidata.org/prop/direct/>
SELECT ?item WHERE {
  { ?item wdt:P856 ?url . FILTER(CONTAINS(STR(?url), ${needle})) }
  UNION
  { ?item wdt:P973 ?url . FILTER(CONTAINS(STR(?url), ${needle})) }
} LIMIT 1`,
    `iNaturalist project ${inatProject.slug} on Wikidata`
  );
  return rows.length ? rows[0].item.split('/').pop() : null;
}

// Far more reliable than name matching: an iNaturalist profile can carry a verified
// ORCID, and ORCID iDs are close to unambiguous on Wikidata.
async function findWikidataHumanByOrcid(orcidUrl) {
  if (!orcidUrl) return null;
  const orcidId = orcidUrl.replace(/^https?:\/\/orcid\.org\//, '');
  const rows = await sparqlFirstRowWithFallback(
    `PREFIX wdt: <http://www.wikidata.org/prop/direct/>
SELECT ?item WHERE { ?item wdt:P496 ${sparqlStringLiteral(orcidId)} } LIMIT 1`,
    `ORCID ${orcidId} on Wikidata`
  );
  return rows.length ? { qid: rows[0].item.split('/').pop(), via: 'orcid' } : null;
}

// Last resort, and the least reliable: a plain label search. Always presented as
// "possible match, verify yourself" — never auto-selected the way GBIF/NCBI ids are for
// taxon parents, because two different people (or projects) sharing a name is common.
async function searchWikidataCandidates(name, { humansOnly = false } = {}) {
  const res = await fetch(
    `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(name)}` +
    `&language=en&type=item&format=json&origin=*&limit=5`
  );
  if (!res.ok) return [];
  const json = await res.json();
  let candidates = (json.search || []).map(r => ({ qid: r.id, label: r.label || r.id, description: r.description || '' }));
  if (humansOnly && candidates.length) {
    const values = candidates.map(c => `wd:${c.qid}`).join(' ');
    const rows = await sparqlViaComunica(
      `PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX wd: <http://www.wikidata.org/entity/>
SELECT ?item WHERE { VALUES ?item { ${values} } ?item wdt:P31 wd:${Q_HUMAN} . }`,
      QLEVER_ENDPOINT, { silent: true }
    );
    const humanQids = new Set(rows.map(r => r.item.split('/').pop()));
    candidates = candidates.filter(c => humanQids.has(c.qid));
  }
  return candidates;
}

function qsAddClaim(qid, prop, value, refQid) {
  return `${qid}\t${prop}\t${qsString(value)}\tS248\t${refQid}`;
}

// mode: 'add' writes one claim onto an existing item (targetQid); 'create' drafts a
// whole new item. A brand-new "human" item needs a human to actually be notable by
// Wikidata's standards — being an iNaturalist contributor alone isn't — so this is
// deliberately the secondary path, not the one offered first.
function buildUserIdentityQS(inatUser, mode, targetQid) {
  if (mode === 'add') {
    return qsAddClaim(targetQid, P_INAT_USER_ID, String(inatUser.id), QS_REF_INATURALIST);
  }
  const lines = ['CREATE'];
  const displayName = inatUser.name || inatUser.login;
  lines.push(`LAST\tP31\tQ${Q_HUMAN.slice(1)}`);
  lines.push(`LAST\t${P_INAT_USER_ID}\t${qsString(String(inatUser.id))}\tS248\t${QS_REF_INATURALIST}`);
  lines.push(`LAST\tLen\t${qsString(displayName)}`);
  lines.push(`LAST\tLmul\t${qsString(displayName)}`);
  lines.push(`LAST\tDen\t${qsString('contributor on iNaturalist')}`);
  lines.push(`LAST\tP856\t${qsString(`https://www.inaturalist.org/people/${inatUser.login}`)}`);
  if (inatUser.orcid) {
    lines.push(`LAST\tP496\t${qsString(inatUser.orcid.replace(/^https?:\/\/orcid\.org\//, ''))}`);
  }
  return lines.join('\n');
}

function buildProjectIdentityQS(inatProject, mode, targetQid) {
  const url = `https://www.inaturalist.org/projects/${inatProject.slug}`;
  if (mode === 'add') {
    return qsAddClaim(targetQid, 'P856', url, QS_REF_INATURALIST);
  }
  const lines = ['CREATE'];
  lines.push(`LAST\tP31\t${Q_CITIZEN_SCIENCE_PROJECT}`);
  lines.push(`LAST\tP856\t${qsString(url)}\tS248\t${QS_REF_INATURALIST}`);
  lines.push(`LAST\tLen\t${qsString(inatProject.title)}`);
  lines.push(`LAST\tLmul\t${qsString(inatProject.title)}`);
  // Deliberately just "iNaturalist project", not e.g. "citizen science project on
  // iNaturalist" — the label above is the project's own title, which is very often
  // also the name of a broader event/campaign/organization it's *for* (e.g. a project
  // called "Biohackathon 2026" tracking observations made during that event). Without
  // an unambiguous description, this item reads as being about that broader thing
  // rather than specifically the iNaturalist project — description is what Wikidata
  // shows in parentheses to disambiguate two items sharing a label.
  lines.push(`LAST\tDen\t${qsString('iNaturalist project')}`);
  return lines.join('\n');
}

// ---------- UI ----------

const statusHeaderEl = document.getElementById('statusHeader');
const statusHeaderTextEl = document.getElementById('statusHeaderText');
const statusSpinnerEl = document.getElementById('statusSpinner');
const statusLogEl = document.getElementById('statusLog');
const runBtn = document.getElementById('runBtn');
const scopeTypeSelect = document.getElementById('scopeType');
const projectInput = document.getElementById('projectInput');
const projectInputLabel = document.getElementById('projectInputLabel');
const statsEl = document.getElementById('stats');
const filtersEl = document.getElementById('filters');
const tableWrapEl = document.getElementById('tableWrap');
const tbody = document.getElementById('taxaBody');
const identityPanelEl = document.getElementById('identityPanel');
const bulkActionsEl = document.getElementById('bulkActions');
const bulkInatIdBtn = document.getElementById('bulkInatIdBtn');
const bulkInatIdBox = document.getElementById('bulkInatIdBox');
const bulkInatIdTextarea = document.getElementById('bulkInatIdTextarea');
const bulkInatIdCopyBtn = document.getElementById('bulkInatIdCopyBtn');
const taxonDetailEl = document.getElementById('taxonDetail');
const taxonDetailBackBtn = document.getElementById('taxonDetailBack');
const taxonDetailHeaderEl = document.getElementById('taxonDetailHeader');
const taxonDetailRowEl = document.getElementById('taxonDetailRow');
const taxonDetailActionsEl = document.getElementById('taxonDetailActions');

const SCOPE_PLACEHOLDERS = {
  project: { label: 'iNaturalist project slug or numeric ID', example: 'biohackathon-2026' },
  user: { label: 'iNaturalist username or numeric ID', example: 'andrawaag' },
};
scopeTypeSelect.addEventListener('change', () => {
  const cfg = SCOPE_PLACEHOLDERS[scopeTypeSelect.value];
  projectInputLabel.textContent = cfg.label;
  projectInput.value = cfg.example;
});

let currentTaxa = [];
let currentFilter = 'all';

// Endpoints under load occasionally return an HTML error/gateway-timeout page instead
// of a SPARQL error — and Comunica's own error message can embed that page's full body
// verbatim. A GET-based SPARQL error (e.g. "Fetch timed out for <url>?query=...") is
// its own, more common case of the same problem: the query itself, URL-encoded, is
// exactly the kind of long-but-uninformative text a 240-char cap alone still leaves as
// unreadable garbage rather than actually clipping it usefully. So strip query strings
// off any URL first — almost always the real source of the bloat — then collapse
// whitespace and cap what's left, so one pathological message still can't flood the log
// (or, as happened once, visually overlap the header above it).
function sanitizeLogMessage(msg) {
  // Comunica error messages sometimes append the raw (often URL-encoded) SPARQL
  // query text straight after the endpoint URL — with a "?" separator (GET-style),
  // or with none at all (POST-body dumps). Collapse any of our known endpoints
  // down to their bare form, discarding whatever non-whitespace junk follows.
  const KNOWN_ENDPOINTS = [QLEVER_ENDPOINT, WDQS_ENDPOINT, BHL_ENDPOINT, PLAZI_ENDPOINT, COMMONS_ENDPOINT];
  let cleaned = String(msg);
  for (const ep of KNOWN_ENDPOINTS) {
    const escaped = ep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    cleaned = cleaned.replace(new RegExp(escaped + '\\S*', 'g'), ep);
  }
  // Fallback for any other URL not in the known list.
  cleaned = cleaned.replace(/(https?:\/\/[^\s")]+?)\?[^\s")]*/g, '$1');
  // A proxy in front of an endpoint can return its own HTML error page (a gateway's
  // "502 Bad Gateway", say) instead of JSON — Comunica surfaces that whole page as the
  // error message. Collapse it to just its own title/heading rather than dumping the
  // markup; works even when the message got cut off mid-tag before reaching here.
  const htmlMatch = cleaned.match(/<html[\s\S]*/i);
  if (htmlMatch) {
    const titleMatch = htmlMatch[0].match(/<title>([\s\S]*?)<\/title>/i) || htmlMatch[0].match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const label = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : 'HTML error page';
    cleaned = cleaned.slice(0, htmlMatch.index) + `[${label}]`;
  }
  const collapsed = cleaned.replace(/\s+/g, ' ').trim();
  const MAX = 240;
  return collapsed.length > MAX ? collapsed.slice(0, MAX) + '… (truncated)' : collapsed;
}

// level: 'err' (red) for something that actually broke — the run aborted, a whole step
// gave up with no usable result. 'warn' (amber) for adversity the tool already handled —
// a retry attempt, a fallback endpoint kicking in, a single lookup degrading gracefully.
// Both used to render identically in red, which made ordinary "WDQS is slow today, fell
// back to QLever" noise look exactly like something was broken.
function log(msg, level) {
  const line = document.createElement('div');
  const cls = level === true || level === 'err' ? 'err' : level === 'warn' ? 'warn' : '';
  line.className = 'log-line' + (cls ? ' ' + cls : '');
  line.textContent = sanitizeLogMessage(msg);
  statusLogEl.appendChild(line);
  statusLogEl.scrollTop = statusLogEl.scrollHeight;
}

let currentStatusBase = '';
function setStatusHeader(msg) {
  currentStatusBase = msg;
  statusHeaderTextEl.textContent = msg;
}

// Appends live batch/ETA progress to whatever setStatusHeader last set, without either
// one needing to know about the other — the next setStatusHeader call (the next step)
// naturally replaces this along with the base text, so there's nothing to clear.
function setStatusProgress(progressText) {
  statusHeaderTextEl.textContent = progressText ? `${currentStatusBase} — ${progressText}` : currentStatusBase;
}

// iNaturalist's own `taxon.wikipedia_url` is a human-curated pointer to whatever
// Wikipedia article actually covers a taxon — which is NOT always the item this tool
// matched by exact P225 string. Found live: Bos taurus (the strict taxon item, matched
// by name) has zero sitelinks, while the actual, heavily-referenced Wikipedia article is
// modelled on a separate "cattle" item that carries no P225 at all — an exact-name match
// can't bridge that on its own. Cross-checking against iNaturalist's own link catches
// exactly this case without needing another SPARQL query.
function inatWikipediaLangMatch(t, code) {
  if (!t.inatWikipediaUrl) return false;
  try { return new URL(t.inatWikipediaUrl).hostname === `${code}.wikipedia.org`; }
  catch (e) { return false; }
}

function taxonMissingCount(t) {
  if (!t.wikidata || !t.wikipedia) return null;
  return LANGS.filter(l => !t.wikipedia[l.code] && !inatWikipediaLangMatch(t, l.code)).length;
}

// True once the Wikidata item matched by scientific name also carries THIS taxon's
// iNaturalist id as P3151 — a name match alone doesn't mean the two are cross-linked.
function inatIdLinked(t) {
  return !!(t.wikidata && t.wikidata.inat != null && String(t.wikidata.inat) === String(t.inatId));
}

// Whether it's actually safe to draft a NEW Wikipedia stub tied to this taxon's matched
// Wikidata item — as opposed to whether an article happens to be missing. Those are
// different questions: an ambiguous match, a conflicted or unlinked iNaturalist id all
// mean this tool isn't confident *which* Wikidata item this taxon really is, and
// drafting {{Taxonbar|from=<possibly-the-wrong-item>}} on that basis would compound the
// existing data problem rather than fix anything. Each of these is already surfaced
// elsewhere (the ambiguous pill, the conflict panel, the "link iNat ID" flow) — this
// just refuses to let stub-drafting proceed until whichever applies is resolved there.
function stubReadiness(t) {
  const blockers = [];
  if (!t.wikidata) {
    blockers.push('not yet on Wikidata');
  } else {
    if (t.wikidataAmbiguous) blockers.push('ambiguous Wikidata match — multiple items share this scientific name');
    if (t.wikidataInatIdConflict) blockers.push(`${t.wikidataInatIdConflict.length} conflicting iNaturalist ids on the matched item`);
    else if (!inatIdLinked(t)) blockers.push("the matched item's iNaturalist id (P3151) isn't linked back to this taxon");
  }
  return { ready: blockers.length === 0, blockers };
}

// Matched item, no P3151 conflict on it, but not yet linked to THIS taxon's id — the
// safe-to-bulk-add case. Excludes the conflict case on purpose: adding a third value to
// an item that already has two is how you get more mess, not less.
function inatIdMissing(t) {
  return !!t.wikidata && !t.wikidataInatIdConflict && !inatIdLinked(t);
}

function matchesFilter(t) {
  if (currentFilter === 'all') return true;
  if (currentFilter === 'unresolved') return !t.wikidata;
  if (currentFilter === 'inat-id-missing') return inatIdMissing(t);
  if (currentFilter === 'inat-id-conflict') return !!t.wikidataInatIdConflict;
  const missing = taxonMissingCount(t);
  if (missing === null) return false;
  if (currentFilter === 'missing-any') return missing > 0;
  if (currentFilter === 'missing-all') return missing === LANGS.length;
  return true;
}

function inatTaxonUrl(t) {
  return `https://www.inaturalist.org/taxa/${t.inatId}`;
}

function langBadge(t, code) {
  if (!t.wikidata) return '<span class="pill">—</span>';
  const url = t.wikipedia ? t.wikipedia[code] : null;
  if (url) return `<a class="badge yes" href="${url}" target="_blank" rel="noopener" title="Has ${code} Wikipedia article">✓</a>`;
  if (inatWikipediaLangMatch(t, code)) {
    return `<a class="badge maybe" href="${t.inatWikipediaUrl}" target="_blank" rel="noopener" title="iNaturalist links to this page for ${code}, but it's not confirmed via Wikidata — the article may be modelled under a different Wikidata item (no exact P225 match). Check before drafting a new stub.">?</a>`;
  }
  const readiness = stubReadiness(t);
  if (!readiness.ready) {
    return `<span class="badge no blocked" title="Can't draft a stub yet — ${readiness.blockers.join('; ')}. Resolve this on the taxon's curation page first.">✗</span>`;
  }
  return `<button class="badge no stub-btn" data-inat-id="${t.inatId}" data-lang="${code}" title="No ${code} Wikipedia article — click to draft a stub">✗</button>`;
}

function renderImageCell(t) {
  const p = t.obsPhoto;
  if (!p) return '<span class="pill">no photo</span>';
  const thumb = `<img class="thumb" src="${p.squareUrl}" alt="" title="Photo from an observation in this run — this is what a Commons upload below would use">`;
  let status;
  if (!COMMONS_COMPATIBLE_LICENSES[p.licenseCode]) {
    const label = p.licenseCode ? p.licenseCode.toUpperCase() : 'all rights reserved';
    status = `<span class="pill" title="Not Commons-compatible (needs CC0 / CC BY / CC BY-SA)">${label}</span>`;
  } else if (p.commonsFile) {
    status = `<a class="pill pill-ok" href="${p.commonsFile.pageUrl}" target="_blank" rel="noopener">on Commons ✓</a>`;
  } else {
    status = `<button class="small-btn commons-btn" data-inat-id="${t.inatId}">prepare upload</button>`;
  }
  return `<div class="image-cell">${thumb}${status}</div>`;
}

function renderTable() {
  tbody.innerHTML = '';
  const rows = currentTaxa.filter(matchesFilter);
  for (const t of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = buildTaxonRowCells(t, { linkName: true });
    tbody.appendChild(tr);
  }
}

// The full set of per-taxon status cells (photo, Wikidata/GBIF/Commons/Wikipedia/Plazi/BHL
// state and actions) — shared verbatim between each row of the main table and the single,
// enlarged row at the top of a taxon's dedicated curation page (renderTaxonDetail), so
// every action button and its handler works identically in both places with no duplicated
// logic. `linkName`: table rows link the name into the curation page; the curation page
// itself doesn't need to link to where it already is.
function buildTaxonRowCells(t, { linkName = false } = {}) {
  // Prefer the real photo from an observation in THIS run's own scope — the same one
  // the Image column and any Commons upload use — over iNaturalist's taxon-wide
  // "default photo" (picked from any observer, anywhere, unrelated to this project or
  // user). Showing the taxon-wide photo here while the Image column shows a different,
  // scope-verified one is confusing at best and, next to "prepare upload", looks like
  // the wrong photo might be getting uploaded. Only fall back to it, clearly labelled,
  // when this run found no photo of its own for the taxon at all.
  const usingObsPhoto = !!(t.obsPhoto && t.obsPhoto.squareUrl);
  const photoUrl = usingObsPhoto ? t.obsPhoto.squareUrl : t.photo;
  const photoTitle = usingObsPhoto
    ? 'Photo from an observation in this run'
    : (t.photo ? "iNaturalist's general default photo for this taxon — no photo found on any observation in this run" : '');
  const photo = photoUrl ? `<img class="thumb" src="${photoUrl}" alt="" title="${photoTitle}">` : `<div class="thumb"></div>`;
  const wdLink = t.wikidata
    ? `<a href="${t.wikidata.uri}" target="_blank" rel="noopener">${t.wikidata.qid}</a>${t.wikidataAmbiguous ? ' <span class="pill" title="Multiple Wikidata items share this scientific name">⚠ ambiguous</span>' : ''}`
    : '';
  const wd = !t.wikidata
    ? `<span class="pill">not found</span> <button class="small-btn qs-btn" data-inat-id="${t.inatId}">propose QuickStatements</button>`
    : t.wikidataInatIdConflict
      ? `${wdLink} <button class="small-btn inatconflict-btn" data-inat-id="${t.inatId}">⚠ ${t.wikidataInatIdConflict.length} iNat IDs — which to remove?</button>`
      : inatIdLinked(t)
        ? wdLink
        : `${wdLink} <span class="pill" title="This item has no iNaturalist taxon id (P3151) pointing back at ${t.inatId}">⚠ no iNat ID</span> <button class="small-btn inatlink-btn" data-inat-id="${t.inatId}">link iNat ID</button>`;
  const gbif = t.wikidata && t.wikidata.gbif
    ? `<a href="https://www.gbif.org/species/${t.wikidata.gbif}" target="_blank" rel="noopener">${t.wikidata.gbif}</a>`
    : '<span class="pill">—</span>';
  const commons = t.wikidata && t.wikidata.commonsCat
    ? `<a href="https://commons.wikimedia.org/wiki/Category:${encodeURIComponent(t.wikidata.commonsCat)}" target="_blank" rel="noopener">category</a>`
    : '<span class="pill">—</span>';
  const plazi = t.plaziCount === null
    ? '<span class="pill" title="Plazi lookup only supports species-rank binomials">n/a</span>'
    : t.plaziCount > 0
      ? `<button class="small-btn plazi-btn" data-genus="${encodeURIComponent(t.plaziGenusSpecies.genus)}" data-species="${encodeURIComponent(t.plaziGenusSpecies.species)}">${t.plaziCount} treatment${t.plaziCount === 1 ? '' : 's'}</button>`
      : '<span class="pill">0</span>';
  const image = renderImageCell(t);
  const name = linkName
    ? `<a class="taxon-name" href="${taxonUrl(t.inatId)}" title="Open this taxon's curation page">${t.name}</a>`
    : `<span class="taxon-name">${t.name}</span>`;

  return `
      <td>${photo}</td>
      <td>
        ${name}
        ${t.commonName ? `<span class="taxon-common">${t.commonName}</span>` : ''}
      </td>
      <td>${image}</td>
      <td><a href="${inatTaxonUrl(t)}" target="_blank" rel="noopener">${t.obsCount} obs.</a></td>
      <td>${wd}</td>
      <td>${gbif}</td>
      <td>${commons}</td>
      <td>${langBadge(t, 'en')}</td>
      <td>${langBadge(t, 'ja')}</td>
      <td>${langBadge(t, 'es')}</td>
      <td>${langBadge(t, 'pt')}</td>
      <td>${plazi}</td>
      <td><button class="small-btn bhl-btn" data-taxon="${encodeURIComponent(t.name)}">look up</button></td>
    `;
}

// ---------- Taxon curation page ----------
// A dedicated, focused view for one taxon — everything this tool can do for it, in one
// place, with the Wikidata and Wikipedia actions already expanded (not click-to-reveal
// like the table, where that same clutter-avoidance would defeat the point of a page
// whose entire job is showing you everything there is to do). Reachable by clicking a
// taxon's name in the table (#taxon=<inatId>) — bookmarkable/shareable since it's a real
// URL hash, though resolving it still requires this run's own currentTaxa (no backend to
// look a bare taxon id up against without first loading a project or user).

function taxonUrl(inatId) { return `#taxon=${inatId}`; }

// Bumped on every call so an in-flight render can tell it's been superseded (the curation
// page can be re-entered quickly — a real click, or a picked image re-rendering the whole
// page — and this function has several `await`s in between its DOM writes; without this,
// two overlapping calls can interleave and leave the row from one render sitting next to
// the action panels from a different taxon's render). Each call checks its own token
// against the current one after every await and bails without writing if it's stale.
let taxonDetailRenderToken = 0;

async function renderTaxonDetail(t) {
  const myToken = ++taxonDetailRenderToken;
  statsEl.hidden = true;
  filtersEl.hidden = true;
  bulkActionsEl.hidden = true;
  tableWrapEl.hidden = true;
  taxonDetailEl.hidden = false;

  taxonDetailRowEl.innerHTML = buildTaxonRowCells(t, { linkName: false });

  let ctx = null;
  try { ctx = await ensureStubContext(t); } catch (e) { /* header/actions degrade gracefully without it */ }
  if (myToken !== taxonDetailRenderToken) return;
  const ancestry = ctx ? RANK_ORDER.map(r => ctx.ranks[r]).filter(Boolean).join(' › ') : '';
  const usingObsPhoto = !!(t.obsPhoto && t.obsPhoto.squareUrl);
  const photoUrl = (usingObsPhoto && t.obsPhoto.originalUrl) || t.photo;

  taxonDetailHeaderEl.innerHTML = `
    ${photoUrl ? `<img class="taxon-detail-photo" src="${photoUrl}" alt="">` : ''}
    <div>
      <h2><span class="taxon-name">${t.name}</span>${t.commonName ? ` <span class="taxon-common-inline">${t.commonName}</span>` : ''}</h2>
      ${ancestry ? `<p class="taxon-detail-ancestry">${ancestry}</p>` : ''}
      <p><a href="${inatTaxonUrl(t)}" target="_blank" rel="noopener">${t.rank || 'taxon'} on iNaturalist</a> — ${t.obsCount} observation${t.obsCount === 1 ? '' : 's'} in this run</p>
    </div>
  `;

  const panels = [];

  // Wikidata: whichever single action applies, built and shown immediately instead of
  // waiting for the same click this taxon's table row would need.
  if (!t.wikidata) {
    try {
      const commands = await buildQuickStatements(t);
      panels.push(taxonActionPanel('Wikidata — not found',
        `<em>${t.name}</em> has no Wikidata item. Proposed QuickStatements to create one, assembled from iNaturalist (rank, ancestor chain, taxon id), GBIF and NCBI Taxonomy — review before running, this is a draft.`,
        commands, { showQsLink: true }));
    } catch (e) {
      panels.push(taxonActionPanel('Wikidata — not found', `Could not build QuickStatements: ${e.message}`, ''));
    }
  } else if (t.wikidataAmbiguous) {
    panels.push(taxonActionPanel('Wikidata — ambiguous match',
      `Multiple Wikidata items share the scientific name <em>${t.name}</em>; this taxon was matched to
      <a href="${t.wikidata.uri}" target="_blank" rel="noopener">${t.wikidata.qid}</a>, but this tool can't be
      sure that's the right one. <strong>Wikipedia stub drafting is disabled</strong> until this is resolved —
      compare the candidates on Wikidata directly and add the correct iNaturalist id (<code>P3151</code>) to
      whichever one is actually this taxon, so future runs can disambiguate automatically.`, ''));
  } else if (t.wikidataInatIdConflict) {
    panels.push(taxonActionPanel(`Wikidata — ${t.wikidataInatIdConflict.length} iNat IDs on ${t.wikidata.qid}`,
      inatIdConflictDetail(t) + '<p><strong>Wikipedia stub drafting is disabled</strong> until this is resolved.</p>', ''));
  } else if (!inatIdLinked(t)) {
    panels.push(taxonActionPanel(`Wikidata — ${t.wikidata.qid} missing its iNat ID`,
      `This item exists but has no <code>P3151</code> statement pointing back at iNaturalist taxon ${t.inatId}.
      <strong>Wikipedia stub drafting is disabled</strong> until this is linked. Proposed QuickStatements to add just that:`,
      buildInatIdLinkQS(t), { showQsLink: true }));
  }

  // Synonymy/homonymy — informational (and, when t.wikidata is null, a potential rescue
  // path), so attempted regardless of which case applied above. Degrades silently: a
  // failed lookup here shouldn't block the rest of the page.
  try {
    const synInfo = await buildSynonymyInfo(t, ctx);
    if (myToken !== taxonDetailRenderToken) return;
    const panel = synonymyPanel(t, synInfo);
    if (panel) panels.push(panel);
  } catch (e) { /* informational only */ }

  // Wikipedia: one auto-drafted stub per still-missing language, all at once. Each
  // stub's lead sentence starts with no citation ({{citation needed}}) — iNaturalist
  // itself isn't a reliable source to cite — so fetch this taxon's BHL literature once,
  // up front, and let the picker on each language panel swap in a real one. Both this and
  // the candidate-image lookup below are cached on `t` (not re-fetched) so that picking
  // an image — which re-renders this whole page — doesn't repeat either query.
  const readiness = stubReadiness(t);
  const missingLangs = LANGS.filter(l => t.wikidata && (!t.wikipedia || !t.wikipedia[l.code]) && !inatWikipediaLangMatch(t, l.code));
  if (readiness.ready && missingLangs.length) {
    if (!t._bhlResults) {
      try { t._bhlResults = await fetchBHL(t.name); } catch (e) { t._bhlResults = []; }
    }
    const images = await ensureCandidateImages(t).catch(() => []);
    panels.push(imageSelectorPanel(t, images));
    for (const l of missingLangs) {
      try {
        const wikitext = await buildStub(t, l.code);
        panels.push(wikipediaStubPanel(t, l.code, wikitext));
      } catch (e) {
        panels.push(taxonActionPanel(`Wikipedia (${l.code}) — no article`, `Could not draft a stub: ${e.message}`, ''));
      }
    }
  } else if (!readiness.ready && t.wikidata && missingLangs.length) {
    panels.push(`<p class="identity-note">Wikipedia stub drafting for ${missingLangs.map(l => l.code).join('/')} is disabled until the Wikidata issue above is resolved.</p>`);
  }

  if (myToken !== taxonDetailRenderToken) return;
  taxonDetailActionsEl.innerHTML = panels.length
    ? panels.join('')
    : '<p class="identity-note">Nothing outstanding — Wikidata is linked with a matching iNaturalist id, and every tracked language already has an article.</p>';
}

let taxonActionPanelSeq = 0;
// showQsLink: only Wikidata-action panels (QuickStatements content) need the
// "Open QuickStatements" link — a Wikipedia stub's textarea holds wikitext, not
// QuickStatements, and already carries its own "Open X.wikipedia.org editor" link in
// bodyHtml, so showing a QuickStatements link next to it would be actively wrong.
function taxonActionPanel(title, bodyHtml, textareaContent, { showQsLink = false } = {}) {
  const id = `taxon-action-${taxonActionPanelSeq++}`;
  return `<div class="identity-panel taxon-action-panel">
    <h3>${title}</h3>
    <div>${bodyHtml}</div>
    ${textareaContent ? `
      <div class="stub-toolbar">
        <button class="small-btn copy-stub-btn" data-target="${id}">Copy</button>
        ${showQsLink ? '<a class="small-btn" href="https://quickstatements.toolforge.org/" target="_blank" rel="noopener">Open QuickStatements ↗</a>' : ''}
      </div>
      <textarea id="${id}" class="stub-textarea" readonly spellcheck="false">${textareaContent}</textarea>
    ` : ''}
  </div>`;
}

// BHL titles come from a live SPARQL graph, not something this app controls the shape
// of — escape before dropping one into an <option>'s markup rather than its text.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// One image picker feeds every drafted stub's infobox (not per-language — the same
// photo applies to all of them), sourced from images already on Wikidata/Commons for
// this taxon rather than only this run's own observation photo. Picking one re-renders
// the whole curation page (renderTaxonDetail) so every stub panel below picks it up via
// commonsImageFilename(); returns '' when there's nothing to pick from.
// Always rendered (not only when candidates exist) — same reasoning as the BHL picker's
// "no literature found" note: a panel that silently disappears when empty is
// indistinguishable from one that never ran, which is exactly what made this hard to
// find in practice. Showing "none found" is what actually confirms the check happened.
function imageSelectorPanel(t, images) {
  const intro = t._selectedImage
    ? ` Currently using <code>${escapeHtml(t._selectedImage)}</code>.`
    : " None selected — stubs fall back to this run's own uploaded observation photo, if any.";
  if (!images.length) {
    return `<div class="identity-panel taxon-action-panel">
      <h3>Infobox image</h3>
      <p class="identity-note">No existing images found on Wikidata or Commons for this taxon
        (checked Wikidata's <code>P18</code> and Commons' "depicts" statements).${intro}</p>
    </div>`;
  }
  const thumbs = images.map(img => {
    const selected = t._selectedImage === img.filename;
    return `<button class="image-pick-btn${selected ? ' selected' : ''}" data-inat-id="${t.inatId}" data-filename="${escapeHtml(img.filename)}" title="${escapeHtml(img.filename)} — ${img.source}">
      <img src="${commonsThumbUrl(img.filename)}" alt="${escapeHtml(img.filename)}">
    </button>`;
  }).join('');
  const clearBtn = t._selectedImage
    ? `<button class="small-btn image-pick-clear" data-inat-id="${t.inatId}">Clear selection</button>`
    : '';
  return `<div class="identity-panel taxon-action-panel">
    <h3>Infobox image</h3>
    <div>Existing images already on Wikidata or Commons for this taxon — pick one to use as the
      infobox image in every stub drafted below.${intro}
    </div>
    <div class="image-picker">${thumbs}</div>
    ${clearBtn}
  </div>`;
}

document.addEventListener('click', async (e) => {
  const pickBtn = e.target.closest('.image-pick-btn');
  const clearBtn = e.target.closest('.image-pick-clear');
  if (!pickBtn && !clearBtn) return;
  const t = currentTaxa.find(x => x.inatId === Number((pickBtn || clearBtn).dataset.inatId));
  if (!t) return;
  t._selectedImage = pickBtn ? pickBtn.dataset.filename : null;
  await renderTaxonDetail(t);
});

// A Wikipedia stub panel gets its own renderer (rather than going through
// taxonActionPanel) because it needs a live control the generic panel doesn't: a picker
// for which BHL literature record — if any — to cite the lead sentence with, since
// iNaturalist itself can't be. `t._bhlResults` is populated once per taxon (shared by
// every language's panel) by renderTaxonDetail before this is called.
function wikipediaStubPanel(t, lang, wikitext) {
  const id = `taxon-action-${taxonActionPanelSeq++}`;
  const bhlResults = t._bhlResults || [];
  const options = ['<option value="">No citation ({{citation needed}})</option>']
    .concat(bhlResults.map((r, i) =>
      `<option value="${i}">${escapeHtml((r.title || '(untitled)').slice(0, 70))}${r.date ? ` (${escapeHtml(r.date)})` : ''}</option>`
    ));
  const bhlNote = bhlResults.length
    ? ''
    : '<p class="identity-note">No BHL literature found for this taxon.</p>';
  return `<div class="identity-panel taxon-action-panel">
    <h3>Wikipedia (${lang}) — no article</h3>
    <div>
      Draft ${lang} stub for <em>${t.name}</em>, similar to
      <a href="https://github.com/wikiproject-biodiversity/taxonname-wpstubmaker" target="_blank" rel="noopener">taxonname-wpstubmaker</a>.
      Review before publishing.
      <a class="small-btn" href="${editUrl(lang, t.name)}" target="_blank" rel="noopener">Open ${lang}.wikipedia.org editor ↗</a>
    </div>
    <div class="stub-toolbar">
      <label class="bhl-citation-label">Cite lead sentence from BHL:
        <select class="bhl-citation-select" data-inat-id="${t.inatId}" data-lang="${lang}" data-target="${id}">
          ${options.join('')}
        </select>
      </label>
    </div>
    ${bhlNote}
    <div class="stub-toolbar manual-citation">
      <input type="text" class="manual-citation-title" placeholder="Title (auto-filled for a DOI if left blank)">
      <input type="text" class="manual-citation-url" placeholder="...or cite a URL or DOI instead">
      <button class="small-btn manual-citation-apply" data-inat-id="${t.inatId}" data-lang="${lang}" data-target="${id}">Use this citation</button>
    </div>
    <div class="manual-citation-wd-propose"></div>
    <div class="stub-toolbar">
      <button class="small-btn copy-stub-btn" data-target="${id}">Copy</button>
    </div>
    <textarea id="${id}" class="stub-textarea" readonly spellcheck="false">${wikitext}</textarea>
  </div>`;
}

const DOI_RE = /^(?:https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/\S+)$/i;

function extractDoi(value) {
  const m = String(value).trim().match(DOI_RE);
  return m ? m[1] : null;
}

// Crossref's REST API needs no key and covers the vast majority of DOIs a curator would
// plausibly cite (journal articles, most published descriptions) — used to auto-fill
// title/journal/year from just a DOI, the same way the BHL picker saves retyping a
// citation that's already fully described somewhere machine-readable.
async function fetchCrossrefWork(doi) {
  const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Crossref HTTP ${res.status}`);
  const msg = (await res.json()).message || {};
  const dateParts = (msg.published && msg.published['date-parts'] && msg.published['date-parts'][0])
    || (msg['published-print'] && msg['published-print']['date-parts'] && msg['published-print']['date-parts'][0])
    || (msg['published-online'] && msg['published-online']['date-parts'] && msg['published-online']['date-parts'][0]);
  return {
    title: (msg.title && msg.title[0]) || '',
    containerTitle: (msg['container-title'] && msg['container-title'][0]) || '',
    date: dateParts ? String(dateParts[0]) : '',
  };
}

// {{cite doi}} pulled a full citation from a bot-maintained subpage keyed by the DOI —
// deprecated and discontinued around 2016. Its live successor is {{cite Q}}, which pulls
// the same kind of structured citation straight from a Wikidata item's own statements
// instead. So before falling back to an inline |doi= citation, check whether the
// publication already has a Wikidata item — Wikidata convention stores P356 (DOI)
// uppercased, so that's what gets queried.
async function fetchWikidataItemByDoi(doi) {
  const rows = await sparqlFirstRowWithFallback(
    `PREFIX wdt: <http://www.wikidata.org/prop/direct/>
SELECT ?item WHERE { ?item wdt:P356 ${sparqlStringLiteral(doi.toUpperCase())} } LIMIT 1`,
    `Wikidata lookup by DOI ${doi}`
  );
  return rows.length ? rows[0].item.split('/').pop() : null;
}

// A minimal CREATE draft for the publication itself — P31 scholarly article, the DOI,
// and whatever Crossref supplied (title as both a label and P1476, a year-precision
// P577). Like every other QuickStatements draft in this tool, this is only ever a
// proposal to copy/paste and review; nothing here touches Wikidata directly. Once a
// curator actually runs it, the taxon's citation can be switched to {{cite Q}} by
// re-entering the same DOI (it'll resolve on Wikidata this time).
function buildPublicationQS(doi, meta) {
  const lines = ['CREATE', `LAST\tP31\tQ13442814`, `LAST\tP356\t${qsString(doi.toUpperCase())}`];
  if (meta.title) {
    lines.push(`LAST\tLen\t${qsString(meta.title)}`);
    lines.push(`LAST\tP1476\ten:${qsString(meta.title)}`);
  }
  if (meta.date) lines.push(`LAST\tP577\t+${meta.date}-00-00T00:00:00Z/9`);
  return lines.join('\n');
}

document.addEventListener('change', async (e) => {
  const select = e.target.closest('.bhl-citation-select');
  if (!select) return;
  const t = currentTaxa.find(x => x.inatId === Number(select.dataset.inatId));
  const textarea = document.getElementById(select.dataset.target);
  if (!t || !textarea) return;
  const chosen = select.value === '' ? null : (t._bhlResults || [])[Number(select.value)];
  const citation = chosen ? { title: chosen.title, containerTitle: chosen.containerTitle, date: chosen.date, url: chosen.part } : null;
  select.disabled = true;
  try {
    textarea.value = await buildStub(t, select.dataset.lang, citation);
    // A BHL pick and a manual one are alternatives for the same single citation slot —
    // picking one should visibly clear the other, so the panel never shows two active
    // choices when only the most recent one actually took effect.
    const panel = select.closest('.taxon-action-panel');
    const manualUrl = panel && panel.querySelector('.manual-citation-url');
    if (manualUrl) { manualUrl.value = ''; panel.querySelector('.manual-citation-title').value = ''; }
  } catch (err) {
    log(`Could not rebuild stub with the chosen citation: ${err.message}`, 'warn');
  } finally {
    select.disabled = false;
  }
});

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.manual-citation-apply');
  if (!btn) return;
  const panel = btn.closest('.taxon-action-panel');
  const urlInput = panel.querySelector('.manual-citation-url');
  const titleInput = panel.querySelector('.manual-citation-title');
  const raw = urlInput.value.trim();
  if (!raw) return;
  const t = currentTaxa.find(x => x.inatId === Number(btn.dataset.inatId));
  const textarea = document.getElementById(btn.dataset.target);
  if (!t || !textarea) return;

  const proposeBox = panel.querySelector('.manual-citation-wd-propose');
  proposeBox.innerHTML = '';
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const doi = extractDoi(raw);
    let citation;
    if (doi) {
      const qid = await fetchWikidataItemByDoi(doi).catch(() => null);
      if (qid) {
        citation = { qid };
      } else {
        let meta = {};
        if (!titleInput.value.trim()) {
          try { meta = await fetchCrossrefWork(doi); } catch (err) { log(`Crossref lookup for ${doi} failed: ${err.message}`, 'warn'); }
        }
        citation = { title: titleInput.value.trim() || meta.title || raw, containerTitle: meta.containerTitle || '', date: meta.date || '', doi };
        // Not on Wikidata yet — offer to propose it, same as every other "not found"
        // case in this tool. Once a curator actually creates it, re-entering this DOI
        // will resolve on Wikidata and switch the citation to {{cite Q}} instead.
        const qsId = `${btn.dataset.target}-wd-qs`;
        proposeBox.innerHTML = `<p class="identity-note">This DOI has no Wikidata item yet.</p>
          <div class="stub-toolbar">
            <button class="small-btn copy-stub-btn" data-target="${qsId}">Copy commands</button>
            <a class="small-btn" href="https://quickstatements.toolforge.org/" target="_blank" rel="noopener">Open QuickStatements ↗</a>
          </div>
          <textarea id="${qsId}" class="stub-textarea" readonly spellcheck="false">${buildPublicationQS(doi, citation)}</textarea>`;
      }
    } else {
      citation = { title: titleInput.value.trim() || raw, url: raw };
    }
    textarea.value = await buildStub(t, btn.dataset.lang, citation);
    // Same reasoning as the BHL select above, in reverse: a manual citation just took
    // effect, so any BHL selection shown as "active" would be stale.
    const select = panel.querySelector('.bhl-citation-select');
    if (select) select.value = '';
  } catch (err) {
    log(`Could not build a citation from "${raw}": ${err.message}`, 'warn');
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
});

function showTableView() {
  taxonDetailRenderToken++; // invalidate any renderTaxonDetail still in flight
  taxonDetailEl.hidden = true;
  if (currentTaxa.length) {
    statsEl.hidden = false;
    filtersEl.hidden = false;
    tableWrapEl.hidden = false;
    updateStats(); // re-derives the bulk-action button's visibility too
  }
}

function syncViewFromHash() {
  const m = location.hash.match(/^#taxon=(\d+)$/);
  if (!m) { showTableView(); return; }
  const t = currentTaxa.find(x => x.inatId === Number(m[1]));
  if (!t) { showTableView(); return; } // nothing loaded yet that matches — nothing to show
  renderTaxonDetail(t);
}

window.addEventListener('hashchange', syncViewFromHash);
taxonDetailBackBtn.addEventListener('click', () => { location.hash = ''; });

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.bhl-btn');
  if (!btn) return;
  const name = decodeURIComponent(btn.dataset.taxon);
  btn.disabled = true;
  btn.textContent = 'looking up…';
  const row = btn.closest('tr');
  let bhlRow = row.nextElementSibling;
  if (bhlRow && bhlRow.classList.contains('bhl-row')) {
    bhlRow.remove();
    btn.disabled = false;
    btn.textContent = 'look up';
    return;
  }
  try {
    const results = await fetchBHL(name);
    bhlRow = document.createElement('tr');
    bhlRow.className = 'bhl-row';
    if (results.length === 0) {
      bhlRow.innerHTML = `<td></td><td colspan="12">No BHL literature found for <em>${name}</em> in this experimental knowledge graph (koetai.semscape.org) — it may simply not be indexed yet.</td>`;
    } else {
      const items = results.map(r =>
        `<li>${r.date ? `<strong>${r.date}</strong> — ` : ''}${r.title}${r.containerTitle ? ` <em>(${r.containerTitle})</em>` : ''} ${r.part ? `<a href="${r.part}" target="_blank" rel="noopener">↗</a>` : ''}</li>`
      ).join('');
      bhlRow.innerHTML = `<td></td><td colspan="12">BHL literature mentioning <em>${name}</em> (federated query: BHL graph → Wikidata via QLever → Wikipedia via WDQS):<ul>${items}</ul></td>`;
    }
    row.after(bhlRow);
  } catch (err) {
    bhlRow = document.createElement('tr');
    bhlRow.className = 'bhl-row';
    bhlRow.innerHTML = `<td></td><td colspan="12">BHL lookup failed: ${err.message}</td>`;
    row.after(bhlRow);
  } finally {
    btn.disabled = false;
    btn.textContent = 'look up';
  }
});

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.plazi-btn');
  if (!btn) return;
  const genus = decodeURIComponent(btn.dataset.genus);
  const species = decodeURIComponent(btn.dataset.species);
  const label = `${genus} ${species}`;
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'looking up…';
  const row = btn.closest('tr');
  let plaziRow = row.nextElementSibling;
  if (plaziRow && plaziRow.classList.contains('plazi-row')) {
    plaziRow.remove();
    btn.disabled = false;
    btn.textContent = originalText;
    return;
  }
  try {
    const results = await fetchPlaziDetail(genus, species);
    plaziRow = document.createElement('tr');
    plaziRow.className = 'bhl-row plazi-row';
    const items = results.map(r => {
      const title = r.title || '(untitled treatment)';
      const doiLink = r.doi ? ` <a href="${r.doi}" target="_blank" rel="noopener">↗</a>` : '';
      return `<li>${title}${r.creator ? ` <em>(${r.creator})</em>` : ''}${doiLink}</li>`;
    }).join('');
    plaziRow.innerHTML = `<td></td><td colspan="12">Plazi TreatmentBank treatments for <em>${label}</em> (via SynoSpecies' QLever endpoint):<ul>${items}</ul></td>`;
    row.after(plaziRow);
  } catch (err) {
    plaziRow = document.createElement('tr');
    plaziRow.className = 'bhl-row plazi-row';
    plaziRow.innerHTML = `<td></td><td colspan="12">Plazi lookup failed: ${err.message}</td>`;
    row.after(plaziRow);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
});

// The two (or more) P3151 values on the item aren't interchangeable clutter — exactly
// one of them can be checked against live data (this taxon's OWN current iNaturalist
// id, fetched this run) without a curator lifting a finger, so lead with that instead of
// just dumping the raw id list in a tooltip.
function inatIdConflictDetail(t) {
  const current = String(t.inatId);
  const items = t.wikidataInatIdConflict.map(v => {
    const isCurrent = v === current;
    const url = `https://www.inaturalist.org/taxa/${v}`;
    return isCurrent
      ? `<li>✓ <a href="${url}" target="_blank" rel="noopener">${v}</a> — matches this taxon's current iNaturalist id. Keep this one.</li>`
      : `<li>⚠ <a href="${url}" target="_blank" rel="noopener">${v}</a> — does not match the current id (${current}). Open it on iNaturalist: if it redirects to ${current}, it's been merged/renamed and this statement is the one to remove from Wikidata.</li>`;
  }).join('');
  const hasCurrent = t.wikidataInatIdConflict.includes(current);
  const guidance = hasCurrent
    ? `This tool won't remove anything automatically — a stale id could still be intentional (e.g. covering a former taxon concept) — but in the common case it's safe to delete the ⚠ statement(s) after confirming the redirect.`
    : `None of the ids currently on the item match what iNaturalist calls this taxon today (<a href="https://www.inaturalist.org/taxa/${current}" target="_blank" rel="noopener">${current}</a>) — check each one individually before changing anything on Wikidata.`;
  return `<em>${t.name}</em> — <a href="${t.wikidata.uri}" target="_blank" rel="noopener">${t.wikidata.qid}</a> carries ${t.wikidataInatIdConflict.length} different iNaturalist taxon id (P3151) statements:
    <ul>${items}</ul>
    ${guidance}`;
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.inatconflict-btn');
  if (!btn) return;
  const inatId = Number(btn.dataset.inatId);
  const t = currentTaxa.find(x => x.inatId === inatId);
  if (!t || !t.wikidataInatIdConflict) return;

  const row = btn.closest('tr');
  const nextRow = row.nextElementSibling;
  if (nextRow && nextRow.classList.contains('inatconflict-row')) {
    nextRow.remove();
    return;
  }
  const detailRow = document.createElement('tr');
  detailRow.className = 'bhl-row inatconflict-row';
  detailRow.innerHTML = `<td></td><td colspan="12">${inatIdConflictDetail(t)}</td>`;
  row.after(detailRow);
});

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.stub-btn');
  if (!btn) return;
  const inatId = Number(btn.dataset.inatId);
  const lang = btn.dataset.lang;
  const t = currentTaxa.find(x => x.inatId === inatId);
  if (!t) return;

  const row = btn.closest('tr');
  const stubRow = row.nextElementSibling;
  if (stubRow && stubRow.classList.contains('stub-row')) {
    stubRow.remove();
    return;
  }

  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const wikitext = await buildStub(t, lang);
    const box = document.createElement('tr');
    box.className = 'bhl-row stub-row';
    const rowId = `stub-${inatId}-${lang}-${Date.now()}`;
    box.innerHTML = `<td></td><td colspan="12">
      Draft ${lang} Wikipedia stub for <em>${t.name}</em> — generated from iNaturalist + GBIF + Wikidata,
      similar to <a href="https://github.com/wikiproject-biodiversity/taxonname-wpstubmaker" target="_blank" rel="noopener">taxonname-wpstubmaker</a>.
      Review before publishing.
      <div class="stub-toolbar">
        <button class="small-btn copy-stub-btn" data-target="${rowId}">Copy wikitext</button>
        <a class="small-btn" href="${editUrl(lang, t.name)}" target="_blank" rel="noopener">Open ${lang}.wikipedia.org editor ↗</a>
      </div>
      <textarea id="${rowId}" class="stub-textarea" readonly spellcheck="false">${wikitext}</textarea>
    </td>`;
    row.after(box);
  } catch (err) {
    const box = document.createElement('tr');
    box.className = 'bhl-row stub-row';
    box.innerHTML = `<td></td><td colspan="12">Could not draft a stub: ${err.message}</td>`;
    row.after(box);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
});

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.commons-btn');
  if (!btn) return;
  const inatId = Number(btn.dataset.inatId);
  const t = currentTaxa.find(x => x.inatId === inatId);
  if (!t || !t.obsPhoto) return;

  const row = btn.closest('tr');
  const uploadRow = row.nextElementSibling;
  if (uploadRow && uploadRow.classList.contains('upload-row')) {
    uploadRow.remove();
    return;
  }

  const wikitext = buildCommonsWikitext(t);
  const filename = suggestedCommonsFilename(t);
  const uploadUrl = buildCommonsUploadUrl(t);
  const rowId = `upload-${inatId}-${Date.now()}`;
  const domainId = `domstatus-${inatId}-${Date.now()}`;
  const host = new URL(t.obsPhoto.originalUrl).hostname;
  const box = document.createElement('tr');
  box.className = 'bhl-row upload-row';
  box.innerHTML = `<td></td><td colspan="12">
    Commons upload for <em>${t.name}</em> (${t.obsPhoto.licenseCode.toUpperCase()}, by ${t.obsPhoto.observerLogin} on iNaturalist)
    — source host <code>${host}</code> <span id="${domainId}">· checking Commons' upload allow-list…</span>
    <div class="stub-toolbar">
      <a class="small-btn upload-btn" href="${uploadUrl}" target="_blank" rel="noopener">Upload to Wikimedia Commons ↗</a>
      <span class="pill">Suggested filename: ${filename}</span>
      <button class="small-btn copy-stub-btn" data-target="${rowId}">Copy file-page wikitext</button>
    </div>
    <p class="stub-toolbar-hint">
      Opens a pre-filled Commons upload form (same "upload by URL" mechanism as
      <a href="https://andrawaag.github.io/tarsier/" target="_blank" rel="noopener">Tarsier</a>) — Commons fetches the
      photo itself, nothing is transferred through this page. Requires a Wikimedia account; you review and click
      "Upload file" yourself on Commons.
    </p>
    <textarea id="${rowId}" class="stub-textarea" readonly spellcheck="false">${wikitext}</textarea>
  </td>`;
  row.after(box);

  isCommonsUploadDomainAllowed(host).then(allowed => {
    const el = document.getElementById(domainId);
    if (!el) return;
    el.innerHTML = allowed
      ? '· <span class="pill-ok">✓ on Commons\' upload allow-list</span>'
      : '· <span class="pill-warn">⚠ not on Commons\' upload allow-list</span> — upload-by-URL will be rejected; use "Copy file-page wikitext" with Commons\' Upload Wizard instead.';
  }).catch(() => {
    const el = document.getElementById(domainId);
    if (el) el.textContent = '· could not check the allow-list right now';
  });
});

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.qs-btn');
  if (!btn) return;
  const inatId = Number(btn.dataset.inatId);
  const t = currentTaxa.find(x => x.inatId === inatId);
  if (!t) return;

  const row = btn.closest('tr');
  const qsRow = row.nextElementSibling;
  if (qsRow && qsRow.classList.contains('qs-row')) {
    qsRow.remove();
    return;
  }

  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const commands = await buildQuickStatements(t);
    const ctx = t._qsContext;
    const rowId = `qs-${inatId}-${Date.now()}`;
    const box = document.createElement('tr');
    box.className = 'bhl-row qs-row';
    box.innerHTML = `<td></td><td colspan="12">
      Proposed QuickStatements to create a Wikidata item for <em>${t.name}</em> — assembled from
      iNaturalist (rank, ancestor chain, taxon id), GBIF (backbone taxon id${ctx.gbifMatch && ctx.gbifMatch.usageKey ? `: ${ctx.gbifMatch.usageKey}, ${ctx.gbifMatch.matchType} match` : ': no confident match found'})
      and NCBI Taxonomy (taxid${ctx.ncbiTaxonId ? `: ${ctx.ncbiTaxonId}` : ': no unambiguous match found'}).
      ${describeParentResolution(ctx)}
      Review carefully before running — this is a draft, not checked for existing near-duplicates beyond the exact name match already shown in this row.
      <div class="stub-toolbar">
        <button class="small-btn copy-stub-btn" data-target="${rowId}">Copy commands</button>
        <a class="small-btn" href="https://quickstatements.toolforge.org/" target="_blank" rel="noopener">Open QuickStatements ↗</a>
      </div>
      <textarea id="${rowId}" class="stub-textarea" readonly spellcheck="false">${commands}</textarea>
    </td>`;
    row.after(box);
  } catch (err) {
    const box = document.createElement('tr');
    box.className = 'bhl-row qs-row';
    box.innerHTML = `<td></td><td colspan="12">Could not build QuickStatements: ${err.message}</td>`;
    row.after(box);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
});

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.inatlink-btn');
  if (!btn) return;
  const inatId = Number(btn.dataset.inatId);
  const t = currentTaxa.find(x => x.inatId === inatId);
  if (!t || !t.wikidata) return;

  const row = btn.closest('tr');
  const qsRow = row.nextElementSibling;
  if (qsRow && qsRow.classList.contains('qs-row')) {
    qsRow.remove();
    return;
  }

  const commands = buildInatIdLinkQS(t);
  const rowId = `inatlink-${inatId}-${Date.now()}`;
  const box = document.createElement('tr');
  box.className = 'bhl-row qs-row';
  box.innerHTML = `<td></td><td colspan="12">
    Proposed QuickStatements to add the iNaturalist taxon id to the existing item
    <a href="${t.wikidata.uri}" target="_blank" rel="noopener">${t.wikidata.qid}</a> for <em>${t.name}</em>.
    <div class="stub-toolbar">
      <button class="small-btn copy-stub-btn" data-target="${rowId}">Copy commands</button>
      <a class="small-btn" href="https://quickstatements.toolforge.org/" target="_blank" rel="noopener">Open QuickStatements ↗</a>
    </div>
    <textarea id="${rowId}" class="stub-textarea" readonly spellcheck="false">${commands}</textarea>
  </td>`;
  row.after(box);
});

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.copy-stub-btn');
  if (!btn) return;
  const ta = document.getElementById(btn.dataset.target);
  if (!ta) return;
  navigator.clipboard.writeText(ta.value).then(() => {
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = original; }, 1500);
  }).catch(() => {
    ta.select();
  });
});

bulkInatIdBtn.addEventListener('click', () => {
  if (!bulkInatIdBox.hidden) {
    bulkInatIdBox.hidden = true;
    return;
  }
  bulkInatIdTextarea.value = buildBulkInatIdLinkQS(currentTaxa.filter(inatIdMissing));
  bulkInatIdBox.hidden = false;
});

bulkInatIdCopyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(bulkInatIdTextarea.value).then(() => {
    const original = bulkInatIdCopyBtn.textContent;
    bulkInatIdCopyBtn.textContent = 'Copied!';
    setTimeout(() => { bulkInatIdCopyBtn.textContent = original; }, 1500);
  }).catch(() => {
    bulkInatIdTextarea.select();
  });
});

document.getElementById('filters').addEventListener('click', (e) => {
  const btn = e.target.closest('.filter-btn');
  if (!btn) return;
  currentFilter = btn.dataset.filter;
  [...document.querySelectorAll('.filter-btn')].forEach(b => b.classList.toggle('active', b === btn));
  renderTable();
});

// ---------- Identity panel rendering ----------

let identityState = null; // { scopeType, record, linkedQid, orcidMatch, nameCandidates }

function identityNoun(scopeType) { return scopeType === 'user' ? 'user' : 'project'; }

async function checkIdentityLinking(scopeType, scopeValue) {
  identityPanelEl.hidden = false;
  identityPanelEl.innerHTML = `<div class="identity-row">Checking whether this ${identityNoun(scopeType)} is linked on Wikidata…</div>`;

  try {
    const record = scopeType === 'user' ? await fetchINatUser(scopeValue) : await fetchINatProject(scopeValue);
    const linkedQid = scopeType === 'user' ? await checkUserOnWikidata(record) : await checkProjectOnWikidata(record);

    let orcidMatch = null;
    let nameCandidates = [];
    if (!linkedQid) {
      if (scopeType === 'user') {
        orcidMatch = await findWikidataHumanByOrcid(record.orcid).catch(() => null);
        if (!orcidMatch) {
          nameCandidates = await searchWikidataCandidates(record.name || record.login, { humansOnly: true }).catch(() => []);
        }
      } else {
        nameCandidates = await searchWikidataCandidates(record.title, { humansOnly: false }).catch(() => []);
      }
    }

    identityState = { scopeType, record, linkedQid, orcidMatch, nameCandidates };
    renderIdentityPanel();
  } catch (err) {
    identityPanelEl.innerHTML = `<div class="identity-row">Could not check Wikidata linkage: ${err.message}</div>`;
  }
}

function renderIdentityPanel() {
  const { scopeType, record, linkedQid, orcidMatch, nameCandidates } = identityState;
  const noun = identityNoun(scopeType);
  const displayName = scopeType === 'user' ? (record.name || record.login) : record.title;
  const inatUrl = scopeType === 'user'
    ? `https://www.inaturalist.org/people/${record.login}`
    : `https://www.inaturalist.org/projects/${record.slug}`;

  if (linkedQid) {
    identityPanelEl.innerHTML = `<div class="identity-row">
      ✓ iNaturalist ${noun} <a href="${inatUrl}" target="_blank" rel="noopener">${displayName}</a>
      is linked on Wikidata: <a href="https://www.wikidata.org/wiki/${linkedQid}" target="_blank" rel="noopener">${linkedQid}</a>
    </div>`;
    return;
  }

  const rowId = `identity-qs-${Date.now()}`;
  let candidatesHtml = '';
  // An ORCID match is trustworthy enough that offering "create a new item" alongside it
  // would be actively dangerous — it invites a duplicate item for someone who already
  // has one. So the create button is omitted entirely in that case, not just discouraged.
  const showCreateBtn = !orcidMatch;
  if (orcidMatch) {
    candidatesHtml = `<ul class="candidates">
      <li>Matched by ORCID: <a href="https://www.wikidata.org/wiki/${orcidMatch.qid}" target="_blank" rel="noopener">${orcidMatch.qid}</a>
        <button class="small-btn identity-add-btn" data-qid="${orcidMatch.qid}">add identifier to this item</button>
      </li>
    </ul>`;
  } else if (nameCandidates.length) {
    candidatesHtml = `<ul class="candidates">${nameCandidates.map(c => `
      <li>Possible match: <a href="https://www.wikidata.org/wiki/${c.qid}" target="_blank" rel="noopener">${c.qid}</a>
        — ${c.label}${c.description ? ` <em>(${c.description})</em>` : ''}
        <button class="small-btn identity-add-btn" data-qid="${c.qid}">add identifier to this item</button>
      </li>`).join('')}</ul>
      <p class="identity-note">Name matches only — unlike the taxon-parent lookups elsewhere in this tool, these are not backed by a stable id, so verify each one is really the same ${noun} before using it — and check the list above before proposing a new item, to avoid creating a duplicate.</p>`;
  }

  identityPanelEl.innerHTML = `<div class="identity-row">
      ✗ iNaturalist ${noun} <a href="${inatUrl}" target="_blank" rel="noopener">${displayName}</a> is not yet linked on Wikidata.
      ${showCreateBtn ? '<button class="small-btn identity-create-btn">Propose creating a new item</button>' : ''}
    </div>
    ${candidatesHtml}
    <div id="${rowId}-panel"></div>`;
}

function showIdentityQsDraft(commands, label) {
  const rowId = `identity-textarea-${Date.now()}`;
  const panel = document.createElement('div');
  panel.className = 'identity-row';
  panel.style.marginTop = '10px';
  panel.innerHTML = `<div style="width:100%">
    ${label}
    <div class="stub-toolbar">
      <button class="small-btn copy-stub-btn" data-target="${rowId}">Copy commands</button>
      <a class="small-btn" href="https://quickstatements.toolforge.org/" target="_blank" rel="noopener">Open QuickStatements ↗</a>
    </div>
    <textarea id="${rowId}" class="stub-textarea" readonly spellcheck="false">${commands}</textarea>
  </div>`;
  identityPanelEl.appendChild(panel);
}

identityPanelEl.addEventListener('click', (e) => {
  const addBtn = e.target.closest('.identity-add-btn');
  const createBtn = e.target.closest('.identity-create-btn');
  if (!addBtn && !createBtn) return;
  if (!identityState) return;
  const { scopeType, record } = identityState;
  const builder = scopeType === 'user' ? buildUserIdentityQS : buildProjectIdentityQS;
  if (addBtn) {
    const qid = addBtn.dataset.qid;
    const commands = builder(record, 'add', qid);
    showIdentityQsDraft(commands, `Adds the iNaturalist identifier to <a href="https://www.wikidata.org/wiki/${qid}" target="_blank" rel="noopener">${qid}</a>:`);
  } else {
    const commands = builder(record, 'create', null);
    const hint = scopeType === 'user'
      ? ' — review notability before using this; being an iNaturalist contributor alone is not enough'
      : ' — for the iNaturalist project itself, described as such so it isn\'t confused with any broader event/campaign of the same name';
    showIdentityQsDraft(commands, `Draft to create a new Wikidata item${hint}:`);
  }
});

function updateStats() {
  const total = currentTaxa.length;
  const resolved = currentTaxa.filter(t => t.wikidata).length;
  const missingAny = currentTaxa.filter(t => taxonMissingCount(t) > 0).length;
  const missingAll = currentTaxa.filter(t => taxonMissingCount(t) === LANGS.length).length;
  const inatIdMissingCount = currentTaxa.filter(inatIdMissing).length;
  const inatIdConflict = currentTaxa.filter(t => t.wikidataInatIdConflict).length;
  document.getElementById('statTotal').textContent = total;
  document.getElementById('statResolved').textContent = resolved;
  document.getElementById('statMissingAny').textContent = missingAny;
  document.getElementById('statMissingAll').textContent = missingAll;
  document.getElementById('statInatIdMissing').textContent = inatIdMissingCount;
  document.getElementById('statInatIdConflict').textContent = inatIdConflict;
  statsEl.hidden = false;
  updateBulkInatIdAction(inatIdMissingCount);
}

// Collects every taxon still missing its iNaturalist id link into one QuickStatements
// batch, so a large project's worth of one-line fixes doesn't mean clicking "link iNat
// ID" dozens of times — each is still a fully independent statement line, so the batch
// is just those lines concatenated.
function buildBulkInatIdLinkQS(taxa) {
  return taxa.map(buildInatIdLinkQS).join('\n');
}

function updateBulkInatIdAction(count) {
  bulkInatIdBox.hidden = true;
  if (!count) {
    bulkActionsEl.hidden = true;
    return;
  }
  bulkActionsEl.hidden = false;
  bulkInatIdBtn.textContent = `Propose QuickStatements — link all ${count} missing iNat ID${count === 1 ? '' : 's'}`;
}

async function run() {
  const scopeType = scopeTypeSelect.value; // 'project' or 'user'
  const scopeValue = projectInput.value.trim();
  if (!scopeValue) return;
  const noun = scopeType === 'user' ? 'user' : 'project';
  runBtn.disabled = true;
  statusSpinnerEl.hidden = false;
  statusHeaderTextEl.textContent = '';
  statusLogEl.innerHTML = '';
  statsEl.hidden = true;
  filtersEl.hidden = true;
  tableWrapEl.hidden = true;
  identityPanelEl.hidden = true;
  bulkActionsEl.hidden = true;
  bulkInatIdBox.hidden = true;
  taxonDetailEl.hidden = true;
  identityState = null;
  currentTaxa = [];
  if (location.hash) location.hash = ''; // a fresh search always starts on the table, not a stale taxon page

  // Independent of the taxa pipeline below (it's about the scope itself, not the
  // species observed in it), so it runs concurrently rather than blocking on it.
  checkIdentityLinking(scopeType, scopeValue);

  // A step count the user can see progress against, however imprecise any single step's
  // own timing is — "step 3 of 5" is honest and useful even when "how long is step 3"
  // isn't knowable until it's running (see runBatchedStep's live ETA for that part).
  const TOTAL_STEPS = 5;
  const step = (n, label) => `Step ${n}/${TOTAL_STEPS}: ${label}`;

  try {
    setStatusHeader(step(1, `Fetching observations for ${noun} "${scopeValue}"…`));
    const taxa = await fetchScopedTaxa(scopeType, scopeValue, (n, total) => {
      setStatusHeader(step(1, `Fetching observations for ${noun} "${scopeValue}"… ${n}/${total || '?'}`));
    });
    log(`${taxa.length} distinct taxa found.`);

    setStatusHeader(step(2, `Resolving ${taxa.length} taxa against Wikidata (via Comunica → QLever)…`));
    await resolveWikidata(taxa);

    setStatusHeader(step(3, `Checking Wikipedia (en/ja/es/pt) sitelinks (via Comunica → WDQS)…`));
    await resolveSitelinks(taxa);

    setStatusHeader(step(4, `Checking Plazi TreatmentBank (via Comunica → QLever)…`));
    await resolvePlazi(taxa);

    setStatusHeader(step(5, `Checking Wikimedia Commons for existing uploads (via Comunica → QLever)…`));
    await resolveCommonsStatus(taxa);

    currentTaxa = taxa;
    setStatusHeader(`Done — ${taxa.length} taxa loaded.`);
    updateStats();
    filtersEl.hidden = false;
    tableWrapEl.hidden = false;
    currentFilter = 'all';
    [...document.querySelectorAll('.filter-btn')].forEach(b => b.classList.toggle('active', b.dataset.filter === 'all'));
    renderTable();
  } catch (err) {
    setStatusHeader(`Error: ${err.message}`);
    log(err.stack || '', 'err');
  } finally {
    runBtn.disabled = false;
    statusSpinnerEl.hidden = true;
  }
}

runBtn.addEventListener('click', run);
projectInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
