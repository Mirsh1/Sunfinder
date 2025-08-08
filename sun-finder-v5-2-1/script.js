// Sun Finder v5.2.1 — robust Overpass + fallback, DOM-safe bindings, pure static
let map, spotsLayer, userMarker;
let domReady = false;
document.addEventListener('DOMContentLoaded', () => { domReady = true; init(); });

function init(){
  initMap();
  bindUI();
}

function bindUI(){
  document.getElementById('go').addEventListener('click', runSearch);
  const ob = document.getElementById('onboard');
  document.getElementById('help').addEventListener('click',()=> ob.classList.add('active'));
  document.getElementById('closeOb').addEventListener('click',()=> ob.classList.remove('active'));
  window.addEventListener('keydown',(e)=>{ if(e.key==='Escape') ob.classList.remove('active'); });
}

const resultsEl = document.getElementById('results');
const statusEl = document.getElementById('status');
const skEl = document.getElementById('skeletons');

const MI_TO_KM = 1.609344, KM_TO_MI = 0.621371;
function dbg(){ return document.getElementById('debugToggle')?.checked; }
function log(...a){ if(dbg()) console.log("[SF]", ...a); }

function initMap(){
  map = L.map('map', { zoomControl:true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution:'&copy; OpenStreetMap' }).addTo(map);
  spotsLayer = L.layerGroup().addTo(map);
  map.setView([55.9533, -3.1883], 9);
}

function deg2rad(d){return d*Math.PI/180} function rad2deg(r){return r*180/Math.PI}
function offsetPoint(lat, lon, bDeg, distKm){ const R=6371.0088,b=deg2rad(bDeg),dR=distKm/R;
  const lat1=deg2rad(lat),lon1=deg2rad(lon);
  const lat2=Math.asin(Math.sin(lat1)*Math.cos(dR)+Math.cos(lat1)*Math.sin(dR)*Math.cos(b));
  const lon2=lon1+Math.atan2(Math.sin(b)*Math.sin(dR)*Math.cos(lat1),Math.cos(dR)-Math.sin(lat1)*Math.sin(dR));
  return {lat:rad2deg(lat2),lon:((rad2deg(lon2)+540)%360)-180}; }
function haversineKm(a,b){ const R=6371.0088; const dLat=deg2rad(b.lat-a.lat), dLon=deg2rad(b.lon-a.lon);
  const lat1=deg2rad(a.lat), lat2=deg2rad(b.lat);
  const h=Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(h)); }
function bearingDeg(a,b){ const lat1=deg2rad(a.lat), lat2=deg2rad(b.lat), dLon=deg2rad(b.lon-a.lon);
  const y=Math.sin(dLon)*Math.cos(lat2); const x=Math.cos(lat1)*Math.sin(lat2)-Math.sin(lat1)*Math.cos(lat2)*Math.cos(dLon);
  return (rad2deg(Math.atan2(y,x))+360)%360; }
function bearingToCardinal(b){ const dirs=["N","NNE","NE","ENE","E","ESE","SE","S","SSW","SW","WSW","W","WNW","NW","NNW"]; return dirs[Math.round(b/22.5)%16]; }

function isSunnyLike(cc, sw, pr){ return (cc<=40)&&(pr<0.2)&&(sw>=80); }
function scorePoint(current){
  const sw=current.shortwave_radiation??0, cc=current.cloud_cover??100, precip=current.precipitation??0;
  const isSunny=(cc<=30)&&(precip<0.1)&&(sw>=100);
  let base=sw-1.4*cc-180*precip; if(isSunny) base+=100;
  return { score:base, isSunny };
}

async function fetchNowAndHourly(lat, lon, signal){
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", lat.toFixed(3));
  url.searchParams.set("longitude", lon.toFixed(3));
  url.searchParams.set("current", "temperature_2m,weather_code,precipitation,cloud_cover,shortwave_radiation,is_day");
  url.searchParams.set("hourly", "cloud_cover,shortwave_radiation,precipitation,temperature_2m");
  url.searchParams.set("forecast_days", "1");
  url.searchParams.set("timezone", "auto");
  const res = await fetch(url.toString(), { signal });
  if(!res.ok) throw new Error("weather "+res.status);
  const data = await res.json();
  const nowISO = data.current.time;
  const idx = data.hourly.time.indexOf(nowISO);
  const from = (idx>=0)? idx+1 : 0;
  const next6 = {
    time: data.hourly.time.slice(from, from+6),
    cloud: data.hourly.cloud_cover.slice(from, from+6),
    sw: data.hourly.shortwave_radiation.slice(from, from+6),
    pr: data.hourly.precipitation.slice(from, from+6),
    temp: data.hourly.temperature_2m.slice(from, from+6)
  };
  return { current: data.current, next6 };
}
function estimateSunnyDuration(next6){ let m=0; for(let i=0;i<next6.time.length;i++){ if(isSunnyLike(next6.cloud[i], next6.sw[i], next6.pr[i])) m+=60; else break; } return m; }

// -------- Overpass robust fetch (with timeout + fallback) --------
function overpassFilter(interest){
  switch(interest){
    case "beach": return '(nwr["natural"="beach"];);';
    case "theme_park": return '(nwr["leisure"="theme_park"];);';
    case "nature_reserve": return '(nwr["leisure"="nature_reserve"];nwr["boundary"="protected_area"];);';
    case "lake": return '(nwr["natural"="water"]["water"~"lake|reservoir"];);';
    case "historic": return '(nwr["historic"];nwr["heritage"];);';
    case "scenic": return '(nwr["tourism"="viewpoint"];);';
    case "park": return '(nwr["leisure"~"park|playground"];);';
    case "zoo": return '(nwr["amenity"="aquarium"];nwr["tourism"="zoo"];);';
    default: return '';
  }
}
function bboxFrom(origin, radiusMi){
  const latDelta = (radiusMi*MI_TO_KM)/111.0;
  const lonDelta = latDelta/Math.cos(origin.lat*Math.PI/180);
  const s = (n)=> n.toFixed(5);
  return [s(origin.lat-latDelta), s(origin.lon-lonDelta), s(origin.lat+latDelta), s(origin.lon+lonDelta)];
}
async function fetchPOIsOverpass(origin, radiusMi, interest){
  const flt = overpassFilter(interest);
  if(!flt) return [];
  const [s,w,n,e] = bboxFrom(origin, radiusMi);
  const q = "[out:json][timeout:12];(" + flt + ")(" + s + "," + w + "," + n + "," + e + ");out center;";
  const ctrl = new AbortController();
  const to = setTimeout(()=> ctrl.abort("timeout"), 6000);
  try{
    const r = await fetch("https://overpass-api.de/api/interpreter", {
      method:"POST",
      headers:{ "Content-Type":"application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(q),
      signal: ctrl.signal
    });
    if(!r.ok) throw new Error("overpass "+r.status);
    const d = await r.json();
    const out=[];
    (d.elements||[]).forEach(e=>{
      const lat = e.lat || e.center?.lat;
      const lon = e.lon || e.center?.lon;
      if(lat && lon) out.push({ lat, lon, name: e.tags?.name || null });
    });
    return out;
  }catch(e){
    console.warn("Overpass failed:", e && e.message ? e.message : e);
    return [];
  }finally{
    clearTimeout(to);
  }
}

// -------- Settlement naming with Nominatim + dedupe --------
const WATER_RE = /(sea|ocean|bay|firth|channel|loch|estuary|gulf|sound|lake)/i;
const nameCache = new Map();
const sleep = (ms)=> new Promise(r=> setTimeout(r, ms));
function norm(s){ return (s||"").toLowerCase().replace(/^city of\s+/,'').replace(/\s*,?\s*scotland$/,'').trim(); }

async function nominatimName(lat, lon){
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if(nameCache.has(key)) return nameCache.get(key);
  await sleep(120);
  const u = new URL("https://nominatim.openstreetmap.org/reverse");
  u.searchParams.set("lat", lat); u.searchParams.set("lon", lon);
  u.searchParams.set("format","jsonv2"); u.searchParams.set("zoom","14"); u.searchParams.set("addressdetails","1");
  const r = await fetch(u.toString(), { headers:{ "Accept":"application/json" } });
  if(!r.ok){ nameCache.set(key,null); return null; }
  const d = await r.json();
  const ad = d.address || {};
  const fields = ["city","town","village","hamlet","suburb","neighbourhood"];
  let name = null; for(const f of fields){ if(ad[f]){ name = ad[f]; break; } }
  const admin = ad.state || ad.county || ad.country || "";
  let label = name ? (admin && admin!==name ? `${name}, ${admin}` : name) : null;
  if(label && WATER_RE.test(label)) label=null;
  nameCache.set(key, label);
  return label;
}

// -------- Grid fallback for "Any" or Overpass empty --------
function makeGrid(origin, radiusMi){
  const radiusKm = radiusMi*MI_TO_KM;
  const rings=[]; const stepKm=Math.max(12, Math.min(16, radiusKm/3));
  for(let d=12; d<=radiusKm; d+=stepKm) rings.push(d);
  const bearings = Array.from({length: 12}, (_,i)=> i*30);
  const pts=[]; const seen=new Set();
  for(const d of rings){ for(const b of bearings){ const p=offsetPoint(origin.lat, origin.lon, b, d);
    const key=`${p.lat.toFixed(2)},${p.lon.toFixed(2)}`; if(seen.has(key)) continue; seen.add(key); pts.push(p); } }
  return pts.slice(0, 36);
}

// -------- Main search --------
function setLoading(on){
  const btn = document.getElementById('go');
  const inputs = document.querySelectorAll('.controls input, .controls select');
  if(on){ btn.setAttribute('data-loading','1'); btn.disabled=true; inputs.forEach(i=> i.disabled=true);
    skEl.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  }else{ btn.removeAttribute('data-loading'); btn.disabled=false; inputs.forEach(i=> i.disabled=false); skEl.innerHTML=""; }
}
function colorFor(r){ return r.isSunny? '#22c55e' : (r.current.cloud_cover<=60? '#f59e0b' : '#ef4444'); }
function fmt(n){ return Math.round(n); }

async function getSunSpots(origin, radiusMi, limit, interest, signal){
  let candidates=[];
  if(interest!=="any"){
    statusEl.textContent = `Fetching ${interest.replace('_',' ')}s…`;
    candidates = await fetchPOIsOverpass(origin, radiusMi, interest);
    if(!candidates.length){ statusEl.textContent = `No ${interest.replace('_',' ')} POIs found. Scanning general area…`; candidates = makeGrid(origin, radiusMi); }
  }else{
    candidates = makeGrid(origin, radiusMi);
  }
  candidates.unshift({lat:origin.lat, lon:origin.lon, here:true});
  candidates = candidates.slice(0, 40);

  // Weather batched
  const results=[]; const batchSize=6;
  for(let i=0;i<candidates.length;i+=batchSize){
    const batch=candidates.slice(i,i+batchSize);
    const pr=batch.map(async p=>{
      try{
        const {current, next6} = await fetchNowAndHourly(p.lat, p.lon, signal);
        const sc = scorePoint(current);
        const distMi = haversineKm(origin, p)*KM_TO_MI;
        const brg = bearingDeg(origin, p);
        const sunnyFor = estimateSunnyDuration(next6);
        return {ok:true, r:{lat:p.lat, lon:p.lon, here:!!p.here, current, ...sc, distMi, bearing:brg, sunnyFor}};
      }catch(e){ return {ok:false}; }
    });
    const got = await Promise.all(pr);
    got.filter(x=>x.ok).forEach(x=> results.push(x.r));
    if(results.length>=limit*3) break;
    await new Promise(r=> setTimeout(r, 200));
  }
  if(!results.length) return [];

  // Rank & slice
  results.sort((a,b)=> (b.score-a.score) || (b.sunnyFor-a.sunnyFor));
  const slice = results.slice(0, Math.max(24, limit*2));

  // Name + dedupe
  const named=[]; const seen=new Set();
  for(const r of slice){
    const label = r.here? "Your location" : await nominatimName(r.lat, r.lon);
    if(!label) continue;
    const key = norm(label); if(seen.has(key)) continue; seen.add(key);
    r.place = label; named.push(r); if(named.length>=limit) break;
  }
  return named;
}

function render(list, origin){
  const resultsEl = document.getElementById('results');
  const spotsLayer = window.spotsLayer;
  resultsEl.innerHTML=""; spotsLayer.clearLayers();
  if(!userMarker){ userMarker=L.marker([origin.lat,origin.lon]).addTo(spotsLayer); } else userMarker.setLatLng([origin.lat,origin.lon]);
  const group=[userMarker];
  list.forEach((r,idx)=>{
    const sunnyTxt = r.sunnyFor>0 ? `Sun for ~${r.sunnyFor} min` : "Sun may vary";
    const card = document.createElement('div'); card.className='card';
    card.innerHTML = `<h3>${idx+1}. ${r.place||"Nearby"}</h3>
      <div class="row">
        <span class="pill" style="border-color:${colorFor(r)}">${r.isSunny? "Sunny now":"Bright spells"}</span>
        <span class="pill">Temp ${fmt(r.current.temperature_2m)}°C</span>
        <span class="pill">${sunnyTxt}</span>
        <span class="pill">${r.here? "0 mi" : (fmt(r.distMi)+" mi "+bearingToCardinal(r.bearing))}</span>
        ${r.here? "" : `<a class="pill" href="https://maps.google.com/?q=${r.lat},${r.lon}" target="_blank" rel="noopener">Open in Maps</a>`}
      </div>`;
    resultsEl.appendChild(card);
    const m=L.circleMarker([r.lat,r.lon],{radius:7,weight:2,color:colorFor(r)})
      .bindPopup(`<b>${idx+1}. ${r.place||"Nearby"}</b><br>Temp ${fmt(r.current.temperature_2m)}°C · ${sunnyTxt}`)
      .addTo(spotsLayer);
    group.push(m);
  });
  if(list.length){ const b=L.featureGroup(group).getBounds().pad(0.2); map.fitBounds(b); }
}

async function runSearch(){
  setLoading(true);
  const controller = new AbortController();
  const timeout = setTimeout(()=> controller.abort("timeout"), 7000);
  try{
    statusEl.textContent="Getting your location…";
    const pos = await new Promise((res,rej)=> navigator.geolocation.getCurrentPosition(res,rej,{enableHighAccuracy:true,timeout:12000}));
    const origin = { lat:pos.coords.latitude, lon:pos.coords.longitude };
    const radiusMi = Number(document.getElementById('radiusMi').value);
    const limit = Number(document.getElementById('limit').value);
    const interest = document.getElementById('interest').value;
    const list = await getSunSpots(origin, radiusMi, limit, interest, controller.signal);
    const label = interest==="any" ? `Best weather within ${radiusMi} miles.` : `Showing ${interest.replace('_',' ')}s within ${radiusMi} miles.`;
    statusEl.textContent = list.length ? label : `No results right now.`;
    render(list, origin);
  }catch(e){ console.error(e); statusEl.textContent="Search failed. Please allow location and try again."; }
  finally{ clearTimeout(timeout); setLoading(false); }
}
