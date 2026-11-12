import { getConfig } from "./collector.js";

export const PERIODS = { "5m": 5, "15m": 15, "30m": 30, "1h": 60, "24h": 1440 };
const BRT = -3 * 3600 * 1000;

export function endMs(env) { return Date.parse(env.END_AT); }

export async function isActive(env, now = Date.now()) {
  const stopped = await getConfig(env, "stopped_at");
  if (stopped) return { active: false, reason: "stopped", stoppedAt: Number(stopped) };
  if (now >= endMs(env)) return { active: false, reason: "ended" };
  return { active: true };
}

async function validAtOrBefore(env, ts) {
  return env.DB.prepare("SELECT ts,views FROM measurements WHERE status='ok' AND ts<=? ORDER BY ts DESC LIMIT 1").bind(ts).first();
}
async function firstValid(env) {
  return env.DB.prepare("SELECT ts,views FROM measurements WHERE status='ok' ORDER BY ts ASC LIMIT 1").first();
}
async function lastValid(env) {
  return env.DB.prepare("SELECT ts,views FROM measurements WHERE status='ok' ORDER BY ts DESC LIMIT 1").first();
}

export async function summary(env, now = Date.now()) {
  const initial = Number(env.INITIAL_VIEWS);
  const interval = Number(env.INTERVAL_SECONDS || 30);
  const [last, lastAny, counts, act, first] = await Promise.all([
    lastValid(env),
    env.DB.prepare("SELECT ts,status,message FROM measurements ORDER BY ts DESC LIMIT 1").first(),
    env.DB.prepare("SELECT status, COUNT(*) n FROM measurements GROUP BY status").all(),
    isActive(env, now),
    firstValid(env),
  ]);
  const c = { ok: 0, error: 0, unavailable: 0 };
  for (const r of counts.results) c[r.status] = r.n;

  const current = last ? last.views : null;
  const periods = {};
  for (const [k, min] of Object.entries(PERIODS)) {
    const from = now - min * 60000;
    let base = last ? await validAtOrBefore(env, from) : null;
    let partial = false;
    if (last && !base) { base = first; partial = true; }
    periods[k] = last && base
      ? { added: current - base.views, from: base.ts, baseViews: base.views, partial }
      : { added: null };
  }

  const stale = !lastAny || now - lastAny.ts > Math.max(90000, interval * 3000);
  let health;
  if (!act.active) health = "stopped";
  else if (stale) health = "down";
  else if (lastAny.status === "ok") health = "ok";
  else if (lastAny.status === "unavailable") health = "unavailable";
  else health = "error";

  return {
    now,
    reel: { url: env.REEL_URL, profile: env.REEL_PROFILE },
    initial, initialDate: env.INITIAL_DATE,
    current,
    growth: current == null ? null : current - initial,
    growthPct: current == null ? null : ((current - initial) / initial) * 100,
    lastValidAt: last ? last.ts : null,
    lastAttempt: lastAny,
    health, active: act, endAt: endMs(env), intervalSeconds: interval,
    counts: c, periods,
    collectionAvailable: c.ok > 0 && health !== "unavailable",
    firstValidAt: first ? first.ts : null,
  };
}

/** Série completa de medições válidas, reduzida a no máx. `max` pontos (último ponto de cada balde). */
export async function series(env, max = 1500) {
  const rows = (await env.DB.prepare("SELECT ts,views FROM measurements WHERE status='ok' ORDER BY ts ASC").all()).results;
  if (rows.length <= max) return rows;
  const step = rows.length / max, out = [];
  for (let i = 0; i < max; i++) out.push(rows[Math.min(rows.length - 1, Math.floor((i + 1) * step) - 1)]);
  return out;
}

export async function recent(env, limit = 100) {
  return (await env.DB.prepare("SELECT ts,views,status,message FROM measurements ORDER BY ts DESC LIMIT ?").bind(limit).all()).results;
}

const pad = (n) => String(n).padStart(2, "0");
export function brt(ts) {
  const d = new Date(ts + BRT);
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export async function csv(env) {
  const rows = (await env.DB.prepare("SELECT ts,views,status,message,source FROM measurements ORDER BY ts ASC").all()).results;
  const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const lines = ["timestamp_utc,data_hora_brasilia,visualizacoes,status,mensagem,fonte"];
  for (const r of rows)
    lines.push([new Date(r.ts).toISOString(), brt(r.ts), r.views ?? "", r.status, q(r.message), q(r.source)].join(","));
  return "﻿" + lines.join("\n") + "\n";
}

export async function buildReport(env, now = Date.now()) {
  const initial = Number(env.INITIAL_VIEWS);
  const act = await isActive(env, now);
  const stoppedAt = act.stoppedAt;
  const until = Math.min(now, stoppedAt || Infinity, endMs(env));
  const ok = (await env.DB.prepare("SELECT ts,views FROM measurements WHERE status='ok' AND ts<=? ORDER BY ts ASC").bind(until).all()).results;
  const fails = (await env.DB.prepare("SELECT status,COUNT(*) n, MIN(ts) first_ts, MAX(ts) last_ts FROM measurements WHERE status!='ok' AND ts<=? GROUP BY status").bind(until).all()).results;
  const topErrors = (await env.DB.prepare("SELECT message, COUNT(*) n FROM measurements WHERE status!='ok' AND ts<=? GROUP BY message ORDER BY n DESC LIMIT 5").bind(until).all()).results;
  const total = (await env.DB.prepare("SELECT COUNT(*) n FROM measurements WHERE ts<=?").bind(until).first()).n;

  const hourly = {};
  let prev = null;
  for (const r of ok) {
    const key = Math.floor((r.ts + BRT) / 3600000);
    const h = hourly[key] || (hourly[key] = { hourStartBrt: null, added: 0, samples: 0, lastViews: null });
    h.samples++;
    if (prev != null) h.added += r.views - prev; // acréscimo atribuído à hora da medição que o observou
    h.lastViews = r.views; prev = r.views;
  }
  const byHour = Object.entries(hourly).map(([k, h]) => {
    const start = Number(k) * 3600000 - BRT;
    return { hour: brt(start).slice(0, 14) + "00", added: h.added, samples: h.samples, endViews: h.lastViews };
  });
  const top = [...byHour].sort((a, b) => b.added - a.added).slice(0, 3);

  const final = ok.length ? ok[ok.length - 1].views : null;
  const firstObserved = ok.length ? ok[0].views : null;
  return {
    generatedAt: now, generatedAtBrt: brt(now),
    state: act.active ? "em andamento (parcial)" : act.reason === "stopped" ? "encerrado manualmente" : "encerrado (prazo atingido)",
    reel: env.REEL_URL, profile: env.REEL_PROFILE,
    periodStartBrt: env.INITIAL_DATE, periodEndBrt: brt(until),
    initial, final, firstObserved,
    absolute: final == null ? null : final - initial,
    percent: final == null ? null : ((final - initial) / initial) * 100,
    byHour, topHours: top,
    attempts: total, validMeasurements: ok.length,
    failures: fails.map((f) => ({ status: f.status, count: f.n, first: brt(f.first_ts), last: brt(f.last_ts) })),
    topErrors,
    source: "Instagram Graph API, endpoint /{media-id}/insights?metric=views, consultado pelo Cloudflare Worker e gravado no Cloudflare D1. O valor inicial (3.582) foi informado manualmente pelo responsável e não vem da API.",
    limitations: [
      "Só são aceitas medições da API oficial; sem token da conta dona do Reel, a coleta fica 'indisponível' e nenhum valor é estimado.",
      "A métrica 'views' da API pode ter atraso e pode diferir do número exibido no aplicativo do Instagram.",
      "A contagem inicial (3.582) foi digitada manualmente; a diferença entre ela e a 1ª medição da API (se existir) não é crescimento observado.",
      "Lacunas na coleta (falhas, indisponibilidade) fazem o acréscimo ser atribuído à hora em que foi observado, não à hora em que ocorreu.",
      "Cron Triggers têm resolução de 1 min; a cadência de 30 s é obtida com duas coletas por execução e pode variar alguns segundos.",
    ],
    causality: "Os números mostram crescimento OBSERVADO. Eles não provam que qualquer ação específica (divulgação, anúncio, compartilhamento etc.) causou o aumento: a visualização orgânica, o algoritmo e outros fatores não são separáveis com estes dados.",
  };
}
