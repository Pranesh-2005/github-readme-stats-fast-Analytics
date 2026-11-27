// Shared /api/stats handler: Vercel function (api/stats.js) and local dev (server.mjs).
// Quota rules, because this runs on a Vercel account shared with other apps:
//  - one invocation per refresh; all Axiom queries run in parallel inside it
//  - in-memory cache per range for the TTL (min 5 min); forced Sync at most once a minute
//  - unauthenticated calls are rejected before any Axiom query runs
import { timingSafeEqual } from "node:crypto";

const MIN_TTL = 300; // 5 min floor: nothing can poll faster than this
const MAX_TTL = 21600; // 6 h
const FORCE_COOLDOWN_MS = 60_000;
const RANGES = new Set(["24h", "3d", "7d", "30d"]);

function cfg() {
  const env = process.env;
  return {
    token: env.AXIOM_QUERY_TOKEN,
    domain: env.AXIOM_DOMAIN,
    dataset: /^[\w-]+$/.test(env.AXIOM_DATASET || "") ? env.AXIOM_DATASET : "ghstats",
    exclude: (env.EXCLUDE_USERS ?? "")
      .toLowerCase()
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^[a-z0-9@._-]+$/.test(s)), // only safe literals reach the query
  };
}

function queries(range, { dataset, exclude }) {
  let b = `['${dataset}'] | where _time > ago(${range}) | where app !in ('setup-check','local-e2e')`;
  if (exclude.length) b += ` | where tolower(user) !in (${exclude.map((u) => `'${u}'`).join(",")})`;
  const err = "countif(ttl > 0 and ttl <= 600)"; // error cards are cached for 5-10 min
  return {
    kpi: `${b} | summarize renders=count(), users=dcount(user), urls=dcount(q), p50=percentile(ms,50), p95=percentile(ms,95), errors=${err}, warm=countif(svg == 'hit' or data == 'hit')`,
    series: `${b} | summarize renders=count(), users=dcount(user) by bin(_time, 1h) | order by _time asc`,
    daily: `${b} | summarize renders=count(), users=dcount(user) by bin(_time, 1d) | order by _time asc`,
    hours: `${b} | summarize renders=count() by hour=hourofday(_time) | order by hour asc`,
    cards: `${b} | summarize renders=count(), users=dcount(user), p50=percentile(ms,50), p95=percentile(ms,95), errors=${err} by card | order by renders desc`,
    users: `${b} | summarize renders=count(), cards=dcount(card) by user | order by renders desc | take 10`,
    edges: `${b} | where isnotempty(edge) | summarize renders=count() by edge | order by renders desc | take 8`,
    apps: `${b} | summarize renders=count(), first=min(_time), last=max(_time) by app | order by first asc`,
    returning: `${b} | summarize days=dcount(bin(_time, 1d)) by user | summarize users=count() by days | order by days asc`,
  };
}

async function apl(query, { token, domain }) {
  const r = await fetch(`https://${domain}/v1/query/_apl?format=tabular`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ apl: query }),
    signal: AbortSignal.timeout(12_000), // stays under the function's maxDuration
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `Axiom HTTP ${r.status}`);
  const t = j.tables?.[0];
  if (!t) return [];
  const names = t.fields.map((f) => f.name);
  const cols = t.columns || [];
  const n = cols[0]?.length || 0;
  return Array.from({ length: n }, (_, i) => Object.fromEntries(names.map((k, c) => [k, cols[c][i]])));
}

// Vercel usage (undocumented v2/usage, works on Hobby). Gives CDN hits/misses, which Axiom can't see:
// a cache hit never runs the function. VERCEL_TOKENS = "acc1:<token>,acc3:<token>" (labels match ANALYTICS_APP).
// Only accounts that served the main host in the range (per Axiom) are counted, so switching accounts just works.
const DAYS = { "24h": 1, "3d": 3, "7d": 7, "30d": 30 };
function vercelTokens() {
  return (process.env.VERCEL_TOKENS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf(":");
      return i > 0 ? { label: s.slice(0, i), token: s.slice(i + 1) } : { label: "vercel", token: s };
    });
}
async function vercelUsage(range, servingLabels) {
  const all = vercelTokens();
  if (!all.length) return { disabled: true };
  const pick = all.filter((t) => servingLabels.includes(t.label));
  const tokens = pick.length ? pick : all;
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - DAYS[range])); // whole UTC days covering the range
  const byDay = new Map();
  const accounts = [];
  const errors = [];
  await Promise.all(
    tokens.map(async ({ label, token }) => {
      try {
        const url = `https://api.vercel.com/v2/usage?type=requests&from=${from.toISOString()}&to=${now.toISOString()}`;
        const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
        let total = 0;
        for (const d of j.data || []) {
          const day = d.date.slice(0, 10);
          const row = byDay.get(day) || { date: day, hits: 0, misses: 0, fnOk: 0, fnErr: 0, fnTimeout: 0, gbh: 0, outBytes: 0 };
          row.hits += d.request_hit_count || 0;
          row.misses += d.request_miss_count || 0;
          row.fnOk += d.function_invocation_successful_count || 0;
          row.fnErr += d.function_invocation_error_count || 0;
          row.fnTimeout += d.function_invocation_timeout_count || 0;
          row.gbh += d.function_execution_successful_gb_hours || 0;
          row.outBytes += d.bandwidth_outgoing_bytes || 0;
          byDay.set(day, row);
          total += (d.request_hit_count || 0) + (d.request_miss_count || 0);
        }
        accounts.push({ label, total });
      } catch (e) {
        errors.push(`${label}: ${e.message}`);
      }
    }),
  );
  const rows = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)).map((r) => ({ ...r, total: r.hits + r.misses }));
  return { rows, accounts, errors };
}

const cache = new Map(); // range -> { at, payload, inflight }

async function fetchAll(range, c) {
  const entries = Object.entries(queries(range, c));
  const settled = await Promise.allSettled(entries.map(([, q]) => apl(q, c)));
  const results = {};
  entries.forEach(([key], i) => {
    const s = settled[i];
    results[key] = s.status === "fulfilled" ? { rows: s.value } : { error: String(s.reason?.message || s.reason) };
  });
  const serving = (results.apps?.rows || []).map((r) => r.app);
  try {
    results.usage = await vercelUsage(range, serving);
  } catch (e) {
    results.usage = { error: String(e.message || e) };
  }
  return { range, generatedAt: new Date().toISOString(), results };
}

async function stats(range, ttlSec, force, c) {
  const now = Date.now();
  const entry = cache.get(range) || {};
  const age = entry.payload ? now - entry.at : Infinity;
  const throttled = force && age < FORCE_COOLDOWN_MS;
  if (entry.payload && (throttled || (!force && age < ttlSec * 1000))) {
    return { ...entry.payload, cached: true, throttled, ageSec: Math.round(age / 1000) };
  }
  if (entry.inflight) return entry.inflight; // concurrent callers share one Axiom round
  const inflight = fetchAll(range, c)
    .then((payload) => {
      cache.set(range, { at: Date.now(), payload });
      return { ...payload, cached: false, throttled: false, ageSec: 0 };
    })
    .catch((e) => {
      cache.set(range, entry); // keep the last good payload, drop the failed inflight
      throw e;
    });
  cache.set(range, { ...entry, inflight });
  return inflight;
}

function authorized(req) {
  const key = process.env.DASH_KEY;
  if (!key) return !process.env.VERCEL; // fail closed on Vercel when no key is configured
  const got = Buffer.from(String(req.headers["x-dash-key"] || ""));
  const want = Buffer.from(key);
  return got.length === want.length && timingSafeEqual(got, want);
}

function send(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "private, no-store", // never cached by the CDN: response depends on the key
    "x-robots-tag": "noindex",
  });
  res.end(JSON.stringify(body));
}

export async function handleStats(req, res) {
  if (req.method !== "GET") return send(res, 405, { error: "GET only" });
  if (!authorized(req)) {
    return send(res, 401, { error: process.env.VERCEL && !process.env.DASH_KEY ? "DASH_KEY is not configured" : "Unauthorized" });
  }
  const c = cfg();
  if (!c.token || !c.domain) return send(res, 500, { error: "AXIOM_QUERY_TOKEN or AXIOM_DOMAIN missing" });
  const url = new URL(req.url, "http://localhost");
  const range = RANGES.has(url.searchParams.get("range")) ? url.searchParams.get("range") : "24h";
  const ttl = Math.min(MAX_TTL, Math.max(MIN_TTL, Number(url.searchParams.get("ttl")) || 900));
  const force = url.searchParams.get("force") === "1";
  try {
    send(res, 200, { ...(await stats(range, ttl, force, c)), ttl });
  } catch (e) {
    send(res, 502, { error: String(e.message || e) });
  }
}
