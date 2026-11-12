import { ensureSchema, collectOnce, getConfig, setConfig } from "./collector.js";
import { summary, series, recent, csv, buildReport, isActive, PERIODS } from "./stats.js";
import { PAGE } from "./ui.js";

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function finalizeIfDone(env) {
  const act = await isActive(env);
  if (act.active || (await getConfig(env, "final_report"))) return;
  await setConfig(env, "final_report", JSON.stringify(await buildReport(env)));
}

async function runCycle(env) {
  await ensureSchema(env);
  const n = Math.max(1, Math.floor(60 / Number(env.INTERVAL_SECONDS || 30)));
  for (let i = 0; i < n; i++) {
    if (!(await isActive(env)).active) break;
    if (i > 0) await sleep((60 / n) * 1000);
    if (!(await isActive(env)).active) break;
    await collectOnce(env);
  }
  await finalizeIfDone(env);
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runCycle(env));
  },

  async fetch(req, env) {
    const url = new URL(req.url);
    await ensureSchema(env);
    const p = url.pathname;

    if (p === "/" || p === "/relatorio") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
    if (p === "/api/summary") return json(await summary(env));
    if (p === "/api/series") return json(await series(env));
    if (p === "/api/recent") return json(await recent(env, Math.min(500, Number(url.searchParams.get("limit")) || 100)));
    if (p === "/api/periods") return json(Object.keys(PERIODS));
    if (p === "/api/report") {
      const frozen = await getConfig(env, "final_report");
      return json(frozen ? JSON.parse(frozen) : await buildReport(env));
    }
    if (p === "/export.csv" || p === "/api/export.csv")
      return new Response(await csv(env), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="reel-visualizacoes.csv"' } });

    if (p === "/api/admin/stop" || p === "/api/admin/resume") {
      if (req.method !== "POST") return json({ error: "use POST" }, 405);
      if (!env.ADMIN_TOKEN) return json({ error: "ADMIN_TOKEN não configurado" }, 503);
      const auth = req.headers.get("authorization") || "";
      if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: "não autorizado" }, 401);
      if (p.endsWith("stop")) {
        await setConfig(env, "stopped_at", String(Date.now()));
        await setConfig(env, "final_report", JSON.stringify(await buildReport(env)));
      } else {
        await env.DB.prepare("DELETE FROM config WHERE key IN ('stopped_at','final_report')").run();
      }
      return json({ ok: true });
    }
    return json({ error: "not found" }, 404);
  },
};
