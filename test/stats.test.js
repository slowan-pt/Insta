import test from "node:test";
import assert from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { ensureSchema } from "../src/collector.js";
import { summary, buildReport } from "../src/stats.js";

// Mínimo shim de D1 sobre node:sqlite
function fakeD1() {
  const db = new DatabaseSync(":memory:");
  const prep = (sql) => {
    let args = [];
    const o = {
      bind: (...a) => ((args = a), o),
      run: async () => (db.prepare(sql).run(...args), {}),
      first: async () => db.prepare(sql).get(...args) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...args) }),
    };
    return o;
  };
  return { prepare: prep, batch: async (l) => { for (const s of l) await s.run(); } };
}

test("períodos, crescimento e relatório usam só medições válidas", async () => {
  const env = { DB: fakeD1(), INITIAL_VIEWS: "3582", INITIAL_DATE: "2026-11-12", END_AT: "2099-01-01T00:00:00Z", INTERVAL_SECONDS: "30", REEL_URL: "u", REEL_PROFILE: "p" };
  await ensureSchema(env);
  const now = Date.now(), ins = (m, v, st) => env.DB.prepare("INSERT INTO measurements(ts,views,status,source) VALUES(?,?,?,'t')").bind(now - m * 60000, v, st).run();
  await ins(30, 3600, "ok"); await ins(10, 3650, "ok"); await ins(4, null, "error"); await ins(1, 3700, "ok");
  const s = await summary(env, now);
  assert.equal(s.current, 3700); assert.equal(s.growth, 118);
  assert.equal(s.periods["5m"].added, 50); assert.equal(s.periods["15m"].added, 100); assert.equal(s.periods["1h"].added, 100);
  assert.equal(s.periods["1h"].partial, true);
  const r = await buildReport(env, now);
  assert.equal(r.final, 3700); assert.equal(r.absolute, 118); assert.equal(r.validMeasurements, 3);
});
