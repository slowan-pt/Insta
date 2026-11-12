#!/usr/bin/env python3
"""ReelMon (PC: Windows/macOS/Linux): monitor local de visualizações de um Reels.

Nunca inventa números: sem fonte autorizada configurada, cada ciclo é registrado
como 'unavailable' ("Coleta indisponível"). Não há nenhum recurso que gere
visualizações ou qualquer engajamento artificial.
"""
import csv, io, json, os, shutil, signal, sqlite3, subprocess, sys, threading, time, webbrowser
import urllib.error, urllib.parse, urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

HOME = Path(os.environ.get("REELMON_HOME", Path.home() / "reelmon"))
DB_PATH, STOP_FILE, LOG_FILE, CFG_FILE = (HOME / n for n in ("reelmon.db", "reelmon.stop", "reelmon.log", "config.env"))
BRT = timezone(timedelta(hours=-3))
DEFAULTS = {
    "REEL_URL": "https://www.instagram.com/reel/Dfkq2eZRR0K/",
    "REEL_SHORTCODE": "Dfkq2eZRR0K",
    "INITIAL_VIEWS": "3582",
    "INTERVAL": "45",
    "PORT": "8080",
    "SOURCE": "none",          # none | graph | instaloader
    "IG_ACCESS_TOKEN": "", "IG_USER_ID": "",
    "GRAPH_VERSION": "v21.0",
    "ALLOW_UNOFFICIAL": "0",   # só para SOURCE=instaloader (fonte NÃO oficial)
    "UNOFFICIAL_MIN_INTERVAL": "300",
    "END_AT": "",              # ISO opcional, ex.: 2026-11-13T19:00:00-03:00
}

def cfg():
    c = dict(DEFAULTS)
    if CFG_FILE.exists():
        for line in CFG_FILE.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                c[k.strip()] = v.strip().strip('"').strip("'")
    for k in DEFAULTS:
        if k in os.environ: c[k] = os.environ[k]
    return c

def log(msg):
    print(f"{datetime.now(BRT):%Y-%m-%d %H:%M:%S} {msg}", flush=True)

def db():
    HOME.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=15)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("""CREATE TABLE IF NOT EXISTS runs(
        id INTEGER PRIMARY KEY AUTOINCREMENT, started_at REAL NOT NULL, duration_ms INTEGER NOT NULL,
        result TEXT NOT NULL, views INTEGER, error TEXT, source TEXT)""")
    con.execute("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)")
    return con

def meta_get(con, k):
    r = con.execute("SELECT value FROM meta WHERE key=?", (k,)).fetchone()
    return r["value"] if r else None

def meta_set(con, k, v):
    con.execute("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (k, str(v)))
    con.commit()

# ---------------------------------------------------------------- fontes
def _graph_get(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"Accept": "application/json"}), timeout=20) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try: err = json.load(e).get("error", {})
        except Exception: err = {}
        raise RuntimeError(f"Graph API HTTP {e.code}: {err.get('message', e.reason)}")

def fetch_graph(c, con):
    """Fonte OFICIAL: Instagram Graph API (conta profissional dona do Reel)."""
    if not (c["IG_ACCESS_TOKEN"] and c["IG_USER_ID"]):
        return "unavailable", None, "Coleta indisponível: configure IG_ACCESS_TOKEN e IG_USER_ID em config.env (Graph API da conta dona do Reel)"
    base = f"https://graph.facebook.com/{c['GRAPH_VERSION']}"
    tok = urllib.parse.quote(c["IG_ACCESS_TOKEN"])
    mid = meta_get(con, "media_id")
    if not mid:
        url = f"{base}/{c['IG_USER_ID']}/media?fields=id,shortcode&limit=100&access_token={tok}"
        for _ in range(20):
            if not url: break
            body = _graph_get(url)
            for m in body.get("data", []):
                if m.get("shortcode") == c["REEL_SHORTCODE"]:
                    mid = m["id"]; break
            if mid: break
            url = body.get("paging", {}).get("next")
        if not mid: raise RuntimeError("Reel não encontrado na conta autenticada")
        meta_set(con, "media_id", mid)
    d = (_graph_get(f"{base}/{mid}/insights?metric=views&access_token={tok}").get("data") or [{}])[0]
    v = (d.get("values") or [{}])[0].get("value", (d.get("total_value") or {}).get("value"))
    if not isinstance(v, int): raise RuntimeError("Resposta sem métrica 'views'")
    return "ok", v, None

_last_unofficial = 0.0
def fetch_instaloader(c, con):
    """Fonte NÃO oficial (scraping). Desligada por padrão; exige ALLOW_UNOFFICIAL=1 e respeita intervalo mínimo."""
    global _last_unofficial
    if c["ALLOW_UNOFFICIAL"] != "1":
        return "unavailable", None, "Coleta indisponível: Instaloader é fonte não oficial; defina ALLOW_UNOFFICIAL=1 em config.env por sua conta e risco (pode violar os Termos do Instagram e ser bloqueado)"
    wait = float(c["UNOFFICIAL_MIN_INTERVAL"]) - (time.time() - _last_unofficial)
    if wait > 0:
        return "skipped", None, f"intervalo mínimo da fonte não oficial ({c['UNOFFICIAL_MIN_INTERVAL']}s); próxima consulta em {int(wait)}s"
    _last_unofficial = time.time()
    import instaloader
    L = instaloader.Instaloader(quiet=True, download_pictures=False, download_videos=False, save_metadata=False)
    post = instaloader.Post.from_shortcode(L.context, c["REEL_SHORTCODE"])
    v = post.video_view_count
    if v is None: raise RuntimeError("Instaloader não retornou contagem de visualizações")
    return "ok", int(v), None

def collect(c, con):
    s = c["SOURCE"].lower()
    if s == "graph": return fetch_graph(c, con)
    if s == "instaloader": return fetch_instaloader(c, con)
    return "unavailable", None, "Coleta indisponível: nenhuma fonte autorizada configurada (SOURCE=none)"

# ---------------------------------------------------------------- serviço
def wake(on):  # só faz algo se estiver no Termux
    exe = "termux-wake-lock" if on else "termux-wake-unlock"
    if shutil.which(exe):
        try: subprocess.run([exe], timeout=10, capture_output=True)
        except Exception: pass

def collector_loop(stop):
    con = db(); c = cfg(); interval = max(5, float(c["INTERVAL"]))
    end = datetime.fromisoformat(c["END_AT"]).timestamp() if c["END_AT"] else None
    nxt = time.monotonic()
    while not stop.is_set():
        if end and time.time() >= end:
            log("END_AT atingido; encerrando"); stop.set(); break
        c = cfg(); t0 = time.time(); m0 = time.monotonic()
        try: result, views, err = collect(c, con)
        except Exception as e: result, views, err = "error", None, f"{type(e).__name__}: {e}"[:300]
        dur = int((time.monotonic() - m0) * 1000)
        con.execute("INSERT INTO runs(started_at,duration_ms,result,views,error,source) VALUES(?,?,?,?,?,?)",
                    (t0, dur, result, views, err, c["SOURCE"]))
        con.commit()
        meta_set(con, "heartbeat", time.time())
        prev = con.execute("SELECT views FROM runs WHERE result='ok' AND id<(SELECT MAX(id) FROM runs) ORDER BY id DESC LIMIT 1").fetchone()
        extra = ""
        if views is not None:
            extra = f" views={views}" + (f" ({views - prev['views']:+d})" if prev else "") + f" crescimento_total={views - int(c['INITIAL_VIEWS']):+d}"
        log(f"{result}{extra} ({dur} ms)" + (f" - {err}" if err else ""))
        nxt += interval
        if nxt - time.monotonic() < 0: nxt = time.monotonic()
        while not stop.is_set() and time.monotonic() < nxt:
            if STOP_FILE.exists(): stop.set()
            stop.wait(1)
        if STOP_FILE.exists(): stop.set()

def run_service():
    HOME.mkdir(parents=True, exist_ok=True)
    if service_pid():
        print("já existe uma instância em execução"); return
    try: STOP_FILE.unlink()
    except FileNotFoundError: pass
    con = db(); meta_set(con, "service_started_at", time.time()); meta_set(con, "heartbeat", time.time()); con.close()
    wake(True)
    stop = threading.Event()
    for sg in (getattr(signal, "SIGTERM", None), signal.SIGINT):
        if sg is not None: signal.signal(sg, lambda *_: stop.set())
    from werkzeug.serving import make_server
    srv = make_server("127.0.0.1", int(cfg()["PORT"]), make_app(), threaded=True)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    log(f"serviço iniciado (pid {os.getpid()}), painel em http://127.0.0.1:{cfg()['PORT']}")
    collector_loop(stop)
    srv.shutdown(); wake(False)
    con = db(); meta_set(con, "heartbeat", 0); con.close()
    try: STOP_FILE.unlink()
    except FileNotFoundError: pass
    log("serviço parado")

# ---------------------------------------------------------------- dashboard
def stats():
    c = cfg(); con = db(); now = time.time()
    n = lambda q, *a: con.execute(q, a).fetchone()[0]
    started = meta_get(con, "service_started_at"); started = float(started) if started else None
    last = con.execute("SELECT * FROM runs ORDER BY id DESC LIMIT 1").fetchone()
    valid = con.execute("SELECT started_at, views FROM runs WHERE result='ok' ORDER BY id DESC LIMIT 1").fetchone()
    running = service_pid() is not None
    initial = int(c["INITIAL_VIEWS"])
    interval = float(c["INTERVAL"])
    health = "parado" if not running else ("sem resposta" if not last or now - last["started_at"] > interval * 3 + 10
             else {"ok": "ok", "unavailable": "coleta indisponível", "skipped": "ok", "error": "erro na coleta"}[last["result"]])
    out = {
        "now": now, "running": running, "health": health, "source": c["SOURCE"], "interval": interval,
        "uptime_s": int(now - started) if running and started else 0,
        "cycles": n("SELECT COUNT(*) FROM runs"), "ok": n("SELECT COUNT(*) FROM runs WHERE result='ok'"),
        "failures": n("SELECT COUNT(*) FROM runs WHERE result='error'"),
        "unavailable": n("SELECT COUNT(*) FROM runs WHERE result='unavailable'"),
        "avg_ms": int(n("SELECT COALESCE(AVG(duration_ms),0) FROM runs")),
        "initial": initial, "current": valid["views"] if valid else None,
        "last_valid_at": valid["started_at"] if valid else None,
        "last_result": last["result"] if last else None, "last_error": last["error"] if last else None,
        "reel": c["REEL_URL"],
    }
    out["growth"] = None if out["current"] is None else out["current"] - initial
    out["growth_pct"] = None if out["current"] is None else out["growth"] / initial * 100
    con.close(); return out

def make_app():
    from flask import Flask, jsonify, request, Response
    app = Flask(__name__)

    @app.get("/")
    def index(): return Response(PAGE, mimetype="text/html")

    @app.get("/api/status")
    def api_status(): return jsonify(stats())

    @app.get("/api/history")
    def api_history():
        lim = min(1000, int(request.args.get("limit", 100)))
        con = db(); rows = [dict(r) for r in con.execute("SELECT * FROM runs ORDER BY id DESC LIMIT ?", (lim,))]
        con.close(); return jsonify(rows)

    @app.get("/export.csv")
    def export():
        con = db(); buf = io.StringIO(); w = csv.writer(buf)
        w.writerow(["id", "data_hora_brasilia", "duracao_ms", "resultado", "visualizacoes", "erro", "fonte"])
        for r in con.execute("SELECT * FROM runs ORDER BY id"):
            w.writerow([r["id"], datetime.fromtimestamp(r["started_at"], BRT).isoformat(timespec="seconds"),
                        r["duration_ms"], r["result"], r["views"] if r["views"] is not None else "", r["error"] or "", r["source"]])
        con.close()
        return Response("﻿" + buf.getvalue(), mimetype="text/csv",
                        headers={"Content-Disposition": "attachment; filename=reelmon.csv"})
    return app

PAGE = """<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>ReelMon</title><style>
:root{--bg:#f6f7f9;--c:#fff;--t:#14181f;--m:#667085;--b:#e3e6eb;--ok:#16803c;--w:#b45309;--e:#b42318}
@media(prefers-color-scheme:dark){:root{--bg:#0f1318;--c:#171c23;--t:#e8ebf0;--m:#93a0b2;--b:#262d38;--ok:#4ade80;--w:#fbbf24;--e:#f87171}}
body{margin:0;background:var(--bg);color:var(--t);font:15px/1.45 system-ui,sans-serif}main{max-width:900px;margin:auto;padding:14px}
.c{background:var(--c);border:1px solid var(--b);border-radius:12px;padding:12px;margin-bottom:12px}
.g{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}.k{color:var(--m);font-size:.8rem}.v{font-size:1.5rem;font-weight:700}
.tw{max-height:360px;overflow:auto}table{border-collapse:collapse;width:100%}td,th{padding:4px 8px;border-bottom:1px solid var(--b);text-align:left;white-space:nowrap}
.ok{color:var(--ok)}.error{color:var(--e)}.unavailable,.skipped{color:var(--w)}a{color:inherit}small{color:var(--m)}
</style></head><body><main><h1 style="font-size:1.2rem">ReelMon <small id=h></small></h1>
<div class=c><div class=g>
<div><div class=k>Executando há</div><div class=v id=up>–</div></div>
<div><div class=k>Ciclos</div><div class=v id=cy>–</div></div>
<div><div class=k>Falhas</div><div class=v id=fa>–</div></div>
<div><div class=k>Indisponíveis</div><div class=v id=un>–</div></div>
<div><div class=k>Duração média</div><div class=v id=av>–</div></div></div></div>
<div class=c><div class=g>
<div><div class=k>Inicial</div><div class=v id=in>–</div></div>
<div><div class=k>Atual</div><div class=v id=cu style="font-size:1.1rem">–</div></div>
<div><div class=k>Crescimento</div><div class=v id=gr>–</div></div>
<div><div class=k>Última coleta válida</div><div id=lv>–</div></div></div>
<p id=msg><small></small></p></div>
<div class=c><b>Histórico</b> <small>(a tela atualiza a cada 10 s; a coleta ocorre no serviço)</small>
<div class=tw><table><thead><tr><th>Data/hora</th><th>Duração</th><th>Resultado</th><th>Views</th><th>Erro</th></tr></thead><tbody id=r></tbody></table></div>
<p><a href="/export.csv">Exportar CSV</a></p></div></main><script>
const $=i=>document.getElementById(i),nf=new Intl.NumberFormat('pt-BR');
const f=t=>t?new Date(t*1000).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}):'–';
const dur=s=>Math.floor(s/3600)+'h '+String(Math.floor(s%3600/60)).padStart(2,'0')+'m '+String(s%60).padStart(2,'0')+'s';
async function go(){try{const[s,h]=await Promise.all([fetch('/api/status').then(r=>r.json()),fetch('/api/history?limit=100').then(r=>r.json())]);
$('h').textContent=s.health;$('up').textContent=s.running?dur(s.uptime_s):'parado';$('cy').textContent=nf.format(s.cycles);
$('fa').textContent=nf.format(s.failures);$('un').textContent=nf.format(s.unavailable);$('av').textContent=s.avg_ms+' ms';
$('in').textContent=nf.format(s.initial);$('cu').textContent=s.current==null?'Coleta indisponível':nf.format(s.current);
$('gr').textContent=s.growth==null?'–':(s.growth>0?'+':'')+nf.format(s.growth)+' ('+s.growth_pct.toFixed(2).replace('.',',')+'%)';
$('lv').textContent=f(s.last_valid_at);$('msg').firstChild.textContent=(s.last_error||'');
const tb=$('r');tb.replaceChildren();for(const r of h){const tr=tb.insertRow();
[f(r.started_at),r.duration_ms+' ms',r.result,r.views==null?'–':nf.format(r.views),r.error||''].forEach((v,i)=>{const td=tr.insertCell();td.textContent=v;if(i==2)td.className=r.result})}
}catch(e){$('h').textContent='painel sem conexão com o serviço'}}
go();setInterval(go,10000);</script></body></html>"""

# ---------------------------------------------------------------- CLI
def service_pid():
    """Instância ativa = batimento recente no banco (portátil: não usa os.kill, que é perigoso no Windows)."""
    try:
        con = db(); hb = float(meta_get(con, "heartbeat") or 0); con.close()
    except Exception: return None
    return True if time.time() - hb < float(cfg()["INTERVAL"]) * 2 + 10 else None

def cmd_start():
    if service_pid(): print("já em execução"); return
    HOME.mkdir(parents=True, exist_ok=True)
    kw = {}
    if os.name == "nt":
        kw["creationflags"] = 0x00000008 | 0x00000200 | 0x08000000  # DETACHED | NEW_GROUP | NO_WINDOW
    else:
        kw["start_new_session"] = True
    with open(LOG_FILE, "a", encoding="utf-8") as lf:
        subprocess.Popen([sys.executable, os.path.abspath(__file__), "run"], stdout=lf, stderr=lf,
                         stdin=subprocess.DEVNULL, env={**os.environ, "PYTHONUTF8": "1"}, **kw)
    for _ in range(50):
        time.sleep(0.2)
        if service_pid(): break
    print(("iniciado. " if service_pid() else "falha ao iniciar (veja: reelmon.py logs). ") + f"Painel: http://127.0.0.1:{cfg()['PORT']}")

def cmd_stop():
    if not service_pid(): print("não está em execução"); return
    STOP_FILE.write_text("stop")
    for _ in range(150):
        time.sleep(0.2)
        if not service_pid(): break
    print("parado" if not service_pid() else "ainda encerrando; aguarde alguns segundos")

def cmd_status():
    s = stats()
    print(f"serviço : {'em execução' if s['running'] else 'parado'}  [{s['health']}]")
    print(f"fonte   : {s['source']}  intervalo: {int(s['interval'])}s")
    print(f"ciclos  : {s['cycles']}  ok: {s['ok']}  falhas: {s['failures']}  indisponíveis: {s['unavailable']}")
    print(f"views   : inicial {s['initial']}  atual {s['current'] if s['current'] is not None else 'Coleta indisponível'}"
          + (f"  ({s['growth']:+d}, {s['growth_pct']:+.2f}%)" if s['growth'] is not None else ""))
    if s["last_error"]: print(f"último aviso: {s['last_error']}")

def cmd_watch():
    """Acompanha ao vivo no terminal (Ctrl+C sai). Só lê o que o serviço já gravou."""
    last = 0
    try:
        while True:
            con = db()
            for r in con.execute("SELECT * FROM runs WHERE id>? ORDER BY id", (last,)):
                last = r["id"]
                print(f"{datetime.fromtimestamp(r['started_at'], BRT):%d/%m %H:%M:%S}  {r['result']:<11} "
                      f"{'' if r['views'] is None else r['views']:<8} {r['source']:<10} {r['error'] or ''}")
            con.close(); time.sleep(3)
    except KeyboardInterrupt: pass

def cmd_add():
    """Registra uma leitura MANUAL (você leu o número no Instagram Insights, por ex.). Fica marcada como fonte 'manual'."""
    if len(sys.argv) < 3 or not sys.argv[2].isdigit(): print("uso: reelmon.py add <visualizações>"); return
    con = db()
    con.execute("INSERT INTO runs(started_at,duration_ms,result,views,error,source) VALUES(?,?,?,?,?,?)",
                (time.time(), 0, "ok", int(sys.argv[2]), None, "manual"))
    con.commit(); print("leitura manual registrada")

def cmd_panel():
    url = f"http://127.0.0.1:{cfg()['PORT']}"
    print(url); webbrowser.open(url)

def cmd_logs():
    try: print("".join(LOG_FILE.read_text(encoding="utf-8", errors="replace").splitlines(True)[-50:]))
    except FileNotFoundError: print("sem log ainda")

def main():
    for st in (sys.stdout, sys.stderr):
        try: st.reconfigure(encoding="utf-8", errors="replace")
        except Exception: pass
    cmd = sys.argv[1] if len(sys.argv) > 1 else "help"
    {"run": run_service, "start": cmd_start, "stop": cmd_stop, "status": cmd_status, "panel": cmd_panel,
     "restart": lambda: (cmd_stop(), cmd_start()), "watch": cmd_watch, "add": cmd_add, "logs": cmd_logs,
     "config": lambda: print(CFG_FILE)}.get(cmd, lambda: print(
        "uso: reelmon.py {start|stop|restart|status|watch|panel|logs|add <n>|config|run}\n"
        "  run = em primeiro plano (mostra cada ciclo no terminal; Ctrl+C para parar)"))()

if __name__ == "__main__": main()
