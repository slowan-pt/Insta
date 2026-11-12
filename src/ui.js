export const PAGE = `<!doctype html>
<html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Monitor de Reels</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--tx:#14181f;--mut:#667085;--bd:#e3e6eb;--ac:#2563eb;--ok:#16803c;--warn:#b45309;--bad:#b42318}
@media(prefers-color-scheme:dark){:root{--bg:#0f1318;--card:#171c23;--tx:#e8ebf0;--mut:#93a0b2;--bd:#262d38;--ac:#6ea2ff;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.45 system-ui,sans-serif}
main{max-width:980px;margin:0 auto;padding:16px}
h1{font-size:1.15rem;margin:0}a{color:var(--ac)}
header{display:flex;flex-wrap:wrap;gap:8px 16px;justify-content:space-between;align-items:center;margin-bottom:12px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:14px;margin-bottom:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.k{color:var(--mut);font-size:.8rem}.v{font-size:1.6rem;font-weight:700;font-variant-numeric:tabular-nums}
.badge{display:inline-flex;align-items:center;gap:6px;font-weight:600}.dot{width:10px;height:10px;border-radius:50%;background:var(--mut)}
.alert{border-left:4px solid var(--bad);padding:10px 12px;background:var(--card);border-radius:8px;margin-bottom:12px;display:none}
.tabs{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}
button,.btn{font:inherit;border:1px solid var(--bd);background:var(--card);color:var(--tx);border-radius:8px;padding:7px 12px;cursor:pointer;text-decoration:none}
button[aria-pressed=true]{background:var(--ac);color:#fff;border-color:var(--ac)}
canvas{width:100%;height:260px;display:block}
.tw{overflow:auto;max-height:340px}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--bd);white-space:nowrap}th{color:var(--mut);font-weight:600;position:sticky;top:0;background:var(--card)}
.s-ok{color:var(--ok)}.s-error{color:var(--bad)}.s-unavailable{color:var(--warn)}
small{color:var(--mut)}pre{white-space:pre-wrap}
</style></head><body><main>
<header><div><h1>Visualizações do Reels <small id="profile"></small></h1><small><a id="reelurl" target="_blank" rel="noopener">abrir Reel</a></small></div>
<div class="badge" id="health"><span class="dot"></span><span>…</span></div></header>
<div class="alert" id="alert"></div>
<div id="dash">
<section class="card"><div class="grid">
<div><div class="k">Inicial</div><div class="v" id="initial">–</div><small id="initdate"></small></div>
<div><div class="k">Atual</div><div class="v" id="current">–</div><small id="lastvalid">última coleta válida: –</small></div>
<div><div class="k">Crescimento</div><div class="v" id="growth">–</div><small id="growthpct"></small></div>
<div><div class="k">Encerra em</div><div class="v" id="countdown">–</div><small id="endat"></small></div>
</div></section>
<section class="card"><b>Comparar períodos</b>
<div class="tabs" id="tabs"></div>
<div class="grid" id="pgrid"></div></section>
<section class="card"><b>Evolução (histórico completo)</b><canvas id="chart"></canvas><small id="chartnote"></small></section>
<section class="card"><b>Últimas medições</b><div class="tw"><table><thead><tr><th>Data/hora (Brasília)</th><th>Views</th><th>Status</th><th>Detalhe</th></tr></thead><tbody id="rows"></tbody></table></div></section>
<section class="card" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
<a class="btn" href="/export.csv">Exportar CSV</a><a class="btn" href="/relatorio">Relatório</a><button id="stop">Parar monitoramento</button>
<small id="upd"></small></section>
<small>A tela atualiza a cada 30 s apenas para <i>exibir</i> o que já está no banco; a coleta das métricas é feita no servidor (Cloudflare Cron + D1), mesmo com o navegador fechado.</small>
</div>
<div id="report" style="display:none"></div>
</main>
<script>
const $=id=>document.getElementById(id), nf=new Intl.NumberFormat('pt-BR');
const fmt=t=>t==null?'–':new Date(t).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'});
const sign=n=>n==null?'–':(n>0?'+':'')+nf.format(n);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let S=null,period=localStorage.getItem('p')||'5m';
const PL={'5m':'5 min','15m':'15 min','30m':'30 min','1h':'1 hora','24h':'24 horas'};
const H={ok:['var(--ok)','Coletando normalmente'],unavailable:['var(--warn)','Coleta indisponível'],error:['var(--bad)','Erro na coleta'],down:['var(--bad)','Coletor sem resposta'],stopped:['var(--mut)','Monitoramento encerrado']};
function renderPeriods(){
 $('tabs').innerHTML=Object.keys(PL).map(k=>'<button aria-pressed="'+(k===period)+'" data-p="'+k+'">'+PL[k]+'</button>').join('');
 $('tabs').querySelectorAll('button').forEach(b=>b.onclick=()=>{period=b.dataset.p;localStorage.setItem('p',period);renderPeriods()});
 if(!S)return;
 $('pgrid').innerHTML=Object.keys(PL).map(k=>{const p=S.periods[k];return '<div style="'+(k===period?'outline:2px solid var(--ac);':'')+'border-radius:8px;padding:6px"><div class="k">Últimos '+PL[k]+'</div><div class="v">'+(p.added==null?'–':sign(p.added))+'</div><small>'+(p.added==null?'sem dados':p.partial?'desde a 1ª medição':'base '+nf.format(p.baseViews))+'</small></div>'}).join('');
}
function render(){
 const s=S;$('profile').textContent='@'+s.reel.profile;$('reelurl').href=s.reel.url;
 const h=H[s.health];$('health').innerHTML='<span class="dot" style="background:'+h[0]+'"></span><span>'+h[1]+'</span>';
 $('initial').textContent=nf.format(s.initial);$('initdate').textContent='informado em '+s.initialDate.split('-').reverse().join('/');
 $('current').textContent=s.current==null?'Coleta indisponível':nf.format(s.current);
 if(s.current==null)$('current').style.fontSize='1.1rem';else $('current').style.fontSize='';
 $('lastvalid').textContent='última coleta válida: '+(s.lastValidAt?fmt(s.lastValidAt):'nenhuma');
 $('growth').textContent=sign(s.growth);$('growthpct').textContent=s.growthPct==null?'':(s.growthPct>=0?'+':'')+s.growthPct.toFixed(2).replace('.',',')+'%';
 $('endat').textContent=fmt(s.endAt);
 const a=$('alert');
 if(s.health==='unavailable'||s.counts.ok===0&&s.lastAttempt){a.style.display='block';a.innerHTML='<b>Coleta indisponível.</b> '+esc(s.lastAttempt&&s.lastAttempt.message||'')+'<br><small>Nenhuma contagem é estimada ou simulada. Para habilitar: token da Instagram Graph API da conta dona do Reel (instagram_basic + instagram_manage_insights) e o ID da conta profissional.</small>'}
 else if(s.health==='error'){a.style.display='block';a.innerHTML='<b>Última tentativa falhou:</b> '+esc(s.lastAttempt.message||'')}
 else a.style.display='none';
 $('stop').style.display=s.active.active?'':'none';
 renderPeriods();
}
function tick(){ if(!S)return; const d=S.endAt-Date.now();
 if(!S.active.active||d<=0){$('countdown').textContent='Encerrado';return}
 const t=Math.floor(d/1000);$('countdown').textContent=Math.floor(t/3600)+'h '+String(Math.floor(t%3600/60)).padStart(2,'0')+'m '+String(t%60).padStart(2,'0')+'s'}
function chart(data){
 const c=$('chart'),dpr=devicePixelRatio||1,w=c.clientWidth,h=c.clientHeight;c.width=w*dpr;c.height=h*dpr;
 const x=c.getContext('2d');x.scale(dpr,dpr);x.clearRect(0,0,w,h);
 const cs=getComputedStyle(document.body);const tx=cs.getPropertyValue('--mut'),ac=cs.getPropertyValue('--ac'),bd=cs.getPropertyValue('--bd');
 $('chartnote').textContent=data.length?data.length+' pontos (medições válidas)':'Sem medições válidas ainda — nada a exibir.';
 if(!data.length)return;
 const L=52,R=10,T=10,B=24;let t0=data[0].ts,t1=data[data.length-1].ts;if(t1===t0)t1=t0+1;
 let lo=Math.min(S.initial,...data.map(d=>d.views)),hi=Math.max(S.initial,...data.map(d=>d.views));if(hi===lo)hi=lo+1;
 const X=t=>L+(t-t0)/(t1-t0)*(w-L-R),Y=v=>T+(1-(v-lo)/(hi-lo))*(h-T-B);
 x.font='11px system-ui';x.fillStyle=tx;x.strokeStyle=bd;
 for(let i=0;i<=4;i++){const v=lo+(hi-lo)*i/4,y=Y(v);x.beginPath();x.moveTo(L,y);x.lineTo(w-R,y);x.stroke();x.fillText(nf.format(Math.round(v)),2,y+4)}
 const f=t=>new Date(t).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit',timeZone:'America/Sao_Paulo'});
 x.fillText(f(t0),L,h-6);x.textAlign='right';x.fillText(f(t1),w-R,h-6);x.textAlign='left';
 x.setLineDash([4,4]);x.beginPath();x.moveTo(L,Y(S.initial));x.lineTo(w-R,Y(S.initial));x.stroke();x.setLineDash([]);
 x.strokeStyle=ac;x.lineWidth=2;x.beginPath();data.forEach((d,i)=>i?x.lineTo(X(d.ts),Y(d.views)):x.moveTo(X(d.ts),Y(d.views)));x.stroke();
 if(data.length===1){x.fillStyle=ac;x.beginPath();x.arc(X(t0),Y(data[0].views),4,0,7);x.fill()}
}
let SER=[];
async function refresh(){
 try{
  const [s,ser,rec]=await Promise.all(['/api/summary','/api/series','/api/recent?limit=100'].map(u=>fetch(u).then(r=>r.json())));
  S=s;SER=ser;render();chart(ser);
  $('rows').innerHTML=rec.map(r=>'<tr><td>'+fmt(r.ts)+'</td><td>'+(r.views==null?'–':nf.format(r.views))+'</td><td class="s-'+r.status+'">'+r.status+'</td><td>'+esc(r.message||'')+'</td></tr>').join('');
  $('upd').textContent='tela atualizada '+new Date().toLocaleTimeString('pt-BR');
 }catch(e){$('upd').textContent='falha ao atualizar a tela: '+e.message}
}
$('stop').onclick=async()=>{const t=prompt('Senha de administração para PARAR o monitoramento:');if(!t)return;
 const r=await fetch('/api/admin/stop',{method:'POST',headers:{authorization:'Bearer '+t}});alert(r.ok?'Monitoramento parado. Relatório final gerado.':'Falha: '+(await r.json()).error);refresh()};
async function reportView(){
 $('dash').style.display='none';$('report').style.display='';
 const r=await fetch('/api/report').then(r=>r.json());const L=a=>'<ul>'+a.map(i=>'<li>'+i+'</li>').join('')+'</ul>';
 document.title='Relatório – Monitor de Reels';
 $('report').innerHTML='<p><a href="/">← painel</a></p><section class="card"><h1>Relatório do experimento</h1><small>Estado: '+esc(r.state)+' · gerado em '+esc(r.generatedAtBrt)+' (Brasília)</small>'+
 '<div class="grid" style="margin-top:10px"><div><div class="k">Inicial</div><div class="v">'+nf.format(r.initial)+'</div></div><div><div class="k">Final</div><div class="v">'+(r.final==null?'Sem coleta':nf.format(r.final))+'</div></div><div><div class="k">Aumento</div><div class="v">'+sign(r.absolute)+'</div></div><div><div class="k">Aumento %</div><div class="v">'+(r.percent==null?'–':r.percent.toFixed(2).replace('.',',')+'%')+'</div></div></div></section>'+
 '<section class="card"><b>Evolução por hora (Brasília)</b><div class="tw"><table><tr><th>Hora</th><th>Acréscimo</th><th>Medições</th><th>Views ao fim</th></tr>'+(r.byHour.map(h=>'<tr><td>'+esc(h.hour)+'</td><td>'+sign(h.added)+'</td><td>'+h.samples+'</td><td>'+nf.format(h.endViews)+'</td></tr>').join('')||'<tr><td colspan=4>Sem dados válidos</td></tr>')+'</table></div></section>'+
 '<section class="card"><b>Horários de maior crescimento</b>'+(r.topHours.length?L(r.topHours.map(h=>esc(h.hour)+': '+sign(h.added))):'<p>Sem dados.</p>')+'</section>'+
 '<section class="card"><b>Falhas de coleta</b><p>'+r.validMeasurements+' medições válidas de '+r.attempts+' tentativas.</p>'+(r.failures.length?L(r.failures.map(f=>esc(f.status)+': '+f.count+' ('+esc(f.first)+' a '+esc(f.last)+')')):'<p>Nenhuma falha.</p>')+(r.topErrors.length?L(r.topErrors.map(e=>e.n+'× '+esc(e.message))):'')+'</section>'+
 '<section class="card"><b>Fonte das métricas</b><p>'+esc(r.source)+'</p></section>'+
 '<section class="card"><b>Limitações</b>'+L(r.limitations.map(esc))+'<p><b>Observado ≠ causado.</b> '+esc(r.causality)+'</p></section>';
}
if(location.pathname==='/relatorio')reportView();
else{refresh();setInterval(refresh,30000);setInterval(tick,1000);addEventListener('resize',()=>chart(SER));renderPeriods()}
</script></body></html>`;
