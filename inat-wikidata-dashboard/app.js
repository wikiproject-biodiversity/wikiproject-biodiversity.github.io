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
];

const BATCH_SIZE = 40;
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
async function sparqlViaComunica(query, endpoint, { retries = 3, label = '' } = {}) {
  const engine = await getEngine();
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const t0 = performance.now();
    try {
      const bindingsStream = await engine.queryBindings(query, {
        sources: [{ type: 'sparql', value: endpoint }],
        httpTimeout: 30000,
      });
      const rows = await bindingsStream.toArray();
      const out = rows.map(b => {
        const o = {};
        for (const [k, v] of b) o[k.value] = v.value;
        return o;
      });
      log(`${label || endpoint} — ${out.length} rows in ${Math.round(performance.now() - t0)}ms`);
      return out;
    } catch (e) {
      lastErr = e;
      log(`${label || endpoint} — attempt ${attempt + 1} failed: ${e.message}`, true);
      if (attempt < retries) await sleep(800 * (attempt + 1));
    }
  }
  throw lastErr;
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

async function fetchProjectTaxa(projectSlug, onProgress) {
  const observations = [];
  let page = 1;
  const perPage = 200;
  while (observations.length < MAX_OBSERVATIONS) {
    const url = `${INAT_API}/observations?project_id=${encodeURIComponent(projectSlug)}&per_page=${perPage}&page=${page}&order_by=id`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`iNaturalist API HTTP ${res.status} (is "${projectSlug}" a valid project slug/id?)`);
    const json = await res.json();
    if (page === 1 && json.total_results === 0) {
      throw new Error(`No observations found for project "${projectSlug}".`);
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
        obsPhoto: null, // first Commons-relevant photo actually attached to an observation *in this project*
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

async function resolveWikidata(taxa) {
  const byName = new Map();
  for (const batch of chunk(taxa, BATCH_SIZE)) {
    const values = batch.map(t => sparqlStringLiteral(t.name)).join(' ');
    const query = `PREFIX wdt: <http://www.wikidata.org/prop/direct/>
SELECT ?taxonLabel ?wdTaxon ?gbif ?inat ?commonsCat WHERE {
  VALUES ?taxonLabel { ${values} }
  ?wdTaxon wdt:P225 ?taxonLabel .
  OPTIONAL { ?wdTaxon wdt:P846 ?gbif }
  OPTIONAL { ?wdTaxon wdt:P3151 ?inat }
  OPTIONAL { ?wdTaxon wdt:P373 ?commonsCat }
}`;
    const rows = await sparqlViaComunica(query, QLEVER_ENDPOINT, { label: `Wikidata lookup (batch of ${batch.length})` });
    for (const r of rows) {
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
  }

  for (const t of taxa) {
    const candidates = byName.get(t.name) || [];
    let chosen = null;
    let ambiguous = false;
    if (candidates.length === 1) {
      chosen = candidates[0];
    } else if (candidates.length > 1) {
      chosen = candidates.find(c => c.inat === String(t.inatId)) || candidates[0];
      ambiguous = true;
    }
    t.wikidata = chosen;
    t.wikidataAmbiguous = ambiguous;
    t.wikidataCandidateCount = candidates.length;
  }
  return taxa;
}

// ---------- Wikipedia sitelinks ----------

async function resolveSitelinks(taxa) {
  const withWd = taxa.filter(t => t.wikidata);
  const optionals = LANGS.map(l =>
    `OPTIONAL { ?article_${l.code} schema:about ?wdTaxon ; schema:isPartOf <${l.wiki}> . }`
  ).join('\n  ');
  const selectVars = LANGS.map(l => `?article_${l.code}`).join(' ');

  const byQid = new Map();
  for (const batch of chunk(withWd, BATCH_SIZE)) {
    const values = batch.map(t => `wd:${t.wikidata.qid}`).join(' ');
    const query = `PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX schema: <http://schema.org/>
SELECT ?wdTaxon ${selectVars} WHERE {
  VALUES ?wdTaxon { ${values} }
  ${optionals}
}`;
    const rows = await sparqlViaComunica(query, WDQS_ENDPOINT, { label: `Wikipedia sitelinks (batch of ${batch.length})` });
    for (const r of rows) {
      const qid = r.wdTaxon.split('/').pop();
      const langs = {};
      for (const l of LANGS) langs[l.code] = r[`article_${l.code}`] || null;
      byQid.set(qid, langs);
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
  for (const batch of chunk(binomial, BATCH_SIZE)) {
    const values = batch.map(x => `(${sparqlStringLiteral(x.split.genus)} ${sparqlStringLiteral(x.split.species)})`).join(' ');
    const query = `PREFIX dwc: <http://rs.tdwg.org/dwc/terms/>
PREFIX treatment: <http://plazi.org/vocab/treatment#>
SELECT ?genus ?species (COUNT(DISTINCT ?t) AS ?n) WHERE {
  VALUES (?genus ?species) { ${values} }
  ?tc dwc:genus ?genus ; dwc:species ?species .
  ?t (treatment:augmentsTaxonConcept|treatment:definesTaxonConcept) ?tc .
}
GROUP BY ?genus ?species`;
    const rows = await sparqlViaComunica(query, PLAZI_ENDPOINT, { label: `Plazi treatments (batch of ${batch.length})` });
    for (const r of rows) counts.set(`${r.genus}|${r.species}`, parseInt(r.n, 10));
  }

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
  for (const batch of chunk(candidates, BATCH_SIZE)) {
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
    const rows = await sparqlViaComunica(query, COMMONS_ENDPOINT, { label: `Commons duplicate check (batch of ${batch.length})` });
    for (const r of rows) {
      // schema:contentUrl looks like https://upload.wikimedia.org/wikipedia/commons/1/1b/Filename.jpg
      const filename = decodeURIComponent(r.contentUrl.split('/').pop());
      existing.set(r.url, { entity: r.file, pageUrl: `https://commons.wikimedia.org/wiki/File:${filename}` });
    }
  }

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
    try { gbif = await fetchGbifSpecies(t.wikidata.gbif); } catch (e) { log(`GBIF lookup failed: ${e.message}`, true); }
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

async function buildStub(t, lang) {
  const ctx = await ensureStubContext(t);
  if (lang === 'en') return buildStubEn(t, ctx);
  if (lang === 'es') return buildStubEs(t, ctx);
  if (lang === 'ja') return buildStubJa(t, ctx);
  throw new Error(`No stub template for language "${lang}"`);
}

function editUrl(lang, title) {
  return `https://${lang}.wikipedia.org/w/index.php?title=${encodeURIComponent(title)}&action=edit`;
}

// ---------- UI ----------

const statusEl = document.getElementById('status');
const runBtn = document.getElementById('runBtn');
const projectInput = document.getElementById('projectInput');
const statsEl = document.getElementById('stats');
const filtersEl = document.getElementById('filters');
const tableWrapEl = document.getElementById('tableWrap');
const tbody = document.getElementById('taxaBody');

let currentTaxa = [];
let currentFilter = 'all';

function log(msg, isErr) {
  const line = document.createElement('div');
  line.className = 'log-line' + (isErr ? ' err' : '');
  line.textContent = msg;
  statusEl.appendChild(line);
  statusEl.scrollTop = statusEl.scrollHeight;
}

function setStatusHeader(msg) {
  const header = statusEl.querySelector('.log-header') || (() => {
    const h = document.createElement('div');
    h.className = 'log-header';
    h.style.fontWeight = '600';
    statusEl.prepend(h);
    return h;
  })();
  header.textContent = msg;
}

function taxonMissingCount(t) {
  if (!t.wikidata || !t.wikipedia) return null;
  return LANGS.filter(l => !t.wikipedia[l.code]).length;
}

function matchesFilter(t) {
  if (currentFilter === 'all') return true;
  if (currentFilter === 'unresolved') return !t.wikidata;
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
  const thumb = `<img class="thumb" src="${p.squareUrl}" alt="">`;
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
    const photo = t.photo ? `<img class="thumb" src="${t.photo}" alt="">` : `<div class="thumb"></div>`;
    const wd = t.wikidata
      ? `<a href="${t.wikidata.uri}" target="_blank" rel="noopener">${t.wikidata.qid}</a>${t.wikidataAmbiguous ? ' <span class="pill" title="Multiple Wikidata items share this scientific name">⚠ ambiguous</span>' : ''}`
      : `<span class="pill">not found</span>`;
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
      bhlRow.innerHTML = `<td></td><td colspan="11">No BHL literature found for <em>${name}</em> in this experimental knowledge graph (koetai.semscape.org) — it may simply not be indexed yet.</td>`;
    } else {
      const items = results.map(r =>
        `<li>${r.date ? `<strong>${r.date}</strong> — ` : ''}${r.title}${r.containerTitle ? ` <em>(${r.containerTitle})</em>` : ''} ${r.part ? `<a href="${r.part}" target="_blank" rel="noopener">↗</a>` : ''}</li>`
      ).join('');
      bhlRow.innerHTML = `<td></td><td colspan="11">BHL literature mentioning <em>${name}</em> (federated query: BHL graph → Wikidata via QLever → Wikipedia via WDQS):<ul>${items}</ul></td>`;
    }
    row.after(bhlRow);
  } catch (err) {
    bhlRow = document.createElement('tr');
    bhlRow.className = 'bhl-row';
    bhlRow.innerHTML = `<td></td><td colspan="11">BHL lookup failed: ${err.message}</td>`;
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
    plaziRow.innerHTML = `<td></td><td colspan="11">Plazi TreatmentBank treatments for <em>${label}</em> (via SynoSpecies' QLever endpoint):<ul>${items}</ul></td>`;
    row.after(plaziRow);
  } catch (err) {
    plaziRow = document.createElement('tr');
    plaziRow.className = 'bhl-row plazi-row';
    plaziRow.innerHTML = `<td></td><td colspan="11">Plazi lookup failed: ${err.message}</td>`;
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
    box.innerHTML = `<td></td><td colspan="11">
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
    box.innerHTML = `<td></td><td colspan="11">Could not draft a stub: ${err.message}</td>`;
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
  box.innerHTML = `<td></td><td colspan="11">
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

document.getElementById('filters').addEventListener('click', (e) => {
  const btn = e.target.closest('.filter-btn');
  if (!btn) return;
  currentFilter = btn.dataset.filter;
  [...document.querySelectorAll('.filter-btn')].forEach(b => b.classList.toggle('active', b === btn));
  renderTable();
});

function updateStats() {
  const total = currentTaxa.length;
  const resolved = currentTaxa.filter(t => t.wikidata).length;
  const missingAny = currentTaxa.filter(t => taxonMissingCount(t) > 0).length;
  const missingAll = currentTaxa.filter(t => taxonMissingCount(t) === LANGS.length).length;
  document.getElementById('statTotal').textContent = total;
  document.getElementById('statResolved').textContent = resolved;
  document.getElementById('statMissingAny').textContent = missingAny;
  document.getElementById('statMissingAll').textContent = missingAll;
  statsEl.hidden = false;
}

async function run() {
  const project = projectInput.value.trim();
  if (!project) return;
  runBtn.disabled = true;
  statusEl.innerHTML = '';
  statsEl.hidden = true;
  filtersEl.hidden = true;
  tableWrapEl.hidden = true;
  currentTaxa = [];

  try {
    setStatusHeader(`Fetching observations for "${project}"…`);
    const taxa = await fetchProjectTaxa(project, (n, total) => {
      setStatusHeader(`Fetching observations for "${project}"… ${n}/${total || '?'}`);
    });
    log(`${taxa.length} distinct taxa found.`);

    setStatusHeader(`Resolving ${taxa.length} taxa against Wikidata (via Comunica → QLever)…`);
    await resolveWikidata(taxa);

    setStatusHeader(`Checking Wikipedia (en/ja/es) sitelinks (via Comunica → WDQS)…`);
    await resolveSitelinks(taxa);

    setStatusHeader(`Checking Plazi TreatmentBank (via Comunica → QLever)…`);
    await resolvePlazi(taxa);

    setStatusHeader(`Checking Wikimedia Commons for existing uploads (via Comunica → QLever)…`);
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
    log(err.stack || '', true);
  } finally {
    runBtn.disabled = false;
  }
}

runBtn.addEventListener('click', run);
projectInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
