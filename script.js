// Sun Finder v5.5.3 — dedupe/land-snap + activities dropdown + rate-limited weather
let map, spotsLayer, userMarker;
const resultsEl = document.getElementById('results');
const statusEl = document.getElementById('status');
const top3El = document.getElementById('top3');
const btn = document.getElementById('go');
const ob = document.getElementById('onboard');
document.getElementById('help').addEventListener('click',()=> ob.classList.add('show'));
document.getElementById('closeOb').addEventListener('click',()=> ob.classList.remove('show'));
window.addEventListener('keydown',(e)=>{ if(e.key==='Escape') ob.classList.remove('show'); });

const MI_TO_KM = 1.609344, KM_TO_MI = 0.621371;
const WATER_RE = /(sea|ocean|bay|firth|channel|loch|estuary|gulf|sound|lake|harbour|harbor|marina)/i;

function fmt(n){ return Math.round(n); }
function toRad(d){ return d*Math.PI/180; } function toDeg(r){ return r*180/Math.PI; }
function bearingDeg(a,b){ const lat1=toRad(a.lat), lat2=toRad(b.lat), dLon=toRad(b.lon-a.lon);
  const y=Math.sin(dLon)*Math.cos(lat2); const x=Math.cos(lat1)*Math.sin(lat2)-Math.sin(lat1)*Math.cos(lat2)*Math.cos(dLon);
  return (toDeg(Math.atan2(y,x))+360)%360; }
function bearingToCardinal(b){ const dirs=["N","NNE","NE","ENE","E","ESE","SE","S","SSW","SW","WSW","W","WNW","NW","NNW"]; return dirs[Math.round(b/22.5)%16]; }
function havKm(a,b){ const R=6371.0088; const dLat=toRad(b.lat-a.lat), dLon=toRad(b.lon-a.lon); const lat1=toRad(a.lat), lat2=toRad(b.lat);
  const h=Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2; return 2*R*Math.asin(Math.sqrt(h)); }

function initMap(){
  map = L.map('map', { zoomControl:true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution:'&copy; OpenStreetMap' }).addTo(map);
  spotsLayer = L.layerGroup().addTo(map);
  map.setView([55.9533, -3.1883], 9); // default Edinburgh
}
window.addEventListener('load', initMap);

function setLoading(on){ if(on){ btn.classList.add('loading'); btn.disabled=true; } else { btn.classList.remove('loading'); btn.disabled=false; } }

// =========== Weather queue (rate-limited) ===========
const weatherCache = new Map();
let active = 0; const queue = [];
function keyCell(lat,lon){ return (lat.toFixed(2)+","+lon.toFixed(2)); } // ~2km cell
function schedule(task){ return new Promise((resolve)=>{ queue.push({task,resolve}); pump(); }); }
function pump(){ while(active<3 && queue.length){ const {task,resolve}=queue.shift(); active++; task().then(resolve).finally(()=>{ active--; pump(); }); } }
async function withRetry(fn, tries=3, delay=400){
  try{ return await fn(); }catch(e){ if(tries<=1) throw e; await new Promise(r=>setTimeout(r, delay)); return withRetry(fn, tries-1, delay*1.6); }
}
async function fetchNowAndHourly(lat, lon){
  const cell = keyCell(lat,lon);
  if(weatherCache.has(cell)) return weatherCache.get(cell);
  const run = async ()=>{
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", lat.toFixed(3));
    url.searchParams.set("longitude", lon.toFixed(3));
    url.searchParams.set("current", "temperature_2m,precipitation,cloud_cover,shortwave_radiation,is_day");
    url.searchParams.set("hourly", "cloud_cover,shortwave_radiation,precipitation,temperature_2m");
    url.searchParams.set("forecast_days", "1"); url.searchParams.set("timezone", "auto");
    const res = await fetch(url.toString());
    if(res.status===429) throw new Error("429");
    if(!res.ok) throw new Error("weather "+res.status);
    const data = await res.json();
    const nowISO = data.current.time;
    const idx = data.hourly.time.indexOf(nowISO);
    const from = (idx>=0)? idx+1 : 0;
    const next = {
      time: data.hourly.time.slice(from, from+12),
      cloud: data.hourly.cloud_cover.slice(from, from+12),
      sw: data.hourly.shortwave_radiation.slice(from, from+12),
      pr: data.hourly.precipitation.slice(from, from+12),
      temp: data.hourly.temperature_2m.slice(from, from+12)
    };
    const out = { current:data.current, next };
    weatherCache.set(cell, out);
    return out;
  };
  const data = await schedule(()=> withRetry(run));
  return data;
}
function isSunnyLike(cc, sw, pr){ return (cc<=45)&&(pr<0.2)&&(sw>=70); } // slightly relaxed
function sunshineWindow(next){
  let minutes=0, until=null;
  for(let i=0;i<next.time.length;i++){
    const ok = isSunnyLike(next.cloud[i], next.sw[i], next.pr[i]);
    if(ok){ minutes += 60; until = next.time[i]; } else { if(minutes>0) break; }
  }
  return { minutes, until };
}

// =========== Wikidata + Overpass interest candidates ===========
const WD = { beach:"Q40080", nature_reserve:"Q473972", lake:"Q23397", theme_park:"Q134342", historic:"Q23413", scenic_view:"Q207694", park:"Q22698", zoo:"Q43501" };

async function fetchWikidataPOIs(origin, radiusKm, category){
  const qid = WD[category]; if(!qid) return [];
  const center = `Point(${origin.lon} ${origin.lat})`;
  const query = `
    SELECT ?item ?itemLabel ?coord WHERE {
      SERVICE wikibase:around {
        ?item wdt:P625 ?coord .
        bd:serviceParam wikibase:center "${center}"^^geo:wktLiteral ;
                         wikibase:radius "${radiusKm.toFixed(1)}" .
      }
      ?item wdt:P31 wd:${qid} .
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    } LIMIT 80
  `;
  try{
    const r = await fetch("https://query.wikidata.org/sparql?format=json", {
      method:"POST",
      headers: { "Content-Type":"application/sparql-query", "Accept":"application/sparql-results+json" },
      body: query
    });
    if(!r.ok) throw new Error("wikidata "+r.status);
    const d = await r.json();
    const out = [];
    (d.results.bindings||[]).forEach(row=>{
      const wkt = row.coord.value;
      const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(wkt);
      if(!m) return;
      const lon = parseFloat(m[1]), lat = parseFloat(m[2]);
      out.push({ lat, lon, title: row.itemLabel?.value || "Place" });
    });
    return out;
  }catch(e){
    console.warn("Wikidata failed:", e.message||e); return [];
  }
}
function overpassFilter(interest){
  switch(interest){
    case "beach": return '(nwr["natural"="beach"];nwr["leisure"="beach_resort"];);';
    case "nature_reserve": return '(nwr["leisure"="nature_reserve"];nwr["boundary"="protected_area"];);';
    case "lake": return '(nwr["natural"="water"]["water"~"lake|reservoir|loch"];);';
    case "theme_park": return '(nwr["leisure"="theme_park"];);';
    case "historic": return '(nwr["historic"];);';
    case "scenic_view": return '(nwr["tourism"="viewpoint"];);';
    case "park": return '(nwr["leisure"~"park|playground"];);';
    case "zoo": return '(nwr["tourism"="zoo"];nwr["amenity"="aquarium"];);';
    default: return '';
  }
}
function bboxFrom(origin, radiusMi){
  const latDelta=(radiusMi*MI_TO_KM)/111; const lonDelta=latDelta/Math.cos(origin.lat*Math.PI/180);
  const s=n=>n.toFixed(5); return [s(origin.lat-latDelta), s(origin.lon-lonDelta), s(origin.lat+latDelta), s(origin.lon+lonDelta)];
}
async function fetchPOIsOverpass(origin, radiusMi, interest){
  const flt = overpassFilter(interest); if(!flt) return [];
  const [s,w,n,e]=bboxFrom(origin, radiusMi);
  const q = "[out:json][timeout:12];(" + flt + ")(" + s + "," + w + "," + n + "," + e + ");out center;";
  try{
    const r = await fetch("https://overpass-api.de/api/interpreter", {
      method:"POST", headers:{ "Content-Type":"application/x-www-form-urlencoded" }, body:"data="+encodeURIComponent(q)
    });
    if(!r.ok) throw new Error("overpass "+r.status);
    const d = await r.json(); const out=[];
    (d.elements||[]).forEach(e=>{ const lat=e.lat||e.center?.lat, lon=e.lon||e.center?.lon; if(lat && lon) out.push({lat,lon,title:e.tags?.name||null}); });
    return out;
  }catch(e){ console.warn("Overpass failed:", e.message||e); return []; }
}

// =========== Settlement name + land snap ===========
const nameCache = new Map();
async function settlementInfo(lat, lon){
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if(nameCache.has(key)) return nameCache.get(key);
  async function rev(zoom){
    const u = new URL("https://nominatim.openstreetmap.org/reverse");
    u.searchParams.set("lat", lat); u.searchParams.set("lon", lon);
    u.searchParams.set("format","jsonv2"); u.searchParams.set("zoom", String(zoom)); u.searchParams.set("addressdetails","1");
    const r = await fetch(u.toString(), { headers:{ "Accept":"application/json" } });
    if(!r.ok) return null; return r.json();
  }
  const zList=[14,12,10,8];
  let data=null;
  for(const z of zList){ try{ data = await rev(z); if(data) break; }catch{}
  }
  if(!data){ nameCache.set(key,null); return null; }

  const ad = data.address || {};
  const place = ad.city || ad.town || ad.village || ad.hamlet || ad.suburb || ad.neighbourhood || null;
  if(!place || WATER_RE.test(place)) { nameCache.set(key,null); return null; }

  // snap marker to settlement centre if available via a bounded search
  let dispLat = Number(data.lat), dispLon = Number(data.lon);
  try{
    const bbox = [lon-0.25, lat-0.2, lon+0.25, lat+0.2]; // lon,lat,lon,lat
    const search = new URL("https://nominatim.openstreetmap.org/search");
    search.searchParams.set("q", place);
    search.searchParams.set("format","jsonv2");
    search.searchParams.set("addressdetails","0");
    search.searchParams.set("limit","1");
    search.searchParams.set("bounded","1");
    search.searchParams.set("viewbox", `${bbox[0]},${bbox[3]},${bbox[2]},${bbox[1]}`);
    const sr = await fetch(search.toString(), { headers:{ "Accept":"application/json" } });
    if(sr.ok){ const arr = await sr.json(); if(arr?.[0]){ dispLat = Number(arr[0].lat); dispLon = Number(arr[0].lon); } }
  }catch{}

  const info = { place, lat: dispLat, lon: dispLon };
  nameCache.set(key, info);
  return info;
}

function normName(s){ return (s||"").toLowerCase().replace(/^city of\s+/,'').replace(/\s*,?\s*(scotland|england|wales|northern ireland|uk|united kingdom)$/,'').trim(); }

// =========== Activities (lazy) ===========
const interestKeywords = {
  beach:['beach','bay','coast','sand'],
  nature_reserve:['nature reserve','country park','forest','trail','nature'],
  lake:['lake','loch','reservoir','water'],
  theme_park:['theme park','amusement park','rides'],
  historic:['castle','abbey','cathedral','monument','ruins'],
  scenic_view:['viewpoint','scenic','lookout'],
  park:['park','playground','greenspace'],
  zoo:['zoo','aquarium','wildlife park']
};
async function fetchWikipediaActivities(lat, lon, interest){
  const terms = interestKeywords[interest] || [];
  const url = `https://en.wikipedia.org/w/api.php?origin=*&action=query&list=geosearch&gsradius=10000&gslimit=40&format=json&gscoord=${lat}%7C${lon}`;
  try{
    const r = await fetch(url); if(!r.ok) return [];
    const d = await r.json(); const titles = (d?.query?.geosearch||[]).map(x=> x.title).filter(Boolean);
    const hits = terms.length ? titles.filter(t=> terms.some(term=> t.toLowerCase().includes(term))) : titles;
    return hits.slice(0,5);
  }catch{ return []; }
}

// =========== Main search ===========
document.getElementById('go').addEventListener('click', runSearch);

async function runSearch(){
  setLoading(true); resultsEl.innerHTML=""; top3El.innerHTML="";
  try{
    statusEl.textContent="Getting your location…";
    const pos = await new Promise((res,rej)=> navigator.geolocation.getCurrentPosition(res,rej,{enableHighAccuracy:true,timeout:12000}));
    const origin = { lat:pos.coords.latitude, lon:pos.coords.longitude };
    const radiusMi = Number(document.getElementById('radiusMi').value)||50;
    const limit = Number(document.getElementById('limit').value)||10;
    const interest = document.getElementById('interest').value||'any';

    const list = await getSpots(origin, radiusMi, limit, interest);
    if(!list.length) statusEl.textContent="No perfect sun now — showing best weather.";
    else statusEl.textContent = interest==='any' ? `Best weather within ${radiusMi} miles.` : `Best ${interest.replace('_',' ')} options within ${radiusMi} miles.`;
    render(list, origin, interest);
    updateSEO(list, origin, interest);
  }catch(e){
    console.error(e); statusEl.textContent="Search failed. Please allow location and try again.";
  }finally{
    setLoading(false);
  }
}

async function getSpots(origin, radiusMi, limit, interest){
  let cands=[];
  if(interest!=='any'){
    // Wikidata → Overpass → grid
    const wd = await fetchWikidataPOIs(origin, radiusMi*MI_TO_KM, interest);
    if(wd.length) cands = wd;
    else{
      const op = await fetchPOIsOverpass(origin, radiusMi, interest);
      if(op.length) cands = op;
      else cands = makeGrid(origin, radiusMi);
    }
  }else{
    cands = makeGrid(origin, radiusMi);
  }

  // Map to settlement + dedupe + cluster
  const named = [];
  const seen = new Set();
  for(const p of cands){
    const info = await settlementInfo(p.lat, p.lon);
    if(!info) continue; // skip water / non-settlements
    const key = normName(info.place);
    if(seen.has(key)) continue; // name dedupe
    // cluster within 1 km: if an existing named item within 1 km with same name, skip
    const near = named.find(x=> normName(x.place)===key && havKm({lat:x.lat,lon:x.lon},{lat:info.lat,lon:info.lon})<1.0);
    if(near) continue;
    named.push({ place: info.place, lat: info.lat, lon: info.lon });
    if(named.length > limit*3) break;
  }
  if(!named.length) return [];

  // Weather (rate-limited)
  const results=[];
  for(const p of named){
    try{
      const data = await fetchNowAndHourly(p.lat, p.lon);
      const win = sunshineWindow(data.next);
      const isSunny = (data.current.cloud_cover<=35 && data.current.precipitation<0.15 && data.current.shortwave_radiation>=85);
      const distMi = havKm(origin, p)*KM_TO_MI;
      const brg = bearingDeg(origin, p);
      results.push({ ...p, current:data.current, isSunny, sunnyMinutes:win.minutes, sunnyUntil:win.until, distMi, bearing:brg });
    }catch(e){ /* skip failed point */ }
    if(results.length >= limit*2) break;
  }

  // Sort by longest sun → nearest → name
  results.sort((a,b)=> (b.sunnyMinutes-a.sunnyMinutes) || (a.distMi-b.distMi) || (a.place.localeCompare(b.place)));
  return results.slice(0, limit);
}

// Grid fallback
function makeGrid(origin, radiusMi){
  const radiusKm = radiusMi*MI_TO_KM; const pts=[]; const seen=new Set();
  const stepKm=Math.max(12, Math.min(16, radiusKm/3));
  const rings=[]; for(let d=12; d<=radiusKm; d+=stepKm) rings.push(d);
  const bearings = Array.from({length:12},(_,i)=> i*30);
  for(const d of rings){ for(const b of bearings){
    const p=offsetPoint(origin.lat, origin.lon, b, d);
    const key=`${p.lat.toFixed(2)},${p.lon.toFixed(2)}`; if(seen.has(key)) continue; seen.add(key); pts.push(p);
  } }
  return pts.slice(0,36);
}
function offsetPoint(lat, lon, bDeg, distKm){ const R=6371.0088,b=toRad(bDeg),dR=distKm/R;
  const lat1=toRad(lat),lon1=toRad(lon);
  const lat2=Math.asin(Math.sin(lat1)*Math.cos(dR)+Math.cos(lat1)*Math.sin(dR)*Math.cos(b));
  const lon2=lon1+Math.atan2(Math.sin(b)*Math.sin(dR)*Math.cos(lat1),Math.cos(dR)-Math.sin(lat1)*Math.cos(lat2));
  return {lat:toDeg(lat2),lon:((toDeg(lon2)+540)%360)-180}; }

// Render
function render(list, origin, interest){
  resultsEl.innerHTML=""; top3El.innerHTML=""; spotsLayer.clearLayers();
  if(!userMarker){ userMarker=L.marker([origin.lat,origin.lon]).addTo(spotsLayer); } else userMarker.setLatLng([origin.lat,origin.lon]);
  const group=[userMarker];

  const top = list.slice(0,3);
  top.forEach((r, idx)=>{
    const mins=r.sunnyMinutes, until=r.sunnyUntil? new Date(r.sunnyUntil).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '—';
    const card = document.createElement('div'); card.className='topCard';
    card.innerHTML = `<h4>${idx+1}. ${r.place}</h4>
      <div class="row">
        <span class="pill ${r.isSunny?'ok':'warn'}">${r.isSunny?'Sunny now':'Sun may vary'}</span>
        <span class="pill">Sunny for ${Math.floor(mins/60)}h ${mins%60? (mins%60+'m'):''} ${until!=='—'?`(until ${until})`:''}</span>
        <span class="pill">${fmt(r.distMi)} mi ${bearingToCardinal(r.bearing)}</span>
      </div>`;
    top3El.appendChild(card);
  });

  list.forEach((r, idx)=>{
    const mins=r.sunnyMinutes, until=r.sunnyUntil? new Date(r.sunnyUntil).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '—';
    const card = document.createElement('div'); card.className='card';
    const catBadge = interest!=='any' ? `<span class="pill ok">✓ ${interest.replace('_',' ')}</span>` : '';
    const todoId = `todo-${idx}`;
    card.innerHTML = `<h3>${idx+1}. ${r.place}</h3>
      <div class="row">
        ${catBadge}
        <span class="pill ${r.isSunny?'ok':'warn'}">${r.isSunny?'Sunny now':'Sun may vary'}</span>
        <span class="pill">Temp ${fmt(r.current.temperature_2m)}°C</span>
        <span class="pill">Sunny for ${Math.floor(mins/60)}h ${mins%60? (mins%60+'m'):''} ${until!=='—'?`(until ${until})`:''}</span>
        <span class="pill">${fmt(r.distMi)} mi ${bearingToCardinal(r.bearing)}</span>
        <a class="pill" href="https://maps.google.com/?q=${r.lat},${r.lon}" target="_blank" rel="noopener">Open in Maps</a>
      </div>
      <div class="toggler">
        <button class="toggleBtn" data-lat="${r.lat}" data-lon="${r.lon}" data-interest="${interest}" data-target="${todoId}">Things to do ▾</button>
        <div id="${todoId}" class="todo"><em>Loading…</em></div>
      </div>`;
    resultsEl.appendChild(card);

    const m=L.circleMarker([r.lat,r.lon],{radius:7,weight:2,color:r.isSunny?'#22c55e':'#f59e0b'})
      .bindPopup(`<b>${idx+1}. ${r.place}</b><br>Sunny for ${Math.floor(mins/60)}h ${mins%60? (mins%60+'m'):''}${until!=='—'?` (until ${until})`:''}`)
      .addTo(spotsLayer);
    group.push(m);
  });
  if(list.length){ const b=L.featureGroup(group).getBounds().pad(0.2); map.fitBounds(b); }

  // attach lazy loaders
  resultsEl.querySelectorAll('.toggleBtn').forEach(btn=>{
    btn.addEventListener('click', async (e)=>{
      const lat = Number(btn.dataset.lat), lon=Number(btn.dataset.lon), interest=btn.dataset.interest;
      const tgt = document.getElementById(btn.dataset.target);
      if(!tgt) return;
      if(!tgt.dataset.loaded){
        const items = await fetchWikipediaActivities(lat, lon, interest==='any'? null : interest);
        const mapsLink = `https://www.google.com/maps/search/Attractions/@${lat},${lon},13z`;
        const taLink = `https://www.tripadvisor.com/Search?q=${encodeURIComponent((items[0]||'Things to do')+' '+(document.title.replace('Sun Finder','')))}&geo=1`;
        if(items.length){
          tgt.innerHTML = `<ul>${items.map(t=> `<li>${t}</li>`).join('')}</ul>
            <div class="row" style="margin-top:6px">
              <a href="${mapsLink}" target="_blank" rel="noopener">Open in Google Maps</a>
            </div>`;
        }else{
          tgt.innerHTML = `<div class="row"><a href="${mapsLink}" target="_blank" rel="noopener">Open Google Maps “Attractions”</a></div>`;
        }
        tgt.dataset.loaded="1";
      }
      tgt.classList.toggle('show');
      btn.textContent = tgt.classList.contains('show') ? 'Things to do ▴' : 'Things to do ▾';
    });
  });
}

// SEO update
function updateSEO(list, origin, interest){
  const interestLabel = interest==='any' ? 'Places' : interest.replace('_',' ');
  document.title = `Sun Finder — Sunniest ${interestLabel} near you`;
  const desc = list.length ?
    `Top right now: ${list.slice(0,3).map(x=>x.place).join(', ')}. See sunshine duration and temperature.` :
    `Find the sunniest places near you right now. See sunshine duration and temperature.`;
  let meta = document.querySelector('meta[name="description"]');
  if(!meta){ meta = document.createElement('meta'); meta.setAttribute('name','description'); document.head.appendChild(meta); }
  meta.setAttribute('content', desc);
  const schema = {"@context":"https://schema.org","@type":"ItemList","itemListElement":list.map((r,i)=>({"@type":"ListItem","position":i+1,"item":{"@type":"Place","name":r.place,"geo":{"@type":"GeoCoordinates","latitude":r.lat,"longitude":r.lon}}}))};
  let ld=document.getElementById('ld-json'); if(!ld){ ld=document.createElement('script'); ld.id='ld-json'; ld.type='application/ld+json'; document.head.appendChild(ld); }
  ld.textContent = JSON.stringify(schema);
}
