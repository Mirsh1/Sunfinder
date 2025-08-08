// Sun Finder v4.7.1 — fast results, spinner, capped list, hi-res images, Wikipedia-only naming
let map, spotsLayer, userMarker;
const resultsEl = document.getElementById('results');
const statusEl = document.getElementById('status');
const btn = document.getElementById('go');
const btnText = document.getElementById('btnText');
const spin = document.getElementById('spin');

// UI: how it works
document.getElementById('help').onclick = ()=> document.getElementById('howto').style.display = 'flex';
document.getElementById('closeHow').onclick = ()=> document.getElementById('howto').style.display = 'none';

const MI_TO_KM = 1.609344;
const KM_TO_MI = 0.621371;
const WATER_RE = /(sea|ocean|bay|firth|channel|loch|estuary|gulf|sound|lake)/i;

function initMap(){
  map = L.map('map', { zoomControl: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap' }).addTo(map);
  spotsLayer = L.layerGroup().addTo(map);
  map.setView([55.95, -3.18], 8);
}

function deg2rad(d){ return d * Math.PI / 180; } function rad2deg(r){ return r * 180 / Math.PI; }
function offsetPoint(lat, lon, bearingDeg, distanceKm){
  const R = 6371.0088; const brng = deg2rad(bearingDeg); const dR = distanceKm / R;
  const lat1 = deg2rad(lat); const lon1 = deg2rad(lon);
  const lat2 = Math.asin(Math.sin(lat1)*Math.cos(dR) + Math.cos(lat1)*Math.sin(dR)*Math.cos(brng));
  const lon2 = lon1 + Math.atan2(Math.sin(brng)*Math.sin(dR)*Math.cos(lat1), Math.cos(dR)-Math.sin(lat1)*Math.sin(lat2));
  return { lat: rad2deg(lat2), lon: ((rad2deg(lon2)+540)%360)-180 };
}
function haversineKm(a,b){
  const R = 6371.0088; const dLat = deg2rad(b.lat - a.lat); const dLon = deg2rad(b.lon - a.lon);
  const lat1 = deg2rad(a.lat); const lat2 = deg2rad(b.lat);
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));
}
function bearingDeg(a,b){
  const lat1 = deg2rad(a.lat), lat2 = deg2rad(b.lat);
  const dLon = deg2rad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1)*Math.sin(lat2) - Math.sin(lat1)*Math.cos(lat2)*Math.cos(dLon);
  return (rad2deg(Math.atan2(y,x)) + 360) % 360;
}
function bearingToCardinal(b){ const dirs = ["N","NNE","NE","ENE","E","ESE","SE","S","SSW","SW","WSW","W","WNW","NW","NNW"]; return dirs[Math.round(b/22.5) % 16]; }

function isSunnyLike(cc, sw, pr){ return (cc <= 40) && (pr < 0.2) && (sw >= 80); }
function scorePoint(current){
  const sw = (current.shortwave_radiation ?? 0);
  const cc = (current.cloud_cover ?? 100);
  const precip = (current.precipitation ?? 0);
  const isSunny = (cc <= 30) && (precip < 0.1) && (sw >= 100);
  let base = sw - 1.4*cc - 180*precip;
  if (isSunny) base += 100;
  return { score: base, isSunny };
}

async function fetchNowAndHourly(lat, lon){
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", lat.toFixed(3));
  url.searchParams.set("longitude", lon.toFixed(3));
  url.searchParams.set("current", "temperature_2m,weather_code,precipitation,cloud_cover,shortwave_radiation,is_day");
  url.searchParams.set("hourly", "cloud_cover,shortwave_radiation,precipitation,temperature_2m");
  url.searchParams.set("forecast_days", "1");
  url.searchParams.set("timezone", "auto");
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error("wx "+res.status);
  const data = await res.json();
  let next6 = { time:[], cloud:[], sw:[], pr:[], temp:[] };
  try{
    const nowISO = data.current.time;
    const idx = data.hourly.time.indexOf(nowISO);
    const from = (idx >= 0) ? idx+1 : 0;
    next6 = {
      time: data.hourly.time.slice(from, from+6),
      cloud: data.hourly.cloud_cover.slice(from, from+6),
      sw: data.hourly.shortwave_radiation.slice(from, from+6),
      pr: data.hourly.precipitation.slice(from, from+6),
      temp: data.hourly.temperature_2m.slice(from, from+6)
    };
  }catch(e){}
  return { current: data.current, next6 };
}

function estimateSunnyDuration(next6){
  let minutes = 0;
  for (let i=0; i<next6.time.length; i++){
    if (isSunnyLike(next6.cloud[i], next6.sw[i], next6.pr[i])) minutes += 60;
    else break;
  }
  return minutes;
}

// Wikipedia helpers for naming & images
async function wikiGeoName(lat, lon){
  try{
    const url = `https://en.wikipedia.org/w/api.php?origin=*&action=query&list=geosearch&gsradius=10000&gslimit=1&format=json&gscoord=${lat}%7C${lon}`;
    const res = await fetch(url);
    if(!res.ok) return null;
    const data = await res.json();
    const t = data?.query?.geosearch?.[0]?.title;
    if(!t || WATER_RE.test(t)) return null;
    return t;
  }catch(e){ return null; }
}
async function wikiImage(title){
  try{
    const url = `https://en.wikipedia.org/w/api.php?origin=*&action=query&prop=pageimages&pithumbsize=960&format=json&titles=${encodeURIComponent(title)}`;
    const res = await fetch(url);
    if(!res.ok) return null;
    const data = await res.json();
    const pages = data?.query?.pages || {};
    const first = Object.values(pages)[0];
    return first?.thumbnail?.source || null;
  }catch(e){ return null; }
}

// Spinner helpers
function startLoading(){ spin.style.display = 'inline-block'; btn.setAttribute('disabled','disabled'); }
function stopLoading(){ spin.style.display = 'none'; btn.removeAttribute('disabled'); }

// Skeletons
function showSkeletons(n=3){
  resultsEl.innerHTML = '';
  for(let i=0;i<n;i++){
    const sk = document.createElement('div');
    sk.className = 'sk-card skeleton';
    resultsEl.appendChild(sk);
  }
}
function clearSkeletons(){ resultsEl.innerHTML = ''; }

async function getSunSpots(origin, radiusMi, limit, timeoutMs=10000){
  const controller = new AbortController();
  const timeout = setTimeout(()=> controller.abort('timeout'), timeoutMs);

  try{
    const radiusKm = radiusMi * MI_TO_KM;
    // Max ~120 points
    const rings = []; const stepKm = Math.max(6, Math.min(12, radiusKm/5));
    for (let d=6; d<=radiusKm; d+=stepKm) rings.push(d);
    const bearings = Array.from({length: 24}, (_,i)=> i*15);
    const candidates = [];
    const seen = new Set();
    for(const d of rings){ for(const b of bearings){ const p = offsetPoint(origin.lat, origin.lon, b, d);
      const key = p.lat.toFixed(2)+","+p.lon.toFixed(2); if(seen.has(key)) continue; seen.add(key); candidates.push(p); } }
    candidates.unshift({lat:origin.lat, lon:origin.lon, here:true});

    // Weather in batches of 6
    const results = [];
    for(let i=0;i<candidates.length;i+=6){
      const batch = candidates.slice(i, i+6);
      const fetched = await Promise.all(batch.map(async p=>{
        try{ const data = await fetchNowAndHourly(p.lat, p.lon); return {ok:true,p,data}; }
        catch(e){ return {ok:false,p,error:e}; }
      }));
      for(const r of fetched){
        if(!r.ok) continue;
        const {current,next6} = r.data;
        const sc = scorePoint(current);
        const distMi = haversineKm(origin, r.p) * KM_TO_MI;
        const brg = bearingDeg(origin, r.p);
        const sunnyFor = estimateSunnyDuration(next6);
        results.push({ lat:r.p.lat, lon:r.p.lon, here:!!r.p.here, current, ...sc, distMi, bearing: brg, sunnyFor });
      }
      if(results.length >= limit*4) break; // enough to name
      await new Promise(res=> setTimeout(res, 200));
      if(controller.signal.aborted) break;
    }

    if(!results.length) return [];

    results.sort((a,b)=> (b.score - a.score) || (b.sunnyFor - a.sunnyFor));
    const slice = results.slice(0, Math.max(limit*3, 24));

    // Name slice using Wikipedia only
    const named = [];
    for(const r of slice){
      if(r.here){ r.place="Your location"; named.push(r); continue; }
      const nm = await wikiGeoName(r.lat, r.lon);
      if(!nm) continue;
      r.place = nm;
      named.push(r);
      if(named.length >= limit*2) break;
    }

    // Dedupe by name and take top
    const best = new Map();
    for(const r of named){ const key = r.place.toLowerCase(); const prev = best.get(key); if(!prev || r.score > prev.score) best.set(key, r); }
    const out = Array.from(best.values()).slice(0, limit);
    return out;
  } finally {
    clearTimeout(timeout);
  }
}

function colorFor(r){ if (r.isSunny) return "#22c55e"; if (r.current.cloud_cover<=60) return "#f59e0b"; return "#ef4444"; }
function fmt(n){ return Math.round(n); }

async function enrich(r){
  if(r.here){ r.hero=null; r.pois=[]; return r; }
  try{ r.hero = await wikiImage(r.place); }catch(e){ r.hero=null; }
  if(!r.hero){ r.hero = 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/Sun_symbol.svg/960px-Sun_symbol.svg.png'; }
  return r;
}

function render(list, origin){
  clearSkeletons();
  resultsEl.innerHTML = "";
  spotsLayer.clearLayers();
  if (!userMarker){ userMarker = L.marker([origin.lat, origin.lon], { title: "You" }).addTo(spotsLayer); } else userMarker.setLatLng([origin.lat, origin.lon]);

  const group = [userMarker];
  list.forEach((r, idx)=>{
    const name = r.place;
    const sunnyTxt = r.sunnyFor > 0 ? `Sun for ~${r.sunnyFor} min` : "Sun may vary";
    const card = document.createElement("div"); card.className = "card";
    const img = document.createElement("img"); img.className = "hero"; img.loading="lazy"; img.decoding="async"; img.src = r.hero; card.appendChild(img);
    const body = document.createElement("div"); body.className = "card-body";
    body.innerHTML = `
      <h3 style="margin:0 0 8px 0">${idx+1}. ${name}</h3>
      <div class="row">
        <span class="tag" style="border-color:${colorFor(r)}">${r.isSunny ? "Sunny now" : (r.current.cloud_cover<=60 ? "Bright spells" : "Cloudy")}</span>
        <span class="pill">Temp ${fmt(r.current.temperature_2m)}°C</span>
        <span class="pill">${sunnyTxt}</span>
        <span class="pill">${r.here ? "0 mi" : (fmt(r.distMi)+" mi "+bearingToCardinal(r.bearing))}</span>
        ${r.here ? "" : `<a class="link" href="https://maps.google.com/?q=${r.lat},${r.lon}" target="_blank" rel="noopener">Open in Maps</a>`}
      </div>`;
    card.appendChild(body);
    resultsEl.appendChild(card);

    const m = L.circleMarker([r.lat, r.lon], { radius: 7, weight: 2, color: colorFor(r) })
      .bindPopup(`<b>${idx+1}. ${name}</b><br>Temp ${fmt(r.current.temperature_2m)}°C · ${sunnyTxt}`)
      .addTo(spotsLayer);
    group.push(m);
  });
  if(list.length){ const bounds = L.featureGroup(group).getBounds().pad(0.2); map.fitBounds(bounds); }
}

async function runSearch(){
  startLoading();
  showSkeletons(3);
  statusEl.textContent = "Scanning nearby weather…";
  try{
    const pos = await new Promise((resolve, reject)=>{ navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000 }); });
    const origin = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    const radiusMi = Number(document.getElementById('radiusMi').value);
    const limit = Number(document.getElementById('limit').value);

    const list = await getSunSpots(origin, radiusMi, limit, 10000);
    const enriched = await Promise.all(list.map(enrich));
    const anySunny = enriched.some(x=> x.isSunny);
    statusEl.textContent = anySunny ? `Top ${enriched.length} sunniest spots within ${radiusMi} miles.`
                                    : `No full sun right now. Showing best weather within ${radiusMi} miles.`;
    render(enriched, origin);
  }catch(e){
    console.error(e);
    statusEl.textContent = "Location or network failed. Check permissions and try again.";
    clearSkeletons();
  }finally{
    stopLoading();
  }
}

document.getElementById('go').addEventListener('click', runSearch);

window.addEventListener('load', initMap);
