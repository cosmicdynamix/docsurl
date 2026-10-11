import { getBranding } from './branding.js';

export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const BASE_CSS = `
:root{color-scheme:dark light;--bg:#0b0d12;--surface:#12151c;--border:#262b38;--text:#e8eaf0;--muted:#8b93a7;--accent:#7c6cff}
@media (prefers-color-scheme:light){:root{--bg:#f6f7fb;--surface:#fff;--border:#dde1eb;--text:#12151c;--muted:#5b6478;--accent:#5b49f0}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;-webkit-text-size-adjust:100%}
.logo-l{display:none}
@media (prefers-color-scheme:light){.logo-d{display:none}.logo-l{display:inline-block}}
.bar{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:12px;padding:10px 16px;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--border)}
.bar img{height:26px;width:auto;max-width:160px;object-fit:contain}
.bar .nm{font-weight:600;white-space:nowrap}
@media (max-width:520px){.bar .nm{display:none}}
.bar .t{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600;font-size:.95rem;color:var(--muted);text-align:right}
.center{min-height:100dvh;display:grid;place-items:center;padding:16px}
.box{width:100%;max-width:380px;text-align:center}
.box .logo img{height:40px;width:auto;max-width:220px;object-fit:contain}
.box .logo{margin-bottom:18px}
.box .logo .nm{display:block;margin-top:8px;font-weight:600}
.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:20px;text-align:left}
h1{font-size:1.2rem;margin:0 0 .6rem}
p{margin:0 0 .8rem;color:var(--muted)}
input{width:100%;min-height:46px;padding:10px 12px;margin:6px 0 12px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:10px;font:inherit}
button{width:100%;min-height:46px;border:0;border-radius:10px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
.err{color:#f87171;margin:0 0 .8rem}
`;

function logos(): string {
  const b = getBranding();
  return `<img class="logo-d" src="/brand/logo/dark?v=${b.version}" alt=""><img class="logo-l" src="/brand/logo/light?v=${b.version}" alt="">`;
}

const bgCss = (): string => {
  const b = getBranding();
  if (!b.bgImage) return '';
  const veil = 'linear-gradient(color-mix(in srgb,var(--bg) 55%,transparent),color-mix(in srgb,var(--bg) 55%,transparent))';
  return `html{background:var(--bg)}body{background:transparent}body::before{content:'';position:fixed;inset:0;z-index:-1;background:${veil},url(/brand/background?v=${b.version}) center/cover no-repeat}`;
};

function shell(opts: { title: string; head?: string; body: string; nonce: string }): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>${esc(opts.title)}</title>
${
  getBranding().appIcon
    ? `<link rel="icon" type="image/png" href="/brand/icon/192?v=${getBranding().version}">`
    : `<link rel="icon" href="/brand/logo/light?v=${getBranding().version}" media="(prefers-color-scheme: light)">
<link rel="icon" href="/brand/logo/dark?v=${getBranding().version}" media="(prefers-color-scheme: dark)">`
}
<link rel="apple-touch-icon" href="/brand/icon/180?v=${getBranding().version}">
${opts.head ?? ''}
<style nonce="${opts.nonce}">${BASE_CSS}${bgCss()}</style>
</head><body>${opts.body}</body></html>`;
}

export function notFoundPage(nonce: string): string {
  return shell({
    title: getBranding().siteName,
    nonce,
    body: `<div class="center"><div class="box"><div class="logo">${logos()}<span class="nm">${esc(getBranding().siteName)}</span></div>
<div class="card"><h1>Link not found</h1><p>This link is invalid, has expired, or has been turned off.</p></div></div></div>`,
  });
}

export function unlockPage(opts: { slug: string; title: string; error?: boolean; nonce: string; src?: string | null }): string {
  return shell({
    title: opts.title,
    nonce: opts.nonce,
    body: `<div class="center"><div class="box"><div class="logo">${logos()}<span class="nm">${esc(getBranding().siteName)}</span></div>
<form class="card" method="post" action="/${encodeURIComponent(opts.slug)}/unlock${opts.src ? `?src=${encodeURIComponent(opts.src)}` : ""}">
<h1>${esc(opts.title)}</h1><p>This document is password protected.</p>
${opts.error ? '<p class="err">Incorrect password.</p>' : ''}
<label for="pw" style="font-size:.85rem;color:var(--muted)">Password</label>
<input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Open</button></form></div></div>`,
  });
}

export interface ViewerOpts {
  slug: string;
  title: string;
  linkId: string;
  versionNo: number;
  variant: string;
  pages: { width: number; height: number }[];
  exp: number;
  sig: string;
  ogImage: string | null;
  pageUrl: string;
  viewId: number;
  viewToken: string;
  nonce: string;
}

export function viewerPage(o: ViewerOpts): string {
  const imgBase = `/_p/${o.linkId}/${o.versionNo}/${o.variant}`;
  const pages = o.pages
    .map(
      (p, i) =>
        `<div class="pg" data-n="${i + 1}" style="aspect-ratio:${p.width}/${p.height}"><img alt="Page ${i + 1}" draggable="false" data-src="${imgBase}/${i + 1}?e=${o.exp}&t=${o.sig}"></div>`,
    )
    .join('');
  const og = `
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(getBranding().siteName)}">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(getBranding().siteName)}">
<meta property="og:url" content="${esc(o.pageUrl)}">
<meta name="twitter:card" content="${o.ogImage ? 'summary_large_image' : 'summary'}">
${o.ogImage ? `<meta property="og:image" content="${esc(o.ogImage)}">` : ''}`;
  const css = `
.pgs{max-width:1100px;margin:0 auto;padding:10px 8px 80px}
.pg{position:relative;width:100%;margin:0 0 10px;background:var(--surface);border:1px solid var(--border);border-radius:6px;overflow:hidden}
.pg img{position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;-webkit-user-drag:none;-webkit-touch-callout:none;user-select:none;opacity:0;transition:opacity .25s}
.pg img.ok{opacity:1}
.ind{position:fixed;left:50%;bottom:calc(14px + env(safe-area-inset-bottom));transform:translateX(-50%);background:color-mix(in srgb,var(--surface) 92%,transparent);backdrop-filter:blur(8px);border:1px solid var(--border);border-radius:999px;padding:6px 14px;font-size:.85rem;font-variant-numeric:tabular-nums}
@media print{body{display:none}}`;
  const js = `
  (function(){
    var pgs=[].slice.call(document.querySelectorAll('.pg')),ind=document.getElementById('ind'),total=pgs.length;
    var trk=document.getElementById("trk"),vid=trk.dataset.vid,vt=trk.dataset.vt;
    document.addEventListener('contextmenu',function(e){e.preventDefault()});
    var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){var i=e.target.querySelector('img');if(i&&!i.src){i.onload=function(){i.classList.add('ok')};i.src=i.dataset.src}io.unobserve(e.target)}})},{rootMargin:'900px 0px'});
    pgs.forEach(function(p){io.observe(p)});
    var cur=1,max=1,dwell={},active=0,t0=Date.now(),lastAct=Date.now(),IDLE=120000;
    var vis=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){cur=+e.target.dataset.n;if(cur>max)max=cur;ind.textContent=cur+' / '+total}})},{rootMargin:'-45% 0px -45% 0px'});
    pgs.forEach(function(p){vis.observe(p)});
    ind.textContent='1 / '+total;
    ['scroll','touchstart','touchmove','mousemove','keydown','wheel','click'].forEach(function(n){addEventListener(n,function(){lastAct=Date.now()},{passive:true})});
    // Active time: tab visible AND recent interaction (so a tab left open does not count as reading).
    setInterval(function(){if(document.visibilityState==='visible'&&Date.now()-lastAct<IDLE){active+=1000;dwell[cur]=(dwell[cur]||0)+1000}},1000);
    function send(){
      var body=JSON.stringify({t:vt,a:active,o:Date.now()-t0,p:max,d:dwell,w:screen.width,h:screen.height,l:(navigator.language||'').slice(0,20)});
      try{
        if(navigator.sendBeacon){navigator.sendBeacon('/_t/'+vid,new Blob([body],{type:'text/plain'}))}
        else{fetch('/_t/'+vid,{method:'POST',body:body,keepalive:true,headers:{'Content-Type':'text/plain'}})}
      }catch(e){}
    }
    setTimeout(send,1500);
    setInterval(function(){if(document.visibilityState==='visible')send()},10000);
    document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden')send()});
    addEventListener('pagehide',send);
  })();`;
  return shell({
    title: o.title,
    nonce: o.nonce,
    head: og,
    body: `<style nonce="${o.nonce}">${css}</style><div hidden id="trk" data-vid="${o.viewId}" data-vt="${o.viewToken}"></div>
<div class="bar">${logos()}<span class="nm">${esc(getBranding().siteName)}</span><span class="t">${esc(o.title)}</span></div>
<div class="pgs">${pages}</div><div class="ind" id="ind"></div>
<script nonce="${o.nonce}">${js}</script>`,
  });
}
