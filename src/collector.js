// Coleta de métricas EXCLUSIVAMENTE via Instagram Graph API (fonte oficial).
// Sem credenciais válidas, nada é inventado: a medição é gravada como erro.

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS measurements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    views INTEGER,
    status TEXT NOT NULL,
    message TEXT,
    source TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_meas_ts ON measurements(ts)`,
  `CREATE INDEX IF NOT EXISTS idx_meas_status_ts ON measurements(status, ts)`,
  `CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)`,
];

let schemaReady = false;
export async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  schemaReady = true;
}

export async function getConfig(env, key) {
  const r = await env.DB.prepare("SELECT value FROM config WHERE key=?").bind(key).first();
  return r ? r.value : null;
}
export async function setConfig(env, key, value) {
  await env.DB.prepare("INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(key, value).run();
}

const SOURCE = "Instagram Graph API (insights: views)";

async function insert(env, ts, views, status, message) {
  await env.DB.prepare("INSERT INTO measurements(ts,views,status,message,source) VALUES(?,?,?,?,?)")
    .bind(ts, views, status, message ?? null, SOURCE).run();
}

function base(env) {
  return `https://${env.GRAPH_HOST || "graph.facebook.com"}/${env.GRAPH_VERSION || "v21.0"}`;
}

async function graph(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  let body = null;
  try { body = await res.json(); } catch { /* ignore */ }
  if (!res.ok || (body && body.error)) {
    const e = body && body.error;
    const msg = e ? `${e.type || "Erro"} ${e.code || ""}: ${e.message}` : `HTTP ${res.status}`;
    const err = new Error(msg);
    err.http = res.status;
    throw err;
  }
  return body;
}

async function resolveMediaId(env) {
  const cached = await getConfig(env, "media_id");
  if (cached) return cached;
  let url = `${base(env)}/${env.IG_USER_ID}/media?fields=id,shortcode,permalink&limit=100&access_token=${encodeURIComponent(env.IG_ACCESS_TOKEN)}`;
  for (let page = 0; page < 20 && url; page++) {
    const body = await graph(url);
    for (const m of body.data || []) {
      if (m.shortcode === env.REEL_SHORTCODE || (m.permalink || "").includes(`/${env.REEL_SHORTCODE}/`)) {
        await setConfig(env, "media_id", m.id);
        return m.id;
      }
    }
    url = body.paging && body.paging.next ? body.paging.next : null;
  }
  throw new Error("Reel não encontrado na conta autenticada (a conta do token precisa ser a dona do Reel)");
}

/** Faz UMA coleta e grava o resultado (ok / unavailable / error). */
export async function collectOnce(env) {
  const ts = Date.now();
  if (!env.IG_ACCESS_TOKEN || !env.IG_USER_ID) {
    await insert(env, ts, null, "unavailable",
      "Coleta indisponível: IG_ACCESS_TOKEN/IG_USER_ID (Instagram Graph API da conta dona do Reel) não configurados");
    return;
  }
  try {
    const mediaId = await resolveMediaId(env);
    const body = await graph(`${base(env)}/${mediaId}/insights?metric=views&access_token=${encodeURIComponent(env.IG_ACCESS_TOKEN)}`);
    const d = (body.data || [])[0];
    let v = d && d.values && d.values[0] ? d.values[0].value : d && d.total_value ? d.total_value.value : undefined;
    if (!Number.isInteger(v)) throw new Error("Resposta sem métrica 'views' válida");
    await insert(env, ts, v, "ok", null);
  } catch (e) {
    if (e.http === 401 || e.http === 403) await setConfig(env, "media_id", "").catch(() => {});
    await insert(env, ts, null, "error", String(e.message || e).slice(0, 300));
  }
}
