// Sun Finder v5.4-stable — map restored, clean UI, strict settlements, interest-first with fallback
let map, userMarker, spotsLayer;
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const skEl = document.getElementById('skeletons');

document.addEventListener('DOMContentLoaded', () => {
  initMap();
  bindUI();
});

function initMap(){
  map = L.map('map', { zoomControl:true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution:'&copy; OpenStreetMap' }).addTo(map);
  spotsLayer = L.layerGroup().addTo(map);
  map.setView([55.9533,-3.1883], 9); // start at Edinburgh
}

function bindUI(){
  document.getElementById('go').addEventListener('click', runSearch);
  const m = document.getElementById('how');
  document.getElementById('howBtn').addEventListener('click', ()=> m.classList.add('show'));
  m.querySelector('.close').addEventListener('click', ()=> m.classList.remove('show'));
  window.addEventListener('keydown', e=> { if(e.key==='Escape') m.classList.remove('show'); });
}

const MI_TO_KM = 1.609344, KM_TO_MI = 0.621371;
function toRad(d){return d*Math.PI/180} function toDeg(r){return r*180/Math.PI}
function offsetPoint(lat, lon, bDeg, distKm){ const R=6371.0088,b=toRad(bDeg),dR=distKm/R;
  const lat1=toRad(lat),lon1=toRad(lon);
  const lat2=Math.asin(Math.sin(lat1)*Math.cos(dR)+Math.cos(lat1)*Math.sin(dR)*Math.cos(b));
  const lon2=lon1+Math.atan2(Math.sin(b)*Math.sin(dR)*Math.cos(lat1),Math.cos(dR)-Math.sin(lat1)*Math.cos(lat2));
  return {lat:toDeg(lat2),lon:((toDeg(lon2)+540)%360)-180}; }
function haversineKm(a,b){ const R=6371.0088; const dLat=toRad(b.lat-a.lat), dLon=toRad(b.lon-a.lon);
  const lat1=toRad(a.lat), lat2=toRad(b.lat); const h=Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(h)); }
function bearingDeg(a,b){ const lat1=toRad(a.lat), lat2=toRad(b.lat), dLon=toRad(b.lon-a.lon);
  const y=Math.sin(dLon)*Math.cos(lat2); const x=Math.cos(lat1)*Math.sin(lat2)-Math.sin(lat1)*Math.cos(lat2)*Math.cos(dLon);
  return (toDeg(Math.atan2(y,x))+360)%360; }
function bearingToCardinal(b){ const dirs=["N","NNE","NE","ENE","E","ESE","SE","S","SSW","SW","WSW","W","WNW","NW","NNW"]; return dirs[Math.round(b/22.5)%16]; }

function setLoading(on){
  const btn=document.getElementById('go'); const inputs=document.querySelectorAll('.controls input,.controls select');
  if(on){ btn.classList.add('loading'); btn.disabled=true; inputs.forEach(i=> i.disabled=true);
    skEl.innerHTML='<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  } else { btn.classList.remove('loading'); btn.disabled=false; inputs.forEach(i=> i.disabled=false); skEl.innerHTML=''; }
}

async function runSearch(){
  setLoading(true);
  resultsEl.innerHTML='';
  statusEl.textContent='Getting your location…';
  try{
    const pos = await new Promise((res,rej)=> navigator.geolocation.getCurrentPosition(res,rej,{enableHighAccuracy:true,timeout:12000}));
    const origin = { lat:pos.coords.latitude, lon:pos.coords.longitude };
    const radiusMi = Number(document.getElementById('radiusMi').value) || 50;
    const limit = Number(document.getElementById('limit').value) || 8;
    const interest = document.getElementById('interest').value;

    if(!userMarker){ userMarker=L.marker([origin.lat, origin.lon]).addTo(spotsLayer); } else userMarker.setLatLng([origin.lat, origin.lon]);

    const list = await findSunSpots(origin, radiusMi, limit, interest);
    const label = interest==='any' ? `Best weather within ${radiusMi} miles.` : `Showing ${interest.replace('_',' ')}s within ${radiusMi} miles.`;
    statusEl.textContent = list.length ? label : `No perfect sun right now — showing best weather if available.`;
    render(list, origin);
  }catch(e){
    console.error(e);
    statusEl.textContent='Location blocked or failed. Please allow location and reload (HTTPS required).';
  }finally{
    setLoading(false);
  }
}

function gridCandidates(origin, radiusMi){
  const radiusKm = radiusMi*MI_TO_KM;
  const rings=[]; const stepKm=Math.max(12, Math.min(16, radiusKm/3));
  for(let d=12; d<=radiusKm; d+=stepKm) rings.push(d);
  const bearings = Array.from({length: 12}, (_,i)=> i*30);
  const pts=[]; const seen=new Set();
  for(const d of rings){ for(const b of bearings){ const p=offsetPoint(origin.lat, origin.lon, b, d);
    const key=`${p.lat.toFixed(2)},${p.lon.toFixed(2)}`; if(seen.has(key)) continue; seen.add(key); pts.push(p); } }
  pts.unshift({lat:origin.lat, lon:origin.lon, here:true});
  return pts.slice(0, 36);
}

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
  const s = (n)=> Number(n).toFixed(5);
  return [s(origin.lat-latDelta), s(origin.lon-lonDelta), s(origin.lat+latDelta), s(origin.lon+lonDelta)];
}

async function fetchPOIs(origin, radiusMi, interest){
  const flt = overpassFilter(interest);
  if(!flt) return [];
  const [s,w,n,e] = bboxFrom(origin, radiusMi);
  const q = "[out:json][timeout:10];(" + flt + ")(" + s + "," + w + "," + n + "," + e + ");out center;";
  const ctrl = new AbortController(); const to = setTimeout(()=> ctrl.abort("timeout"), 5000);
  try{
    const r = await fetch("https://overpass-api.de/api/interpreter", {
      method:"POST",
      headers:{ "Content-Type":"application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(q),
      signal: ctrl.signal
    });
    if(!r.ok) throw new Error("overpass "+r.status);
    const d = await r.json();
    const out=[]; (d.elements||[]).forEach(e=>{
      const lat=e.lat || e.center?.lat, lon=e.lon || e.center?.lon;
      if(lat && lon) out.push({lat, lon});
    });
    return out;
  }catch(e){ console.warn("Overpass failed:", e.message||e); return []; }
  finally{ clearTimeout(to); }
}

const nameCache = new Map();
async function settlementName(lat, lon){
  const key=`${lat.toFixed(3)},${lon.toFixed(3)}`;
  if(nameCache.has(key)) return nameCache.get(key);
  // be gentle to Nominatim
  await new Promise(r=> setTimeout(r, 120));
  const u = new URL("https://nominatim.openstreetmap.org/reverse");
  u.searchParams.set("lat", lat); u.searchParams.set("lon", lon);
  u.searchParams.set("format","jsonv2"); u.searchParams.set("zoom","14"); u.searchParams.set("addressdetails","1");
  const r = await fetch(u.toString(), { headers:{ "Accept":"application/json" } });
  if(!r.ok){ nameCache.set(key,null); return null; }
  const d = await r.json();
  const ad = d.address || {};
  const place = ad.city || ad.town || ad.village || ad.hamlet || ad.suburb || ad.neighbourhood || null;
  const bad = /(school|station|memorial|murder|incident|academy|college|campus)/i;
  const label = place && !bad.test(place) ? place : null;
  nameCache.set(key, label);
  return label;
}

async function fetchWeather(lat, lon){
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", lat.toFixed(3));
  url.searchParams.set("longitude", lon.toFixed(3));
  url.searchParams.set("current", "temperature_2m,precipitation,cloud_cover,shortwave_radiation,is_day");
  url.searchParams.set("timezone", "auto");
  const r = await fetch(url.toString());
  if(!r.ok) return null;
  const d = await r.json();
  return {
    temp: d.current?.temperature_2m ?? null,
    cloud: d.current?.cloud_cover ?? 100,
    precip: d.current?.precipitation ?? 0,
    sw: d.current?.shortwave_radiation ?? 0
  };
}

function score(current){
  const sw=current.sw??0, cc=current.cloud??100, pr=current.precip??0;
  const isSunny=(cc<=30)&&(pr<0.1)&&(sw>=100);
  let base=sw-1.4*cc-180*pr; if(isSunny) base+=100;
  return {score:base, isSunny};
}

async function findSunSpots(origin, radiusMi, limit, interest){
  statusEl.textContent = interest!=='any' ? `Looking for ${interest.replace('_',' ')}s…` : `Scanning nearby weather…`;
  let candidates=[];
  if(interest!=='any'){
    candidates = await fetchPOIs(origin, radiusMi, interest);
    if(!candidates.length){ candidates = gridCandidates(origin, radiusMi); }
  } else {
    candidates = gridCandidates(origin, radiusMi);
  }
  candidates = candidates.slice(0, 40);

  const results=[];
  for(const p of candidates){
    const w = await fetchWeather(p.lat, p.lon); if(!w) continue;
    const nm = p.here ? "Your location" : await settlementName(p.lat, p.lon); if(!nm) continue;
    const sc = score(w);
    const distMi = haversineKm(origin, p)*KM_TO_MI;
    const brg = bearingDeg(origin, p);
    results.push({lat:p.lat, lon:p.lon, here:!!p.here, place:nm, current:w, ...sc, distMi, bearing:brg});
    if(results.length>=limit*3) break;
  }
  results.sort((a,b)=> (b.score-a.score));
  // dedupe by place
  const seen=new Set(); const out=[];
  for(const r of results){
    const key = r.place.toLowerCase().replace(/^city of\s+/,'').trim();
    if(seen.has(key)) continue; seen.add(key); out.push(r);
    if(out.length>=limit) break;
  }
  return out;
}

function colorFor(r){ return r.isSunny? '#22c55e' : (r.current.cloud<=60? '#f59e0b' : '#ef4444'); }
function fmt(n){ return Math.round(n); }

function render(list, origin){
  resultsEl.innerHTML=''; spotsLayer.clearLayers();
  const group=[];
  if(userMarker){ group.push(userMarker); }
  list.forEach((r,idx)=>{
    if(idx===3){
      const ad=document.createElement('div'); ad.className='ad'; ad.innerHTML='<span>Ad slot (inline)</span>'; resultsEl.appendChild(ad);
    }
    const sunnyTxt = r.isSunny ? "Sunny now" : "Sun may vary";
    const card=document.createElement('div'); card.className='card';
    card.innerHTML = `<h3>${idx+1}. ${r.place}</h3>
      <div class="row">
        <span class="pill" style="border-color:${colorFor(r)}">${sunnyTxt}</span>
        <span class="pill">Temp ${fmt(r.current.temp)}°C</span>
        <span class="pill">${r.here? "0 mi" : (fmt(r.distMi)+" mi "+bearingToCardinal(r.bearing))}</span>
        ${r.here? "" : `<a class="pill" href="https://maps.google.com/?q=${r.lat},${r.lon}" target="_blank" rel="noopener">Open in Maps</a>`}
      </div>`;
    resultsEl.appendChild(card);
    const m=L.circleMarker([r.lat,r.lon],{radius:7,weight:2,color:colorFor(r)})
      .bindPopup(`<b>${idx+1}. ${r.place}</b><br>Temp ${fmt(r.current.temp)}°C · ${sunnyTxt}`)
      .addTo(spotsLayer);
    group.push(m);
  });
  if(list.length){ const b=L.featureGroup(group).getBounds().pad(0.2); map.fitBounds(b); }
}
