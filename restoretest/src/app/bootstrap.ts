// ---------------------------------------------------------------------------
// Bootstrap: resolve the data source, render the report (or the file picker),
// and hand off to the chart renderer.
// ---------------------------------------------------------------------------
import { copyText } from "../clipboard";
import { analyze, render_body } from "../core";
import { runChart, CTRL_DEFAULTS } from "../chart/chart";
import { esc, fmtDur, fmtSettings } from "../format/format";
import { runsToSets, catalogToRuns, setIdentity } from "./runsets";
import { recordSets, listCards, getRunsFor, sortAndGroupCards, historyModalHTML, avgTimeTo100 } from "./history";
import { initSticky } from "../sticky";
var MAX_SETS = 5;   // catalog cap: at/above this, the two add tiles are disabled (overflow via
                    // a sibling-arm add from the modal is still allowed — the cap gates opening)
(function(){

 // Unicode-safe base64url of the arms JSON. NOTE: very large multi-run payloads
 // can exceed practical URL lengths, so the hash path is best for single-run /
 // small payloads; host injection and the file picker cover the rest.
 function b64urlEncode(str){
   var bytes=new TextEncoder().encode(str),bin='';
   for(var i=0;i<bytes.length;i++)bin+=String.fromCharCode(bytes[i]);
   return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
 }
 // Decode a payload from the URL fragment / a pasted link into the arms object. The
 // encoder (roachtest / the launcher) gzips before base64url to keep links short, so we
 // sniff the gzip magic (1f 8b) and inflate via DecompressionStream; a plain (un-gzipped)
 // base64url payload — e.g. the in-browser copy-link — still decodes as before. Async
 // because DecompressionStream is stream-based.
 async function decodePayload(s){
   s=s.replace(/-/g,'+').replace(/_/g,'/');
   var bin=atob(s),bytes=new Uint8Array(bin.length);
   for(var i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
   var text;
   if(bytes.length>1 && bytes[0]===0x1f && bytes[1]===0x8b){
     var stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
     text=await new Response(stream).text();
   } else {
     text=new TextDecoder().decode(bytes);
   }
   return JSON.parse(text);
 }
 // Exposed so the copy-link button can encode the currently-rendered arms.
 window.__ENCODE_ARMS__=function(){
   try{ if(!window.__ARMS__)return null; return b64urlEncode(JSON.stringify(window.__ARMS__)); }
   catch(e){ return null; }
 };
 // gzip+base64url encoder (mirror of decodePayload), for re-encoding the live catalog +
 // selection into the URL. Async because CompressionStream is stream-based.
 async function encodePayload(obj){
   var bytes=new TextEncoder().encode(JSON.stringify(obj));
   var stream=new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
   var buf=new Uint8Array(await new Response(stream).arrayBuffer());
   var bin=''; for(var i=0;i<buf.length;i++) bin+=String.fromCharCode(buf[i]);
   return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
 }
 // Keep the URL fragment in sync with the live catalog + selection so the current view
 // (including X-outs and which arms are picked) is shareable and survives a reload.
 // replaceState avoids history spam and can throw on some file:// browsers -> best effort.
 // CTRL_DEFAULTS is imported from chart.ts (single source of truth for the control defaults);
 // the slug stores only the diff against them so an unchanged view stays clean.
 var CTRL={};   // current non-default control overrides
 // Once the report data has been shared, REF is its id in the link store. When set,
 // persistHash writes a small {ref,sel,ctrl} slug instead of inlining the heavy runs, so
 // the URL stays short while control tweaks (sel/ctrl) keep updating it live. Any edit to
 // the catalog itself (removeArm / compare) clears REF, falling back to inline runs.
 var REF=null;
 // Called from the chart's sync() with the live control state: diff against defaults and
 // re-persist. CTRL carries the latest overrides so an arm re-render re-seeds them.
 function persistCtrl(state){
   var d={}; for(var k in CTRL_DEFAULTS){ if(state[k]!==CTRL_DEFAULTS[k]) d[k]=state[k]; }
   CTRL=d; persistHash();
 }
 // Returns a promise for the written slug (the share button uses it to build the link).
 function persistHash(){
   if(!CATALOG || !CATALOG.length) return Promise.resolve(null);
   // Persist the flat run list ({runs}); regrouping on load reconstructs the same sets in
   // the same order, so SEL indices stay valid. A shared view stores only {ref}.
   var payload:any = REF ? {ref:REF} : {runs:catalogToRuns(CATALOG)};
   payload.sel=SEL;
   if(CTRL && Object.keys(CTRL).length) payload.ctrl=CTRL;
   return encodePayload(payload).then(function(slug){
     try{ history.replaceState(null,'','#'+slug); }catch(e){}
     return slug;
   }).catch(function(){ return null; });
 }

 // ---- Share: offload the immutable report data (the arm CATALOG) to a Google Sheet via
 // a small Apps Script, and put only its short id in the URL. Reading is anonymous; only
 // sharing hits the network. See artifacts/../roachtest-perf-links for the backend. ----
 var SHARE_URL='https://script.google.com/macros/s/AKfycbyyB1ygZlTQ2WtLQAIBFdggiIsVrzQ8gL980CLYjiQ7koFQHip9-M3jCB9CY3JdW-uP/exec';
 var LOADERR=null;   // set when a shared report fails to load; surfaced by the picker
 // copyLink is now the shared copyText (imported from ../clipboard).
 var copyLink = copyText;
 // POST as text/plain to stay a CORS "simple request" — Apps Script can't answer a
 // preflight. `detail` is the gzip+base64url run payload (the same encoding decodePayload
 // already understands); the store keeps it opaque and hands it back on fetch.
 async function uploadCatalog(){
   var detail=await encodePayload(catalogToRuns(CATALOG));
   var res=await fetch(SHARE_URL,{method:'POST',
     headers:{'Content-Type':'text/plain;charset=utf-8'},
     body:JSON.stringify({detail:detail})});
   var out=await res.json();
   if(out.error) throw new Error(out.error);
   return out.id;
 }
 async function fetchCatalog(id){
   var res=await fetch(SHARE_URL+'?id='+encodeURIComponent(id));
   var out=await res.json();
   if(out.error) throw new Error(out.error);
   return runsFromPayload(await decodePayload(out.detail));   // -> flat run list
 }
 document.addEventListener('click',function(e:any){
   var b=e.target.closest&&e.target.closest('[data-share]'); if(!b)return;
   e.preventDefault();
   if(b.classList.contains('busy') || !CATALOG || !CATALOG.length) return;
   b.classList.remove('ok','err'); b.classList.add('busy'); b.textContent='creating short link…';
   uploadCatalog().then(function(id){
     REF=id; return persistHash();                       // rewrite hash as {ref,sel,ctrl}
   }).then(function(slug){
     if(!slug) throw new Error('failed to encode link');
     return copyLink(location.origin+location.pathname+'#'+slug);
   }).then(function(){
     b.classList.remove('busy'); b.classList.add('ok'); b.textContent='link copied ✓';
     setTimeout(function(){ b.classList.remove('ok'); b.textContent='share'; },2200);
   }).catch(function(err){
     console.error('share failed:',err);
     b.classList.remove('busy'); b.classList.add('err'); b.textContent='share failed';
     setTimeout(function(){ b.classList.remove('err'); b.textContent='share'; },2600);
   });
 });

 // Run-trace hover (bold one run across all charts + cursor readout) now lives with the
 // rest of the chart pointer interaction in chart/chart.ts.

 // ---- arm catalog (any number of arms) + selector (pick 1 to view, 2 to compare) ----
 // The injected/hash payload is a CATALOG of all bundled arms. The rendering path only
 // ever handles 1-2 arms whose color roles are positional (arms[0]->ctl/orange,
 // arms[1]->exp/blue), so a thin selector picks 1-2 catalog entries and feeds the
 // unchanged renderReport. CATALOG holds the full set; SEL is a fixed [slotA, slotB]
 // pair of catalog indices (null = empty). Slots are stable: un-picking one keeps the
 // other in place (so a partner arm doesn't change color mid-comparison).
 var CATALOG=null, SEL=[null,null];
 // esc is imported from ../format/format (shared HTML-escaper; also escapes ').
 var MON=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
 // Parse an arm's yymmdd-HHMMSS stamp into display components; fall back to `name` if
 // there's no stamp (e.g. --teamcity's bare run_N layout).
 function armTsFields(a){
   var ts=a&&a.ts, ab=(a&&a.ab)||null;
   var m=ts&&/^(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(ts);
   if(!m){ var nm=(a&&a.name)||(a&&a.label)||'?'; return {date:nm,hm:nm,hms:nm,ab:ab}; }
   return {date:(MON[(+m[2])-1]||('M'+m[2]))+m[3], hm:m[4]+':'+m[5], hms:m[4]+':'+m[5]+':'+m[6], ab:ab};
 }
 // Minimal-distinguishing names for a set of arms: the coarsest of {date, HHMM, HHMMSS,
 // +A/B} that makes all names unique. Dates are dropped when they don't vary (so a
 // same-day pair shows just the time); the a/b suffix disambiguates same-timestamp
 // --ab arms. Called with the catalog (picker) and with the shown pair (header), so an
 // arm's header name is as short as the pair allows.
 function labelArms(arms){
   var F=arms.map(armTsFields);
   var multiDate=(new Set(F.map(function(x){return x.date;}))).size>1;
   function uniq(a){var s={};for(var i=0;i<a.length;i++){if(s[a[i]])return false;s[a[i]]=1;}return true;}
   function gen(gran,ab){ return F.map(function(x){
     var v=(multiDate&&x.date?x.date+'-':'')+(gran==='hms'?x.hms:x.hm);
     if(ab&&x.ab) v+='-'+x.ab.toUpperCase();
     return v; }); }
   var cands=[];
   if(multiDate) cands.push(F.map(function(x){return x.date;}));   // date alone
   cands.push(gen('hm',false), gen('hms',false), gen('hm',true), gen('hms',true));
   for(var i=0;i<cands.length;i++){ if(uniq(cands[i])) return cands[i]; }
   return gen('hms',true).map(function(s,i){return s+'#'+(i+1);});  // last resort
 }
 // Average restore-completion time (avg time-to-100% download over the set's runs) is shared
 // with the recently-viewed card via avgTimeTo100 (imported from ./history); fmtDur lives in
 // ../format/format.
 // Build the 1-2 arms to render from the slot pair: clone (so the catalog survives),
 // and set each arm's display label to its minimal name for this pair. Settings stay
 // raw — CORE diffs the pair itself. Order is [slotA, slotB] with empty slots dropped,
 // so the surviving arm of a partial selection renders solo.
 function armsForSelection(){
   var chosen=[SEL[0],SEL[1]].filter(function(x){return x!=null;})
     .map(function(i){return CATALOG[i];}).filter(Boolean);
   if(!chosen.length) chosen=[CATALOG[0]];
   var names=labelArms(chosen);
   return chosen.map(function(a,i){ var c=Object.assign({},a); c.label=names[i]; return c; });
 }
 function armBarHTML(){
   var sets=CATALOG||[];
   var multi=sets.length>=2;   // <2: nothing to pick/compare/remove — just the arm + share
   var names=sets.length?labelArms(sets):[], bothFull=(SEL[0]!=null&&SEL[1]!=null);
   var chips=sets.map(function(a,i){
     var role=(SEL[0]===i?0:SEL[1]===i?1:-1), dim=(multi&&bothFull&&role<0);
     var cls='armchip'+(role>=0?(' sel sel'+(role===0?'A':'B')):'')+(dim?' dim':'');
     // Bold the arm's short (report) name; when it doesn't already carry the date (a
     // same-day catalog shows just the time), prefix the date as lighter context.
     var date=armTsFields(a).date, short=names[i], nameHtml;
     if(short.indexOf(date)===0) nameHtml='<b class="armname">'+esc(short)+'</b>';
     else nameHtml='<span class="armdate">'+esc(date)+'</span> <b class="armname">'+esc(short)+'</b>';
     var sub=[]; var d=avgTimeTo100(a.runs), cnt=a.runs?a.runs.length:0;
     sub.push(cnt+'x'+(d!=null?' '+fmtDur(d):''));   // e.g. "5x 6m32s" (count x avg time-to-100%)
     if(a.sha) sub.push(a.sha.slice(0,8));
     var st=fmtSettings(a.settings);
     if(st) sub.push(st);
     return '<div class="'+cls+'" data-armidx="'+i+'">'
       +'<span class="armpick" data-armpick="'+i+'"'+(dim?' aria-disabled="true"':'')+'>'
       +'<span class="armnameline">'+nameHtml+'</span>'
       +'<span class="armsub">'+esc(sub.join(' · '))+'</span></span>'
       +'<span class="armx" data-armremove="'+i+'" title="remove from catalog">×</span>'
       +'</div>';
   }).join('');
   // A single [+] tile opens the "add runsets to comparison" modal (paste link / import a
   // summary_report.json / pick from recently-viewed). At the catalog cap it greys out and
   // stops opening, with a remove-first tooltip — the cap gates opening, but a sibling-arm
   // add from the modal may still push slightly past it (see MAX_SETS).
   var capped=sets.length>=MAX_SETS;
   var addTile='<div class="armchip armadd'+(capped?' disabled':'')+'" data-modal-open'
     + (capped?' aria-disabled="true" title="remove some runs before adding more"'
              :' title="add run sets to compare"')+'>'
     + '<span class="armpick armaddtoggle">'
     + '<span class="armnameline"><b class="armname">+</b></span>'
     + '<span class="armsub">compare</span></span>'
     + '</div>';
   // Share lives here now (the top-level control bar is gone). Right-aligned via CSS. Hidden
   // until there's something to share (the no-data empty state shows only the [+] tile).
   var share=sets.length?'<button class="sharebtn" data-share title="copy a short shareable link">share</button>':'';
   return '<div class="armbar" data-armbar>'+chips+addTile+share+'</div>';
 }
 // Render the current selection, then re-insert the selector bar (render_body owns
 // document.body, so the bar must be prepended after each render). With nothing picked
 // we clear the report and show just the picker.
 function renderView(){
   if(CATALOG && CATALOG.length===1){       // nothing to pick — just show the lone arm
     SEL=[0,null];
     renderReport(armsForSelection());
   } else if(SEL[0]==null && SEL[1]==null){
     document.body.className='';
     document.body.innerHTML='<p class="armempty">Nothing selected — pick an arm to view, or two to compare.</p>';
   } else {
     renderReport(armsForSelection());
     // Survivor of a comparison that sits in slot B keeps the blue (exp) palette.
     if(SEL[0]==null && SEL[1]!=null) document.body.classList.add('soloB');
   }
   var bar=armBarHTML();
   // Prepend the arm bar to the whole .report (NOT the short .details section): position:sticky
   // only holds within its parent's box, so nesting it in .details would unstick it the moment
   // you scrolled past Details. Parented to .report it stays pinned to the top across the entire
   // scroll, and sticky.ts publishes its height as --dash-arm-h so the graph/control bars pin
   // just beneath it. Fall back to the body for the picker / empty states (no .report).
   if(bar){ var host=document.querySelector('.report')||document.body;
     host.insertAdjacentHTML('afterbegin', bar); }
   initSticky();
   persistHash();                           // keep the URL in sync with catalog + selection
 }
 // Remove an arm from the catalog (and the shareable slug), reindexing the slot pair so
 // the surviving selection stays put.
 function removeArm(i){
   if(!CATALOG || i<0 || i>=CATALOG.length) return;
   CATALOG.splice(i,1);
   REF=null;   // catalog changed -> any prior share id is stale; re-inline until re-shared
   SEL=SEL.map(function(s){ return s==null?null : s===i?null : (s>i?s-1:s); });
   // X-ing out the last run set drops back to the empty state (ribbon + open modal); clear the
   // now-stale slug so a reload doesn't re-load the removed data.
   if(!CATALOG.length){ try{ history.replaceState(null,'',location.pathname); }catch(e){} renderEmpty(); return; }
   renderView();
 }
 // Chip click: the × removes the arm; the body fills the first empty slot (clicking a
 // selected chip un-picks it, down to empty). With both slots full the rest are greyed —
 // un-pick before swapping, which keeps the surviving partner in its slot/color.
 document.addEventListener('click',function(e:any){
   var rm=e.target.closest&&e.target.closest('[data-armremove]');
   if(rm){ e.preventDefault(); removeArm(+rm.getAttribute('data-armremove')); return; }
   var pick=e.target.closest&&e.target.closest('[data-armpick]'); if(!pick)return;
   e.preventDefault();
   var i=+pick.getAttribute('data-armpick');
   var pos=(SEL[0]===i?0:SEL[1]===i?1:-1);
   if(pos>=0){ SEL[pos]=null; }
   else if(SEL[0]==null){ SEL[0]=i; }
   else if(SEL[1]==null){ SEL[1]=i; }
   else { return; }                        // both full -> greyed; ignore until an un-pick
   renderView();
 });

 // ---- "add runsets" modal: paste link / import JSON / recently viewed ----
 // The ribbon's single [+] tile opens a modal with three ways to add run sets. Paste-link and
 // JSON-import both parse first and show a "would add N runs" preview with an Add button (a
 // confirm step); recently-viewed rows add on click (they already show a count) and close.
 // All three funnel through addRuns(), which dedupes against the catalog and regroups.
 var MODAL_CARDS=[];             // the recently-viewed cards shown in the open modal
 var STAGED:any={link:null,file:null};   // parsed-but-unconfirmed runs, per section
 var LINKT:any=null;             // debounce timer for link parsing

 // Normalize any decoded payload the app itself produces into a flat run list: a bare run
 // array (launcher / roachtest), an inline {runs,sel,ctrl} (address-bar copy of a loaded
 // report), or a shared {ref,...} slug (fetch the runs by id). Mirrors resolveAndRender so
 // pasting ANY of the links this app (or the test) hands out works.
 async function runsFromPayload(p){
   if(!p) return null;
   if(Array.isArray(p)) return p;
   if(Array.isArray(p.runs)) return p.runs;
   if(p.ref){ try{ return await fetchCatalog(p.ref); }catch(e){ return null; } }
   return null;
 }
 // A dropped/opened JSON file may be a single summary_report.json (one run body), a bare array,
 // or a {runs:[...]} wrapper — accept all three.
 function runsFromJson(obj){
   if(!obj) return [];
   if(Array.isArray(obj)) return obj;
   if(Array.isArray(obj.runs)) return obj.runs;
   if(obj.metadata||obj.elapsed||obj.v) return [obj];
   return [];
 }
 // Runs not already in the catalog (by exact content). Built from the CURRENT catalog only, so
 // an incoming doc carrying N genuinely-identical runs keeps all N.
 function freshRuns(runs){
   var have={}; catalogToRuns(CATALOG||[]).forEach(function(r){ have[JSON.stringify(r)]=1; });
   return (runs||[]).filter(function(r){ return !have[JSON.stringify(r)]; });
 }
 // Merge runs into the catalog and regroup; select the first new set into a free slot (or, from
 // the empty state, default the usual solo/compare selection). Returns false if nothing new.
 function addRuns(runs){
   var fresh=freshRuns(runs); if(!fresh.length) return false;
   var before=(CATALOG||[]).length;
   CATALOG=runsToSets(catalogToRuns(CATALOG||[]).concat(fresh));
   REF=null;   // catalog changed -> any prior share id is stale; re-inline until re-shared
   if(before===0){ SEL = CATALOG.length>=2?[0,1]:[0,null]; }
   else if(CATALOG.length>before){ var bi=before;
     if(SEL[0]==null) SEL[0]=bi; else if(SEL[1]==null) SEL[1]=bi; }
   recordSets(CATALOG).then(refreshRecent);   // remember the newly-added sets, refresh the cache
   return true;
 }
 // Render the parse result for a section: an error, an "already present" note, or the
 // Import/Cancel confirm buttons. Stashes the fresh runs in STAGED[kind].
 function showPreview(kind, runs){
   var el=document.querySelector('[data-rvprev="'+kind+'"]') as any; if(!el) return;
   STAGED[kind]=null;
   if(!runs || !runs.length){ el.className='rvprev bad'; el.textContent='couldn’t read that.'; return; }
   var fresh=freshRuns(runs);
   if(!fresh.length){ el.className='rvprev'; el.textContent='already in the catalog.'; return; }
   STAGED[kind]=fresh;
   var sets=runsToSets(fresh).length;
   el.className='rvprev ok';
   el.innerHTML='<button class="rvconfirm" data-rvconfirm="'+kind+'">Import '+sets+' run-set'+(sets>1?'s':'')
     +' <span class="rvcount">('+fresh.length+' run'+(fresh.length>1?'s':'')+' total)</span></button>'
     +'<button class="rvcancel" data-rvcancel="'+kind+'">Cancel</button>';
 }
 async function parseLink(val){
   val=(val||'').trim();
   var el=document.querySelector('[data-rvprev="link"]') as any;
   if(!val){ if(el){ el.className='rvprev'; el.textContent=''; } STAGED.link=null; return; }
   var h=val.indexOf('#')>=0?val.slice(val.indexOf('#')+1):val;   // accept full URL or bare hash
   var pasted=null; try{ pasted=await decodePayload(h); }catch(err){}
   var runs=await runsFromPayload(pasted);
   showPreview('link', runs);
 }
 // Read imported reports into runs. Only files literally named summary_report.json are read —
 // that's the generator's fixed output name, so this never touches the huge non-report JSON in an
 // artifacts tree (pprof/heap/debug dumps), which is what OOM'd the tab. Bounded concurrency keeps
 // even a large run count from spiking memory all at once.
 var READ_CONC=8;
 // File preview helpers: a spinner (busy), a plain/error message, and the file preview element.
 function fileprev(){ return document.querySelector('[data-rvprev="file"]') as any; }
 function setImporting(text){ var el=fileprev(); if(el){ el.className='rvprev busy'; el.innerHTML='<span class="rvspin"></span> '+esc(text); } }
 function setImportMsg(text, bad){ var el=fileprev(); if(el){ el.className='rvprev'+(bad?' bad':''); el.textContent=text; } STAGED.file=null; }
 async function readFiles(files){
   files = files || [];
   var arr=[]; for(var i=0;i<files.length;i++){ var f=files[i];
     if((f.name||'').toLowerCase()==='summary_report.json') arr.push(f); }
   console.log('[import] readFiles: '+files.length+' file(s), '+arr.length+' named summary_report.json');
   if(!arr.length){ setImportMsg('No summary_report.json found in that drop.', true); return; }
   try{
     setImporting('Reading '+arr.length+' report'+(arr.length>1?'s':'')+'…');
     var runs=[];
     for(var j=0;j<arr.length;j+=READ_CONC){
       var objs=await Promise.all(arr.slice(j,j+READ_CONC).map(readJSON));
       objs.forEach(function(o){ runs=runs.concat(runsFromJson(o)); });
     }
     console.log('[import] parsed '+runs.length+' run(s) from '+arr.length+' file(s)');
     showPreview('file', runs);
   }catch(e){ console.warn('[import] readFiles error', e); setImportMsg('Couldn’t read those files.', true); }
 }
 // Grab the drop's File System Access handles SYNCHRONOUSLY during the event (getAsFileSystemHandle
 // must be called now). Unlike webkitGetAsEntry's entries — which Chrome tears down when the drop
 // event ends, breaking any async subdirectory read — these handles STAY VALID afterward, so we
 // can traverse folders reliably post-event. Returns an array of Promise<FileSystemHandle>, or
 // null when the API isn't available (older/file:// contexts) so the caller falls back.
 function grabHandles(dt){
   var items=dt.items;
   if(!(items && items.length && items[0] && items[0].getAsFileSystemHandle)) return null;
   var ps=[];
   for(var i=0;i<items.length;i++){ var it=items[i]; if(it && it.getAsFileSystemHandle) ps.push(it.getAsFileSystemHandle()); }
   return ps;
 }
 // Fallback: grab the drop's entries (webkitGetAsEntry) synchronously. Only valid during the event
 // and flaky for async subdir reads — used only when the handle API is absent.
 function grabRoots(dt){
   var items=dt.items;
   if(!(items && items.length && items[0] && items[0].webkitGetAsEntry)) return null;
   var roots=[];
   for(var i=0;i<items.length;i++){ var it=items[i]; var en=it&&it.webkitGetAsEntry&&it.webkitGetAsEntry(); if(en) roots.push(en); }
   return roots;
 }
 // Recursively collect summary_report.json File objects from dropped File System Access handles.
 // handle.values() async iteration stays valid after the drop event, so this is the reliable path.
 async function collectReportsFromHandles(handleProms){
   var found=[], dirs=0, files=0, stopped=false;
   var handles=await Promise.all(handleProms);
   async function walk(h){
     if(stopped || !h) return;
     if(h.kind==='file'){
       files++;
       if((h.name||'').toLowerCase()==='summary_report.json'){
         try{ var f=await h.getFile(); if(f) found.push(f); }catch(e){ console.warn('[import] getFile failed for', h.name, e); }
       }
       if(((files+dirs)&2047)===0){ setImporting('Scanning… '+files+' files, '+found.length+' report(s) found');
         if(files+dirs>SCAN_CAP){ stopped=true; console.warn('[import] scan cap '+SCAN_CAP+' hit — stopping'); } }
       return;
     }
     if(h.kind==='directory'){
       dirs++;
       for await (const child of h.values()){ if(stopped) break; await walk(child); }
     }
   }
   for(var i=0;i<handles.length;i++){ if(stopped) break; await walk(handles[i]); }
   console.log('[import] scan complete (FS handles): dirs='+dirs+' files='+files+' reports='+found.length);
   return found;
 }
 // Recursively collect ONLY summary_report.json files from dropped folders, walking SEQUENTIALLY
 // (await each child) so we never fan out a promise/File-handle explosion across a huge artifacts
 // tree — that unbounded parallel recursion was the folder-drop hang. Filters during the walk
 // (non-report handles are never kept), reports progress, and hard-stops at SCAN_CAP entries.
 var SCAN_CAP=300000;
 async function collectReports(roots){
   var found=[], dirs=0, files=0, stopped=false;
   function readEntriesOnce(reader){
     return new Promise(function(res){ reader.readEntries(function(x){ res(x); },
       function(e){ console.warn('[import] readEntries error:', e && (e.name||e.message||String(e))); res([]); }); });
   }
   async function readAll(reader){
     var out=[];
     for(;;){ var ents:any=await readEntriesOnce(reader); if(!ents || !ents.length) break;
       for(var i=0;i<ents.length;i++) out.push(ents[i]); }
     return out;
   }
   async function walk(entry){
     if(stopped || !entry) return;
     if(entry.isFile){
       files++;
       if((entry.name||'').toLowerCase()==='summary_report.json'){
         var f=await new Promise(function(res){ entry.file(function(x){res(x);}, function(){res(null);}); });
         if(f) found.push(f);
       }
       if(((files+dirs)&2047)===0){
         setImporting('Scanning… '+files+' files, '+found.length+' report(s) found');
         if(files+dirs>SCAN_CAP){ stopped=true; console.warn('[import] scan cap '+SCAN_CAP+' hit — stopping'); }
       }
       return;
     }
     if(entry.isDirectory){
       dirs++;
       var kids=await readAll(entry.createReader());
       for(var i=0;i<kids.length;i++){ if(stopped) break; await walk(kids[i]); }
     }
   }
   for(var i=0;i<roots.length;i++){ if(stopped) break; await walk(roots[i]); }
   console.log('[import] scan complete: dirs='+dirs+' files='+files+' reports='+found.length);
   return found;
 }
 // Add a recently-viewed set AND its sibling arms (same test+timestamp), then close.
 async function addFromHistory(id){
   var clicked=null;
   (MODAL_CARDS||[]).forEach(function(c){ if(c.id===id) clicked=c; });
   if(!clicked) return;
   var ids=(MODAL_CARDS||[]).filter(function(c){ return c.test===clicked.test && c.ts===clicked.ts; })
     .map(function(c){ return c.id; });
   if(ids.indexOf(id)<0) ids.push(id);
   var runs=await getRunsFor(ids);
   console.log('[recent] add', ids.length, 'set(s) ->', runs.length, 'run(s)');
   if(addRuns(runs)){ closeModal(); renderView(); }
   else { closeModal(); }   // nothing new (already in the catalog, or no stored runs) — just close
 }
 function closeModal(){
   var m=document.querySelector('[data-rvmodal]'); if(m&&m.parentNode) m.parentNode.removeChild(m);
   STAGED={link:null,file:null}; MODAL_CARDS=[];
 }
 // Open the modal SYNCHRONOUSLY, rendering the recently-viewed list from the in-memory cache
 // (MODAL_CARDS — primed once at page load, refreshed after each import). No IndexedDB here: that
 // was the folder-drop killer — listCards() running concurrently with the entries-API walk
 // released the drag data store and made readEntries throw EncodingError.
 function openModal(){
   if(document.querySelector('[data-rvmodal]')) return;   // already open
   var present=new Set((CATALOG||[]).map(setIdentity));
   var html=''
    +'<div class="rvmodal" data-rvmodal>'
    + '<div class="rvpanel" role="dialog" aria-label="add runsets to comparison">'
    +  '<div class="rvhead"><b>add runsets to comparison</b>'
    +   '<button class="rvclose" data-rvclose aria-label="close">×</button></div>'
    +  '<div class="rvbody">'
    +   '<h4>Import Link</h4>'
    +   '<input class="rvlink" data-rvlink type="text" placeholder="link to another report">'
    +   '<div class="rvprev" data-rvprev="link"></div>'
    +   '<hr class="rvhr">'
    +   '<h4>Import Summary Report JSON</h4>'
    +   '<div class="rvdrop" data-rvdrop><span>Drop a <code>summary_report.json</code>, several, or a whole artifacts folder to import, or </span>'
    +    '<button class="rvbrowse" data-rvbrowse>browse…</button>'
    +    '<input class="rvfileinput" data-rvfile type="file" accept=".json,application/json" multiple hidden></div>'
    +   '<div class="rvprev" data-rvprev="file"></div>'
    +   '<hr class="rvhr">'
    +   '<h4>Recently Viewed</h4>'
    +   '<div class="rvlist" data-rvlist>'+historyModalHTML(sortAndGroupCards(MODAL_CARDS||[]), present)+'</div>'
    +  '</div></div></div>';
   document.body.insertAdjacentHTML('beforeend', html);
   var box=document.querySelector('[data-rvlink]') as any; if(box) box.focus();
 }
 // Refresh the recently-viewed cache from IndexedDB (best-effort), and re-render an open modal's
 // list if present. Called at page load and after imports — NEVER during a folder-drop walk.
 async function refreshRecent(){
   try{ MODAL_CARDS=await listCards(); }catch(e){ return; }
   var el=document.querySelector('[data-rvlist]') as any;
   if(el){ var present=new Set((CATALOG||[]).map(setIdentity));
     el.innerHTML=historyModalHTML(sortAndGroupCards(MODAL_CARDS||[]), present); }
 }

 // Open the modal from the [+] tile (ignored while capped/disabled).
 document.addEventListener('click',function(e:any){
   var op=e.target.closest&&e.target.closest('[data-modal-open]'); if(!op) return;
   e.preventDefault();
   if(op.classList.contains('disabled')) return;
   openModal();
 });
 // Close: the ×, a click on the backdrop (outside .rvpanel), or Esc.
 document.addEventListener('click',function(e:any){
   if(e.target.closest&&e.target.closest('[data-rvclose]')){ e.preventDefault(); closeModal(); return; }
   var m=e.target.closest&&e.target.closest('[data-rvmodal]'); if(!m) return;
   if(!(e.target.closest&&e.target.closest('.rvpanel'))) closeModal();
 });
 document.addEventListener('keydown',function(e:any){
   if(e.key==='Escape' && document.querySelector('[data-rvmodal]')) closeModal();
 });
 // Paste-link section: debounce-parse on every edit/paste.
 document.addEventListener('input',function(e:any){
   var box=e.target.closest&&e.target.closest('[data-rvlink]'); if(!box) return;
   var val=box.value; if(LINKT) clearTimeout(LINKT);
   LINKT=setTimeout(function(){ parseLink(val); }, 250);
 });
 // JSON-import section: browse button, file <input> change, and drag/drop onto the drop zone.
 document.addEventListener('click',function(e:any){
   var b=e.target.closest&&e.target.closest('[data-rvbrowse]'); if(!b) return;
   e.preventDefault();
   var inp=document.querySelector('[data-rvfile]') as any; if(inp) inp.click();
 });
 document.addEventListener('change',function(e:any){
   var inp=e.target.closest&&e.target.closest('[data-rvfile]'); if(!inp) return;
   readFiles(inp.files);
 });
 // Page-wide file drop: dropping a summary_report.json ANYWHERE opens the modal (ignoring the
 // add-tile cap) and runs it through the Import JSON preview, exactly as if it were dropped in
 // that section. dragover must preventDefault for the drop to fire; the .rvdrop zone still lights
 // up while hovered. Guard on a file drag so ordinary (text/internal) drags are untouched.
 function hasFiles(e){ var t=e.dataTransfer&&e.dataTransfer.types;
   return !!(t && (t.indexOf ? t.indexOf('Files')>=0 : (t.contains && t.contains('Files')))); }
 document.addEventListener('dragover',function(e:any){
   if(!hasFiles(e)) return;
   e.preventDefault();
   var d=e.target.closest&&e.target.closest('[data-rvdrop]'); if(d) d.classList.add('over');
 });
 document.addEventListener('dragleave',function(e:any){
   var d=e.target.closest&&e.target.closest('[data-rvdrop]'); if(d) d.classList.remove('over');
 });
 var IMPORTING=false;
 document.addEventListener('drop',function(e:any){
   if(!hasFiles(e)) return;
   e.preventDefault();
   var d=e.target.closest&&e.target.closest('[data-rvdrop]'); if(d) d.classList.remove('over');
   if(IMPORTING){ console.log('[import] drop ignored — an import is already in progress'); return; }
   var dt=e.dataTransfer;
   // Grab handles/entries SYNCHRONOUSLY (must happen during the event). Prefer File System Access
   // handles (survive the event -> reliable folder traversal); else fall back to the entries API;
   // else plain dataTransfer.files (single/multi file drops — the same list browse uses).
   var handleProms=grabHandles(dt);
   var roots=handleProms ? null : grabRoots(dt);
   var dirRoots=roots?roots.filter(function(r){return r&&r.isDirectory;}):[];
   var flat=(handleProms||dirRoots.length) ? null : Array.prototype.slice.call(dt.files||[]);
   console.log('[import] drop: handles='+(handleProms?handleProms.length:'n/a')+' roots='+(roots?roots.length:'n/a')+' dirs='+dirRoots.length+' flat='+(flat?flat.length:'n/a'));
   IMPORTING=true;
   // openModal is fully synchronous (renders from the in-memory cache — no IndexedDB), so the walk
   // that follows runs with nothing else touching the event loop.
   openModal();
   setImporting('Reading dropped files…');
   var filesP=handleProms ? collectReportsFromHandles(handleProms)
            : dirRoots.length ? collectReports(roots)
            : Promise.resolve(flat);
   filesP.then(function(files){ return readFiles(files); })
     .catch(function(err){ console.warn('[import] drop failed', err); setImportMsg('Couldn’t read the drop — see console.', true); })
     .then(function(){ IMPORTING=false; });
 });
 // Confirm an import (link or JSON) -> merge staged runs, close, re-render.
 document.addEventListener('click',function(e:any){
   var c=e.target.closest&&e.target.closest('[data-rvconfirm]'); if(!c) return;
   e.preventDefault();
   var kind=c.getAttribute('data-rvconfirm'), fresh=STAGED[kind];
   if(fresh && fresh.length && addRuns(fresh)){ closeModal(); renderView(); }
 });
 // Cancel an import -> clear that section's staged runs, preview, and input.
 document.addEventListener('click',function(e:any){
   var c=e.target.closest&&e.target.closest('[data-rvcancel]'); if(!c) return;
   e.preventDefault();
   var kind=c.getAttribute('data-rvcancel'); STAGED[kind]=null;
   var el=document.querySelector('[data-rvprev="'+kind+'"]') as any; if(el){ el.className='rvprev'; el.textContent=''; }
   if(kind==='link'){ var box=document.querySelector('[data-rvlink]') as any; if(box) box.value=''; }
   if(kind==='file'){ var f=document.querySelector('[data-rvfile]') as any; if(f) f.value=''; }
 });
 // Recently-viewed row (a "+" row) -> add it (and sibling arms) immediately, then close.
 document.addEventListener('click',function(e:any){
   var row=e.target.closest&&e.target.closest('[data-rvadd]'); if(!row) return;
   e.preventDefault();
   addFromHistory(decodeURIComponent(row.getAttribute('data-rvadd')));
 });

 function renderReport(arms){
   window.__ARMS__=arms;                     // keep for copy-link round-trip
   var ctx=analyze(arms);
   document.title=(ctx.dual?ctx.control_label+' vs '+ctx.experiment_label:ctx.control_label)+' — online restore';
   document.body.className='hide-p95';
   document.body.innerHTML=render_body(ctx);
   // CRDB node count (from the test name, e.g. ".../nodes=5/...") so the download chart can
   // show per-node MB/s. analyze() already derives it onto ctx.nodes. null -> unknown ->
   // show cluster-total MB/s.
   runChart({chartData:ctx.chartData, labels:ctx.labels, dual:ctx.dual, xmaxEl:ctx.xmax_el, ctx:ctx, nodes:ctx.nodes, ctrl0:CTRL, persistCtrl:persistCtrl});
   initSticky();   // measure the sticky-header offset + set the graph's stuck state for this render
 }

 // Read one JSON file (a summary_report.json or a {runs}/array payload) — used by the modal's
 // "import summary report JSON" drop/browse. Files self-identify via metadata, so imported runs
 // group themselves into sets (by test + timestamp + arm), exactly like the URL/paste path.
 function readJSON(file){
   return file.text().then(function(txt){ try{ return JSON.parse(txt); }
     catch(e){ console.warn('[import] bad JSON in', file && file.name, e && e.message); return null; } });
 }
 // Empty state (no injected data / no slug): show just the ribbon (its lone [+] tile) and pop
 // the add-runsets modal open so the first action is right there. Any shared-load error surfaces
 // above the ribbon.
 function renderEmpty(){
   CATALOG=[]; SEL=[null,null]; REF=null;
   document.body.className='';
   document.body.innerHTML="<div class='report'><p class='armempty'>"
     +(LOADERR?esc(LOADERR):'No run set loaded — add one to get started.')+"</p></div>";
   LOADERR=null;
   var host=document.querySelector('.report');
   host.insertAdjacentHTML('afterbegin', armBarHTML());
   initSticky();
   openModal();
 }

 // A placeholder shown while a shared report's data is fetched from the link store, so
 // the recipient sees progress instead of a blank page during the Apps Script read.
 function showLoading(msg){
   document.body.className='';
   document.body.innerHTML="<div class='picker'><h1>online restore perf breakdown</h1>"
     +"<p>"+esc(msg)+"</p></div>";
 }
 async function resolveAndRender(){
   refreshRecent();   // prime the recently-viewed cache once at load (fills any modal we auto-open)
   // Priority: (1) injected window.__ARMS__ -> (2) URL hash -> (3) file picker. The payload
   // is a bare run array (launcher / roachtest / test), {runs, sel, ctrl} once the report has
   // round-tripped it (sel = the persisted [slotA, slotB] selection), or a {ref, sel, ctrl}
   // share slug whose runs live in the link store.
   var raw=null;
   if(window.__ARMS__) raw=window.__ARMS__;
   else if(location.hash && location.hash.length>1){
     try{ raw=await decodePayload(location.hash.slice(1)); }
     catch(e){ /* bad/partial payload -> fall through to picker */ }
   }
   var norm = normalizePayload(raw), runs=null, sel=null, ctrl=null;
   if(norm){
     sel=norm.sel; ctrl=norm.ctrl;
     if(norm.ref){
       // A shared link carries only {ref,sel,ctrl}: fetch the runs by id. REF is remembered
       // so later control tweaks re-persist as a short ref, not re-inlined runs.
       showLoading('Looking up report…');
       try{ runs=await fetchCatalog(norm.ref); REF=norm.ref; }
       catch(e){ console.error('could not load shared report',norm.ref,e);
         LOADERR='Could not load shared report “'+norm.ref+'” — it may have been deleted, or the network is unavailable.'; }
     } else { runs=norm.runs; }
   }
   if(runs && runs.length){
     CATALOG=runsToSets(runs);
     var n=CATALOG.length;
     if(Array.isArray(sel) && sel.length===2){
       // Restore a persisted selection (drop any now-out-of-range slot).
       SEL=sel.map(function(x){ return (x==null||x<0||x>=n)?null:x; });
     } else {
       // Fresh payload: exactly two sets default to the comparison; more default to first solo.
       SEL = n===2 ? [0,1] : [0,null];
     }
     // Restore persisted control state (p99 off, plot=all, ...) before the chart renders.
     if(ctrl && typeof ctrl==='object'){ CTRL=ctrl; }
     recordSets(CATALOG).then(refreshRecent);   // remember every set that just loaded; prime cache
     renderView();
     return;
   }
   renderEmpty();
 }
 // Normalize a decoded payload to {runs} | {ref} (+ sel/ctrl). Bare array = runs.
 function normalizePayload(raw){
   if(!raw) return null;
   if(Array.isArray(raw)) return {runs:raw};
   if(Array.isArray(raw.runs)) return {runs:raw.runs, sel:raw.sel, ctrl:raw.ctrl};
   if(raw.ref) return {ref:raw.ref, sel:raw.sel, ctrl:raw.ctrl};
   return null;
 }

 if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',resolveAndRender);
 else resolveAndRender();
})();

export {};
