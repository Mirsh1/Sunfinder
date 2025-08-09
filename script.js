// Sun Finder v5.5 — Wikidata interest search, sunshine duration, Top 3, SEO, no inline ads
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
function fmt(n){ return Math.round(n); }
function toRad(d){ return d*Math.PI/180; } function toDeg(r){ return r*180/Math.PI; }

function initMap(){
  map = L.map('map', { zoomControl:true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution:'&copy; OpenStreetMap' }).addTo(map);
  spotsLayer = L.layerGroup().addTo(map);
  map.setView([55.9533, -3.1883], 9); // default Edinburgh
}
window.addEventListener('load', initMap);

function havKm(a,b){ const R=6371.0088; const dLat=toRad(b.lat-a.lat), dLon=toRad(b.lon-a.lon);
  const lat1=toRad(a.lat), lat2=toRad(b.lat);
  const h=Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));
}
function bearingDeg(a,b){ const lat1=toRad(a.lat), lat2=toRad(b.lat), dLon=toRad(b.lon-a.lon);
  const y=Math.sin(dLon)*Math.cos(lat2); const x=Math.cos(lat1)*Math.sin(lat2)-Math.sin(lat1)*Math.cos(lat2)*Math.cos(dLon);
  return (toDeg(Math.atan2(y,x))+360)%360; }
function bearingToCardinal(b){ const dirs=["N","NNE","NE","ENE","E","ESE","SE","S","SSW","SW","WSW","W","WNW","NW","NNW"]; return dirs[Math.round(b/22.5)%16]; }

function setLoading(on){ if(on){ btn.classList.add('loading'); btn.disabled=true; } else { btn.classList.remove('loading'); btn.disabled=false; } }

// ===== Weather =====
async function fetchNowAndHourly(lat, lon, signal){
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", lat.toFixed(3));
  url.searchParams.set("longitude", lon.toFixed(3));
  url.searchParams.set("current", "temperature_2m,precipitation,cloud_cover,shortwave_radiation,is_day");
  url.searchParams.set("hourly", "cloud_cover,shortwave_radiation,precipitation,temperature_2m");
  url.searchParams.set("forecast_days", "1");
  url.searchParams.set("timezone", "auto");
  const res = await fetch(url.toString(), { signal });
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
  return { current: data.current, next };
}

function isSunnyLike(cc, sw, pr){ return (cc<=40)&&(pr<0.2)&&(sw>=80); }
function sunshineWindow(next){
  let minutes=0, until=null;
  for(let i=0;i<next.time.length;i++){
    const ok = isSunnyLike(next.cloud[i], next.sw[i], next.pr[i]);
    if(ok){ minutes += 60; until = next.time[i]; } else { if(minutes>0) break; }
  }
  return { minutes, until };
}

// ===== Wikidata: category → POIs within radius =====
const WD = {
  beach: "Q40080",
  nature_reserve: "Q473972",
  lake: "Q23397",
  theme_park: "Q134342",
  historic: "Q23413", // castle (as a proxy)
  scenic_view: "Q207694", // viewpoint
  park: "Q22698", // park
  zoo: "Q43501" // zoo
};

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
      const wkt = row.coord.value; // 'Point(lon lat)'
      const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(wkt);
      if(!m) return;
      const lon = parseFloat(m[1]), lat = parseFloat(m[2]);
      out.push({ lat, lon, title: row.itemLabel?.value || "Place" });
    });
    return out;
  }catch(e){
    console.warn("Wikidata failed:", e.message||e);
    return [];
  }
}

// ===== Nominatim: nearest settlement name =====
const nameCache = new Map();
async function settlementName(lat, lon){
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if(nameCache.has(key)) return nameCache.get(key);
  const u = new URL("https://nominatim.openstreetmap.org/reverse");
  u.searchParams.set("lat", lat); u.searchParams.set("lon", lon);
  u.searchParams.set("format","jsonv2"); u.searchParams.set("zoom","14"); u.searchParams.set("addressdetails","1");
  const r = await fetch(u, { headers:{ "Accept":"application/json" } });
  if(!r.ok){ nameCache.set(key,null); return null; }
  const d = await r.json();
  const ad = d.address || {};
  const place = ad.city || ad.town || ad.village || ad.hamlet || ad.suburb || ad.neighbourhood || null;
  const bad = /(school|station|memorial|incident|murder|academy|college|campus)/i.test(place||"");
  const label = bad ? null : place;
  nameCache.set(key, label);
  return label;
}

// ===== Fallback grid =====
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
function offsetPoint(lat, lon, bDeg, distKm){ const R=6371.0088,b=toRad(bDeg),dR=distKm/R;
  const lat1=toRad(lat),lon1=toRad(lon);
  const lat2=Math.asin(Math.sin(lat1)*Math.cos(dR)+Math.cos(lat1)*Math.sin(dR)*Math.cos(b));
  const lon2=lon1+Math.atan2(Math.sin(b)*Math.sin(dR)*Math.cos(lat1),Math.cos(dR)-Math.sin(lat1)*Math.cos(lat2));
  return {lat:toDeg(lat2),lon:((toDeg(lon2)+540)%360)-180}; }

function colorFor(r){ return r.isSunny? '#22c55e' : (r.current.cloud_cover<=60? '#f59e0b' : '#ef4444'); }

// ===== Main search =====
async function runSearch(){
  setLoading(true);
  resultsEl.innerHTML = "";
  top3El.innerHTML = "";
  const controller = new AbortController();
  const timeout = setTimeout(()=> controller.abort("timeout"), 9000);
  try{
    statusEl.textContent="Getting your location…";
    const pos = await new Promise((res,rej)=> navigator.geolocation.getCurrentPosition(res,rej,{enableHighAccuracy:true,timeout:12000}));
    const origin = { lat:pos.coords.latitude, lon:pos.coords.longitude };
    const radiusMi = Number(document.getElementById('radiusMi').value);
    const limit = Number(document.getElementById('limit').value);
    const interest = document.getElementById('interest').value;

    const list = await getSunSpots(origin, radiusMi, limit, interest, controller.signal);
    if(!list.length){ statusEl.textContent = "No perfect sun right now — showing best weather."; }
    else{
      const label = interest==="any" ? `Best weather within ${radiusMi} miles.` : `Best ${interest.replace('_',' ')} options within ${radiusMi} miles.`;
      statusEl.textContent = label;
    }
    render(list, origin, interest);
    updateSEO(list, origin, interest);
  }catch(e){
    console.error(e);
    statusEl.textContent="Search failed. Please allow location and try again.";
  }finally{
    clearTimeout(timeout); setLoading(false);
  }
}
document.getElementById('go').addEventListener('click', runSearch);

async function getSunSpots(origin, radiusMi, limit, interest, signal){
  let candidates=[];
  if(interest!=="any"){
    statusEl.textContent = `Looking up ${interest.replace('_',' ')}s…`;
    const pois = await fetchWikidataPOIs(origin, radiusMi*MI_TO_KM, interest);
    // Map to settlements and keep within 3 miles of the POI
    for(const p of pois){
      const place = await settlementName(p.lat, p.lon);
      if(!place) continue;
      const distToTownMi = havKm({lat:p.lat,lon:p.lon},{lat:origin.lat,lon:origin.lon})*KM_TO_MI; // just for sort near user
      candidates.push({ lat:p.lat, lon:p.lon, place, poiTitle:p.title, distToTownMi });
      if(candidates.length > 60) break;
    }
    if(!candidates.length){
      statusEl.textContent = `No POIs found — scanning general area…`;
      candidates = makeGrid(origin, radiusMi);
    }
  }else{
    candidates = makeGrid(origin, radiusMi);
  }

  // Weather batched
  const results=[]; const batchSize=6;
  for(let i=0;i<candidates.length;i+=batchSize){
    const batch=candidates.slice(i,i+batchSize);
    const pr = batch.map(async p=>{
      try{
        const {current, next} = await fetchNowAndHourly(p.lat, p.lon, signal);
        const win = sunshineWindow(next);
        const isSunny = (current.cloud_cover<=30 && current.precipitation<0.1 && current.shortwave_radiation>=100);
        const distMi = havKm(origin, p)*KM_TO_MI;
        const brg = bearingDeg(origin, p);
        return {ok:true, r:{...p, current, isSunny, sunnyMinutes:win.minutes, sunnyUntil:win.until, distMi, bearing:brg}};
      }catch(e){ return {ok:false}; }
    });
    const got = await Promise.all(pr);
    got.filter(x=>x.ok).forEach(x=> results.push(x.r));
    if(results.length>=limit*3) break;
    await new Promise(r=> setTimeout(r, 150));
  }

  // Sort by longest sunshine, then closest
  results.sort((a,b)=> (b.sunnyMinutes - a.sunnyMinutes) || (a.distMi - b.distMi));
  return results.slice(0, Math.max(limit, 10));
}

// ===== Render =====
function render(list, origin, interest){
  resultsEl.innerHTML=""; spotsLayer.clearLayers(); top3El.innerHTML="";
  if(!userMarker){ userMarker=L.marker([origin.lat,origin.lon]).addTo(spotsLayer); } else userMarker.setLatLng([origin.lat,origin.lon]);
  const group=[userMarker];
  const top = list.slice(0,3);

  // Top 3
  top.forEach((r, idx)=>{
    const mins=r.sunnyMinutes, until=r.sunnyUntil? new Date(r.sunnyUntil).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '—';
    const card = document.createElement('div');
    card.className='topCard';
    card.innerHTML = `<h4>${idx+1}. ${r.place}</h4>
      <div class="row">
        <span class="pill ${r.isSunny?'ok':'warn'}">${r.isSunny?'Sunny now':'Sun may vary'}</span>
        <span class="pill">Sunny for ${Math.floor(mins/60)}h ${mins%60? (mins%60+'m'):''} ${until!=='—'?`(until ${until})`:''}</span>
        <span class="pill">${fmt(r.distMi)} mi ${bearingToCardinal(r.bearing)}</span>
      </div>`;
    top3El.appendChild(card);
  });

  // Full list
  list.forEach((r, idx)=>{
    const mins=r.sunnyMinutes, until=r.sunnyUntil? new Date(r.sunnyUntil).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '—';
    const card = document.createElement('div'); card.className='card';
    const catBadge = interest!=='any' ? `<span class="pill ok">✓ ${interest.replace('_',' ')}</span>` : '';
    card.innerHTML = `<h3>${idx+1}. ${r.place}</h3>
      <div class="row">
        ${catBadge}
        <span class="pill ${r.isSunny?'ok':'warn'}">${r.isSunny?'Sunny now':'Sun may vary'}</span>
        <span class="pill">Temp ${fmt(r.current.temperature_2m)}°C</span>
        <span class="pill">Sunny for ${Math.floor(mins/60)}h ${mins%60? (mins%60+'m'):''} ${until!=='—'?`(until ${until})`:''}</span>
        <span class="pill">${fmt(r.distMi)} mi ${bearingToCardinal(r.bearing)}</span>
        <a class="pill" href="https://maps.google.com/?q=${r.lat},${r.lon}" target="_blank" rel="noopener">Open in Maps</a>
      </div>`;
    resultsEl.appendChild(card);

    const m=L.circleMarker([r.lat,r.lon],{radius:7,weight:2,color:r.isSunny?'#22c55e':'#f59e0b'})
      .bindPopup(`<b>${idx+1}. ${r.place}</b><br>Sunny for ${Math.floor(mins/60)}h ${mins%60? (mins%60+'m'):''}${until!=='—'?` (until ${until})`:''}`)
      .addTo(spotsLayer);
    group.push(m);
  });
  if(list.length){ const b=L.featureGroup(group).getBounds().pad(0.2); map.fitBounds(b); }
}

// ===== SEO updates (dynamic) =====
function updateSEO(list, origin, interest){
  const interestLabel = interest==='any' ? 'Sunniness' : interest.replace('_',' ');
  document.title = `Find the sunniest ${interestLabel.toLowerCase()} near you — Sun Finder`;
  const desc = list.length ?
    `Top spots right now: ${list.slice(0,3).map(x=>x.place).join(', ')}. See sunshine duration and temperature.` :
    `Find the sunniest places near you right now. See sunshine duration and temperature.`;
  let meta = document.querySelector('meta[name="description"]');
  if(!meta){ meta = document.createElement('meta'); meta.setAttribute('name','description'); document.head.appendChild(meta); }
  meta.setAttribute('content', desc);

  // JSON-LD ItemList of results
  const schema = {
    "@context":"https://schema.org",
    "@type":"ItemList",
    "itemListElement": list.map((r,i)=> ({
      "@type":"ListItem",
      "position": i+1,
      "item": {
        "@type":"Place",
        "name": r.place,
        "geo": { "@type":"GeoCoordinates", "latitude": r.lat, "longitude": r.lon },
        "additionalProperty":[
          {"@type":"PropertyValue","name":"temperature_2m","value":r.current.temperature_2m},
          {"@type":"PropertyValue","name":"sunny_minutes","value":r.sunnyMinutes}
        ]
      }
    }))
  };
  let ld = document.getElementById('ld-json');
  if(!ld){ ld = document.createElement('script'); ld.type="application/ld+json"; ld.id="ld-json"; document.head.appendChild(ld); }
  ld.textContent = JSON.stringify(schema);
}
