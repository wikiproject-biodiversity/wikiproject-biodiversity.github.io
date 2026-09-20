// iNaturalist × Wikidata/Wikipedia/GBIF/BHL dashboard
// All client-side. SPARQL federation via Comunica (https://comunica.dev).

const INAT_API = 'https://api.inaturalist.org/v1';
const QLEVER_ENDPOINT = 'https://qlever.dev/api/wikidata';
const WDQS_ENDPOINT = 'https://query.wikidata.org/sparql';
const BHL_ENDPOINT = 'https://koetai.semscape.org/u/0000-0001-9773-4008/bhl/sparql';
const PLAZI_ENDPOINT = 'https://qlever.ld.plazi.org/sparql'; // SynoSpecies' QLever mirror of Plazi TreatmentBank
const COMMONS_ENDPOINT = 'https://qlever.dev/api/wikimedia-commons'; // QLever's Wikimedia Commons structured-data mirror

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

function pushWikidataCandidate(byName, r) {
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
      // schema:contentUrl looks like https://upload.wikimedia.org/wikipedia/commons/1/1b/Filename.jpg
      const filename = decodeURIComponent(r.contentUrl.split('/').pop());
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

// Loads (and caches on the taxon object) the extra data needed to draft a stub:
// the iNaturalist ancestor chain (for rank hierarchy + parent taxon) and, if a
// GBIF id is known, the GBIF species record (for authorship / publication ref).
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
  }

  t._stubContext = { detail, ranks, parent, gbif };
  return t._stubContext;
}

function todayISO() { return new Date().toISOString().slice(0, 10); }

// The bare "Filename.jpg" for a taxon's photo, if it's already on Commons
// (either matched by resolveCommonsStatus, or freshly prepared this session).
function commonsImageFilename(t) {
  const pageUrl = t.obsPhoto && t.obsPhoto.commonsFile && t.obsPhoto.commonsFile.pageUrl;
  return pageUrl ? decodeURIComponent(pageUrl.split('File:').pop()) : '';
}

function buildStubEn(t, ctx) {
  const { ranks, parent, gbif } = ctx;
  const authority = (gbif && gbif.authorship) || (ranks.species ? '' : '');
  const publishedInRef = gbif && gbif.publishedIn ? `<ref>${gbif.publishedIn}</ref>` : '';
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

${exordium} is a [[${t.rank}]] from the [[${parent ? parent.rank : ''}]] ''[[${parentName}]]''. ${publishedInRef}<ref name="inaturalist-${t.name.replace(/\s+/g, '-')}">{{cite web |title=${t.name} |url=${inatTaxonUrl(t)} |website=iNaturalist |access-date=${todayISO()} |language=en}}</ref>

==References==
{{Reflist}}
${commonsBlock}${taxonbar}
{{taxon-stub}}
<!-- DRAFT generated from iNaturalist + GBIF + Wikidata data — review before publishing. -->`;
}

function buildStubEs(t, ctx) {
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

'''''${t.name}'''''${t.commonName ? ` es el nombre científico de '''${t.commonName}'''` : ''}, una especie de ${t.rank} perteneciente a ${parent ? parent.name : (ranks.family || '')}.<ref>{{cita web |título=${t.name} |url=${inatTaxonUrl(t)} |sitioweb=iNaturalist |fechaacceso=${todayISO()} |idioma=en}}</ref>

== Referencias ==
{{listaref}}
${taxonbar}
<!-- BORRADOR generado a partir de datos de iNaturalist, GBIF y Wikidata — revisar antes de publicar. Verifica la plantilla de esbozo adecuada. -->`;
}

function buildStubJa(t, ctx) {
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

'''${t.name}'''${t.commonName ? `（${t.commonName}）` : ''}は、${parent ? parent.name : (ranks.family || '')}に属する${t.rank}の一種である。<ref>{{cite web |title=${t.name} |url=${inatTaxonUrl(t)} |website=iNaturalist |accessdate=${todayISO()} |language=en}}</ref>

== 脚注 ==
{{Reflist}}
${taxonbar}
<!-- iNaturalist・GBIF・Wikidataのデータから自動生成した下書きです。公開前に内容と適切なスタブテンプレートを確認してください。 -->`;
}

function buildStubPt(t, ctx) {
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

'''''${t.name}'''''${t.commonName ? `, conhecida popularmente como '''${t.commonName}'''` : ''} é uma espécie de ${t.rank} pertencente a ${parent ? parent.name : (ranks.family || '')}.<ref>{{citar web |título=${t.name} |url=${inatTaxonUrl(t)} |site=iNaturalist |acessodata=${todayISO()} |idioma=en}}</ref>

== Referências ==
{{reflist}}
${taxonbar}
{{esboço-biologia}}
<!-- RASCUNHO gerado a partir de dados do iNaturalist, GBIF e Wikidata — revise antes de publicar. Verifique se o modelo de esboço é o mais adequado. -->`;
}

async function buildStub(t, lang) {
  const ctx = await ensureStubContext(t);
  if (lang === 'en') return buildStubEn(t, ctx);
  if (lang === 'es') return buildStubEs(t, ctx);
  if (lang === 'ja') return buildStubJa(t, ctx);
  if (lang === 'pt') return buildStubPt(t, ctx);
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

function taxonMissingCount(t) {
  if (!t.wikidata || !t.wikipedia) return null;
  return LANGS.filter(l => !t.wikipedia[l.code]).length;
}

// True once the Wikidata item matched by scientific name also carries THIS taxon's
// iNaturalist id as P3151 — a name match alone doesn't mean the two are cross-linked.
function inatIdLinked(t) {
  return !!(t.wikidata && t.wikidata.inat != null && String(t.wikidata.inat) === String(t.inatId));
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
        ? `${wdLink} <span class="pill" title="This item has ${t.wikidataInatIdConflict.length} different iNaturalist taxon ids on it (${t.wikidataInatIdConflict.join(', ')}) — likely an old one left behind after a merge/split. Needs a curator to check iNaturalist and remove the stale statement(s); not something to fix by adding another.">⚠ ${t.wikidataInatIdConflict.length} iNat IDs — needs review</span>`
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

    tr.innerHTML = `
      <td>${photo}</td>
      <td>
        <span class="taxon-name">${t.name}</span>
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
    tbody.appendChild(tr);
  }
}

tbody.addEventListener('click', async (e) => {
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

tbody.addEventListener('click', async (e) => {
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

tbody.addEventListener('click', async (e) => {
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

tbody.addEventListener('click', (e) => {
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

tbody.addEventListener('click', async (e) => {
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

tbody.addEventListener('click', (e) => {
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

tbody.addEventListener('click', (e) => {
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
  identityState = null;
  currentTaxa = [];

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
