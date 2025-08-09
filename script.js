// v5.5.2 — favicon added, weather rate limiter/backoff/caching, stable "best weather" fallback
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
  map.setView([55.9533, -3.1883], 9);
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

// Weather rate limiter + cache
const weatherCache = new Map();
let inFlight = 0; const MAX_CONCURRENCY = 3; const queue = [];
async function schedule(fn){ return new Promise((res,rej)=>{ queue.push({fn,res,rej}); pump(); }); }
async function pump(){
  while(inFlight < MAX_CONCURRENCY && queue.length){
    const job = queue.shift(); inFlight++;
    job.fn().then(v=> job.res(v)).catch(e=> job.rej(e)).finally(()=>{ inFlight--; pump(); });
  }
}
async function fetchWithBackoff(url, tries=3){
  for(let i=0;i<tries;i++){
    const r = await fetch(url);
    if(r.status !== 429){ if(!r.ok) throw new Error('weather '+r.status); return r; }
    await new Promise(s=> setTimeout(s, 600*(i+1))); // backoff
  }
  throw new Error('weather 429');
}

async function fetchNowAndHourly(lat, lon){
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`; // cache by ~1km
  if(weatherCache.has(key)) return weatherCache.get(key);
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", lat.toFixed(3));
  url.searchParams.set("longitude", lon.toFixed(3));
  url.searchParams.set("current", "temperature_2m,precipitation,cloud_cover,shortwave_radiation,is_day");
  url.searchParams.set("hourly", "cloud_cover,shortwave_radiation,precipitation,temperature_2m");
  url.searchParams.set("forecast_days", "1");
  url.searchParams.set("timezone", "auto");
  const r = await schedule(()=> fetchWithBackoff(url.toString()));
  const data = await r.json();
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
  const out = { current: data.current, next };
  weatherCache.set(key, out);
  return out;
}
function isSunnyLike(cc, sw, pr){ return (cc<=50)&&(pr<0.2)&&(sw>=70); } // slightly relaxed
function sunshineWindow(next){
  let minutes=0, until=null;
  for(let i=0;i<next.time.length;i++){
    const ok = isSunnyLike(next.cloud[i], next.sw[i], next.pr[i]);
    if(ok){ minutes += 60; until = next.time[i]; } else { if(minutes>0) break; }
  }
  return { minutes, until };
}

// Simplified: we’ll use a small grid (reliable, fewer API hits)
function makeGrid(origin, radiusMi){
  const radiusKm = radiusMi*MI_TO_KM;
  const rings=[]; const stepKm=Math.max(14, Math.min(18, radiusKm/3));
  for(let d=12; d<=radiusKm; d+=stepKm) rings.push(d);
  const bearings = Array.from({length: 10}, (_,i)=> i*36);
  const pts=[]; const seen=new Set();
  for(const d of rings){ for(const b of bearings){ const p=offsetPoint(origin.lat, origin.lon, b, d);
    const key=`${p.lat.toFixed(2)},${p.lon.toFixed(2)}`; if(seen.has(key)) continue; seen.add(key); pts.push(p); } }
  return pts.slice(0, 24);
}
function offsetPoint(lat, lon, bDeg, distKm){ const R=6371.0088,b=toRad(bDeg),dR=distKm/R;
  const lat1=toRad(lat),lon1=toRad(lon);
  const lat2=Math.asin(Math.sin(lat1)*Math.cos(dR)+Math.cos(lat1)*Math.sin(dR)*Math.cos(b));
  const lon2=lon1+Math.atan2(Math.sin(b)*Math.sin(dR)*Math.cos(lat1),Math.cos(dR)-Math.sin(lat1)*Math.cos(lat2));
  return {lat:toDeg(lat2),lon:((toDeg(lon2)+540)%360)-180}; }

// Reverse geocode with strict settlement filters
const nameCache = new Map();
async function settlementName(lat, lon){
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if(nameCache.has(key)) return nameCache.get(key);
  const zooms = [14,12,10,8];
  for(const z of zooms){
    const u = new URL("https://nominatim.openstreetmap.org/reverse");
    u.searchParams.set("lat", lat); u.searchParams.set("lon", lon);
    u.searchParams.set("format","jsonv2"); u.searchParams.set("zoom", String(z)); u.searchParams.set("addressdetails","1");
    const r = await fetch(u, { headers:{ "Accept":"application/json" } });
    if(!r.ok) continue;
    const d = await r.json(); const ad = d.address||{};
    const place = ad.city || ad.town || ad.village || ad.hamlet || ad.suburb || ad.neighbourhood || null;
    if(!place) continue;
    if(/(school|station|memorial|incident|murder|academy|college|campus)/i.test(place)) continue;
    nameCache.set(key, place); return place;
  }
  nameCache.set(key, null); return null;
}

async function runSearch(){
  setLoading(true); resultsEl.innerHTML=""; top3El.innerHTML="";
  try{
    statusEl.textContent="Getting your location…";
    const pos = await new Promise((res,rej)=> navigator.geolocation.getCurrentPosition(res,rej,{enableHighAccuracy:true,timeout:12000}));
    const origin = { lat:pos.coords.latitude, lon:pos.coords.longitude };
    const radiusMi = Number(document.getElementById('radiusMi').value);
    const limit = Number(document.getElementById('limit').value);
    const interest = document.getElementById('interest').value;

    // For stability, use grid always in 5.5.2
    const candidates = makeGrid(origin, radiusMi);

    const results=[];
    for(const p of candidates){
      const [wx, name] = await Promise.all([ fetchNowAndHourly(p.lat,p.lon), settlementName(p.lat,p.lon) ]);
      if(!name) continue;
      const win = sunshineWindow(wx.next);
      const isSunny = (wx.current.cloud_cover<=45 && wx.current.precipitation<0.2 && wx.current.shortwave_radiation>=80);
      const distMi = havKm(origin, p)*KM_TO_MI;
      const brg = bearingDeg(origin, p);
      results.push({ lat:p.lat, lon:p.lon, place:name, current:wx.current, isSunny, sunnyMinutes:win.minutes, sunnyUntil:win.until, distMi, bearing:brg });
      if(results.length >= limit*2) break;
    }

    // sort by longest sunshine then distance
    results.sort((a,b)=> (b.sunnyMinutes - a.sunnyMinutes) || (a.distMi - b.distMi));
    const slice = results.slice(0, limit);

    if(!slice.length){ statusEl.textContent="No perfect sun right now — showing nearby best weather."; }
    else { statusEl.textContent=`Best weather within ${radiusMi} miles.`; }

    render(slice, origin);
  }catch(e){
    console.error(e); statusEl.textContent="Search failed. Please allow location and try again.";
  }finally{ setLoading(false); }
}
document.getElementById('go').addEventListener('click', runSearch);

function render(list, origin){
  resultsEl.innerHTML=""; spotsLayer.clearLayers(); top3El.innerHTML="";
  if(!userMarker){ userMarker=L.marker([origin.lat,origin.lon]).addTo(spotsLayer); } else userMarker.setLatLng([origin.lat,origin.lon]);
  const group=[userMarker];

  // top 3
  list.slice(0,3).forEach((r,idx)=>{
    const mins=r.sunnyMinutes; const until=r.sunnyUntil? new Date(r.sunnyUntil).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '—';
    const d=document.createElement('div'); d.className='topCard';
    d.innerHTML=`<h4>${idx+1}. ${r.place}</h4>
      <div class="row">
      <span class="pill ${r.isSunny?'ok':'warn'}">${r.isSunny?'Sunny now':'Sun may vary'}</span>
      <span class="pill">Sunny for ${Math.floor(mins/60)}h ${mins%60? (mins%60+'m'):''} ${until!=='—'?`(until ${until})`:''}</span>
      <span class="pill">${fmt(r.distMi)} mi</span>
      </div>`;
    top3El.appendChild(d);
  });

  list.forEach((r,idx)=>{
    const mins=r.sunnyMinutes; const until=r.sunnyUntil? new Date(r.sunnyUntil).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '—';
    const card=document.createElement('div'); card.className='card';
    card.innerHTML=`<h3>${idx+1}. ${r.place}</h3>
      <div class="row">
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
