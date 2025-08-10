
/* == Sun Finder v5.6.0 enhancements == */
(function(){
  const GA_ID = "G-P8LS80EHNZ";
  const CONSENT_KEY = "sf_analytics_consent";

  function loadGA(){
    if (window.gtag) return;
    const s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + GA_ID;
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    function gtag(){ dataLayer.push(arguments); }
    window.gtag = gtag;
    gtag('js', new Date());
    gtag('config', GA_ID, { anonymize_ip: true });
  }

  // Consent banner
  const banner = document.getElementById('consent-banner');
  const acceptBtn = document.getElementById('consent-accept');
  const declineBtn = document.getElementById('consent-decline');
  const stored = localStorage.getItem(CONSENT_KEY);
  if (banner && stored == null) {
    banner.hidden = false;
  } else if (stored === "accepted") {
    loadGA();
  }
  acceptBtn && acceptBtn.addEventListener('click', ()=>{
    localStorage.setItem(CONSENT_KEY, "accepted");
    banner.hidden = true;
    loadGA();
  });
  declineBtn && declineBtn.addEventListener('click', ()=>{
    localStorage.setItem(CONSENT_KEY, "declined");
    banner.hidden = true;
  });

  // Manual location modal
  const manual = document.getElementById('manual-location');
  const manualInput = document.getElementById('manual-input');
  const manualGo = document.getElementById('manual-go');
  function showManual(){ if (manual) manual.hidden = false; manualInput && manualInput.focus(); }
  function hideManual(){ if (manual) manual.hidden = true; }

  function parseLatLon(text){
    if (!text) return null;
    const m = text.trim().match(/^\s*([-+]?\d{1,2}\.\d+|[-+]?\d{1,2})\s*,\s*([-+]?\d{1,3}\.\d+|[-+]?\d{1,3})\s*$/);
    if (!m) return null;
    const lat = parseFloat(m[1]);
    const lon = parseFloat(m[2]);
    if (isNaN(lat) || isNaN(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return { lat, lon };
  }

  manualGo && manualGo.addEventListener('click', ()=>{
    const p = parseLatLon(manualInput.value);
    const statusEl = document.getElementById('status');
    if (!p){
      statusEl && (statusEl.textContent = "Please enter coordinates as ‘lat, lon’.");
      return;
    }
    hideManual();
    // Kick off search using provided coordinates
    if (typeof runSearchWithOrigin === 'function') {
      runSearchWithOrigin(p);
    } else if (typeof runSearch === 'function') {
      // Fallback: if app expects to set a global origin, we can monkey-patch.
      window.__SF_ORIGIN_OVERRIDE__ = p;
      runSearch();
    }
  });

  // Patch geolocation error handling (requires runSearch to call getCurrentPosition or similar)
  window.__sfHandleGeoError = function(err){
    const statusEl = document.getElementById('status');
    let msg = "Location unavailable. You can enter coordinates manually.";
    if (err && typeof err.code === "number") {
      if (err.code === 1) msg = "Permission denied. Please allow location or enter coordinates manually.";
      else if (err.code === 2) msg = "Position unavailable from your device. Enter coordinates manually.";
      else if (err.code === 3) msg = "Timed out trying to get your location. Enter coordinates manually.";
    }
    statusEl && (statusEl.textContent = msg);
    showManual();
  };

  // Keep-results-on-refresh hint
  window.__sfRefreshing = function(){
    const statusEl = document.getElementById('status');
    statusEl && (statusEl.textContent = "Refreshing results…");
  };
})();

// Sun Finder v5.6.0 — spinner, 60‑mile toast cap, progressive loading, activities dropdown, dedupe, no-water pins
let map, spotsLayer, userMarker;
const resultsEl = document.getElementById('results');
const statusEl = document.getElementById('status');
const top3El = document.getElementById('top3');
const toastEl = document.getElementById('toast');

const btn = document.getElementById('go');
const ob = document.getElementById('onboard');
document.getElementById('help').addEventListener('click',()=> ob.classList.add('show'));
document.getElementById('closeOb').addEventListener('click',()=> ob.classList.remove('show'));
window.addEventListener('keydown',(e)=>{ if(e.key==='Escape') ob.classList.remove('show'); });

const MI_TO_KM = 1.609344, KM_TO_MI = 0.621371;
function fmt(n){ return Math.round(n); }
function toRad(d){ return d*Math.PI/180; } function toDeg(r){ return r*180/Math.PI; }
function showToast(msg){ toastEl.textContent = msg; toastEl.classList.add('show'); setTimeout(()=> toastEl.classList.remove('show'), 2000); }

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
const weatherCache = new Map(); // memory
function cellKey(lat, lon){ return `${lat.toFixed(2)},${lon.toFixed(2)}`; } // ~2km
async function fetchNowAndHourly(lat, lon, signal){
  const key = cellKey(lat, lon);
  if(weatherCache.has(key)) return weatherCache.get(key);
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
  const out = { current: data.current, next };
  weatherCache.set(key, out);
  return out;
}
function isSunnyLike(cc, sw, pr){ return (cc<=45)&&(pr<0.25)&&(sw>=70); } // slightly relaxed
function sunshineWindow(next){
  let minutes=0, until=null;
  for(let i=0;i<next.time.length;i++){
    const ok = isSunnyLike(next.cloud[i], next.sw[i], next.pr[i]);
    if(ok){ minutes += 60; until = next.time[i]; } else { if(minutes>0) break; }
  }
  return { minutes, until };
}

// ===== Settlements via Nominatim (strict) =====
const nameCache = new Map();
const WATER_RE = /(sea|ocean|bay|firth|channel|loch|estuary|gulf|sound|harbour|harbor|marina|water)/i;
function normName(s){ return (s||"").toLowerCase().replace(/^city of\s+/,'').replace(/\s*,?\s*(scotland|england|wales|northern ireland)$/,'').trim(); }
async function settlementName(lat, lon){
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if(nameCache.has(key)) return nameCache.get(key);
  for(const zoom of [14,12,10,8]){
    const u = new URL("https://nominatim.openstreetmap.org/reverse");
    u.searchParams.set("lat", lat); u.searchParams.set("lon", lon);
    u.searchParams.set("format","jsonv2"); u.searchParams.set("zoom", String(zoom)); u.searchParams.set("addressdetails","1");
    const r = await fetch(u, { headers:{ "Accept":"application/json" } });
    if(!r.ok) continue;
    const d = await r.json();
    const ad = d.address || {};
    const place = ad.city || ad.town || ad.village || ad.hamlet || ad.suburb || ad.neighbourhood || null;
    if(!place) continue;
    if(WATER_RE.test(place)) continue;
    nameCache.set(key, place);
    return place;
  }
  nameCache.set(key, null);
  return null;
}

// ===== Interest candidates (fast) =====
function makeGrid(origin, radiusMi){
  const radiusKm = Math.min(radiusMi, 60)*MI_TO_KM;
  const rings=[]; const stepKm=Math.max(10, Math.min(16, radiusKm/3));
  for(let d=10; d<=radiusKm; d+=stepKm) rings.push(d);
  const bearings = Array.from({length: 12}, (_,i)=> i*30);
  const pts=[]; const seen=new Set();
  for(const d of rings){ for(const b of bearings){ const p=offsetPoint(origin.lat, origin.lon, b, d);
    const key=`${p.lat.toFixed(2)},${p.lon.toFixed(2)}`; if(seen.has(key)) continue; seen.add(key); pts.push(p); } }
  return pts.slice(0, 30);
}
function offsetPoint(lat, lon, bDeg, distKm){ const R=6371.0088,b=toRad(bDeg),dR=distKm/R;
  const lat1=toRad(lat),lon1=toRad(lon);
  const lat2=Math.asin(Math.sin(lat1)*Math.cos(dR)+Math.cos(lat1)*Math.sin(dR)*Math.cos(b));
  const lon2=lon1+Math.atan2(Math.sin(b)*Math.sin(dR)*Math.cos(lat1),Math.cos(dR)-Math.sin(lat1)*Math.cos(lat2));
  return {lat:toDeg(lat2),lon:((toDeg(lon2)+540)%360)-180}; }

// Activities (fallback: Wikipedia geosearch)
async function fetchActivities(lat, lon, interest){
  const url = `https://en.wikipedia.org/w/api.php?origin=*&action=query&list=geosearch&gsradius=10000&gslimit=30&format=json&gscoord=${lat}%7C${lon}`;
  try{
    const r = await fetch(url); if(!r.ok) return [];
    const d = await r.json();
    const titles = (d?.query?.geosearch||[]).map(x=> x.title).filter(Boolean);
    // crude interest filter
    const kw = {
      beach:['beach','bay','coast','sand'],
      nature_reserve:['reserve','park','forest','trail','moor','nature'],
      lake:['lake','loch','reservoir','mere','tarn'],
      theme_park:['theme park','amusement','rides'],
      historic:['castle','abbey','cathedral','monument','ruins','fort'],
      scenic_view:['view','viewpoint','scenic','lookout'],
      park:['park','playground','greenspace','common'],
      zoo:['zoo','aquarium','wildlife']
    }[interest] || [];
    const filtered = kw.length ? titles.filter(t=> kw.some(k=> t.toLowerCase().includes(k))) : titles;
    return filtered.slice(0,5);
  }catch{ return []; }
}

// ===== Progressive search =====
async function runSearch(){
  setLoading(true); resultsEl.innerHTML=""; top3El.innerHTML=""; spotsLayer.clearLayers();
  const radiusInput = document.getElementById('radiusMi');
  let radiusMi = Number(radiusInput.value)||40;
  if(radiusMi>60){ radiusMi=60; radiusInput.value=60; showToast("Max search radius is 60 miles for faster results."); }
  const limit = Number(document.getElementById('limit').value)||12;
  const interest = document.getElementById('interest').value||'any';

  try{
    statusEl.textContent="Getting your location…";
    const pos = await new Promise((res,rej)=> navigator.geolocation.getCurrentPosition(res,rej,{enableHighAccuracy:true,timeout:12000}));
    const origin = { lat:pos.coords.latitude, lon:pos.coords.longitude };

    if(!userMarker){ userMarker=L.marker([origin.lat,origin.lon]).addTo(spotsLayer); } else userMarker.setLatLng([origin.lat,origin.lon]);
    map.setView([origin.lat,origin.lon], 9);

    statusEl.textContent="Scanning nearby weather…";
    const candidates = [{lat:origin.lat,lon:origin.lon,here:true}].concat(makeGrid(origin, radiusMi));
    const firstWave = candidates.slice(0, 25); // fast
    const rest = candidates.slice(25);

    const accepted = []; // final results
    const nameSeen = new Set();
    const minSepKm = 1.0;

    // helper to accept a result with de-dupe + cluster
    function tryAccept(obj){
      const nkey = normName(obj.place);
      if(nameSeen.has(nkey)) return false;
      for(const a of accepted){
        const d = havKm({lat:obj.lat,lon:obj.lon},{lat:a.lat,lon:a.lon});
        if(d < minSepKm) return false;
      }
      nameSeen.add(nkey); accepted.push(obj); return true;
    }

    // renderer (progressive)
    function renderAll(){
      // sort by sunnyMinutes desc, then distance
      accepted.sort((a,b)=> (b.sunnyMinutes-a.sunnyMinutes) || (a.distMi-b.distMi) || a.place.localeCompare(b.place));
      // Top 3
      top3El.innerHTML="";
      accepted.slice(0,3).forEach((r,idx)=>{
        const mins=r.sunnyMinutes, until=r.sunnyUntil? new Date(r.sunnyUntil).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '—';
        const div = document.createElement('div'); div.className='topCard';
        div.innerHTML = `<h4>${idx+1}. ${r.place}</h4>
        <div class="row">
          <span class="pill ${r.isSunny?'ok':'warn'}">${r.isSunny?'Sunny now':'Sun may vary'}</span>
          <span class="pill">Sunny for ${Math.floor(mins/60)}h ${mins%60? (mins%60+'m'):''} ${until!=='—'?`(until ${until})`:''}</span>
          <span class="pill">${fmt(r.distMi)} mi ${bearingToCardinal(r.bearing)}</span>
        </div>`;
        top3El.appendChild(div);
      });
      // List
      resultsEl.innerHTML="";
      accepted.forEach((r, idx)=>{
        const mins=r.sunnyMinutes, until=r.sunnyUntil? new Date(r.sunnyUntil).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '—';
        const card = document.createElement('div'); card.className='card';
        const catBadge = interest!=='any' ? `<span class="pill ok">✓ ${interest.replace('_',' ')}</span>` : '';
        const actId = `acts-${idx}`;
        card.innerHTML = `<h3>${idx+1}. ${r.place}</h3>
          <div class="row">
            ${catBadge}
            <span class="pill ${r.isSunny?'ok':'warn'}">${r.isSunny?'Sunny now':'Sun may vary'}</span>
            <span class="pill">Temp ${fmt(r.current.temperature_2m)}°C</span>
            <span class="pill">Sunny for ${Math.floor(mins/60)}h ${mins%60? (mins%60+'m'):''} ${until!=='—'?`(until ${until})`:''}</span>
            <span class="pill">${fmt(r.distMi)} mi ${bearingToCardinal(r.bearing)}</span>
            <a class="pill" href="https://maps.google.com/?q=${r.lat},${r.lon}" target="_blank" rel="noopener">Open in Maps</a>
            <button class="toggle" data-target="${actId}">Things to do ▾</button>
          </div>
          <div id="${actId}" class="activities"></div>`;
        resultsEl.appendChild(card);
      });
      // markers
      spotsLayer.clearLayers();
      const group=[L.marker([origin.lat,origin.lon]).addTo(spotsLayer)];
      accepted.forEach((r, idx)=>{
        const m=L.circleMarker([r.lat,r.lon],{radius:7,weight:2,color:r.isSunny?'#22c55e':'#f59e0b'})
          .bindPopup(`<b>${idx+1}. ${r.place}</b><br>Sunny for ${Math.floor(r.sunnyMinutes/60)}h ${r.sunnyMinutes%60? (r.sunnyMinutes%60+'m'):''}${r.sunnyUntil?` (until ${new Date(r.sunnyUntil).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})})`:''}`)
          .addTo(spotsLayer);
        group.push(m);
      });
      if(accepted.length){ const b=L.featureGroup(group).getBounds().pad(0.2); map.fitBounds(b); }

      // wire toggles for activities
      document.querySelectorAll('.toggle').forEach(btn=>{
        btn.onclick = async (e)=>{
          const id = e.currentTarget.getAttribute('data-target');
          const box = document.getElementById(id);
          if(box.dataset.loaded==='1'){ box.classList.toggle('show'); return; }
          box.textContent = 'Loading things to do…';
          const idx = Array.from(document.querySelectorAll('.toggle')).indexOf(e.currentTarget);
          const r = accepted[idx];
          const acts = await fetchActivities(r.lat, r.lon, interest);
          const mapsLink = `https://www.google.com/maps/search/Attractions/@${r.lat},${r.lon},12z`;
          if(acts.length){
            box.innerHTML = `<ul>${acts.map(a=> `<li>${a}</li>`).join('')}</ul><div class="row" style="margin-top:6px"><a class="pill" href="${mapsLink}" target="_blank" rel="noopener">More on Google Maps</a></div>`;
          }else{
            box.innerHTML = `<div class="row"><span class="pill">No curated items found — try Maps</span><a class="pill" href="${mapsLink}" target="_blank" rel="noopener">Open Google Maps</a></div>`;
          }
          box.dataset.loaded='1'; box.classList.add('show');
        };
      });
    }

    // process a batch with limited concurrency and progressive render
    async function processBatch(batch){
      const controller = new AbortController();
      const tasks = batch.map(p=> (async()=>{
        try{
          const name = p.here ? 'Your location' : await settlementName(p.lat, p.lon);
          if(!name) return;
          const {current, next} = await fetchNowAndHourly(p.lat, p.lon, controller.signal);
          const win = sunshineWindow(next);
          const isSunny = (current.cloud_cover<=35 && current.precipitation<0.15 && current.shortwave_radiation>=90);
          const distMi = havKm(origin, p)*KM_TO_MI;
          const brg = bearingDeg(origin, p);
          const obj = { ...p, place:name, current, isSunny, sunnyMinutes:win.minutes, sunnyUntil:win.until, distMi, bearing:brg };
          if(tryAccept(obj)){
            renderAll(); // progressive update
          }
        }catch(e){ /* ignore individual failures */ }
      })());
      await Promise.all(tasks);
    }

    // first wave (fast, 10 results if possible)
    await processBatch(firstWave);
    if(accepted.length < 10){
      await processBatch(rest);
    }

    statusEl.textContent = accepted.length ? `Showing best options within ${radiusMi} miles.` : `No perfect sun right now — showing best weather nearby.`;
  }catch(e){
    console.error(e);
    statusEl.textContent="Search failed. Please allow location and try again.";
  }finally{
    setLoading(false);
  }
}
document.getElementById('go').addEventListener('click', runSearch);


/* Public helper to run search with a provided origin {lat, lon} */
function runSearchWithOrigin(origin){
  try{
    window.__sfRefreshing && window.__sfRefreshing();
  }catch(_){}
  if (typeof runSearch === 'function' && origin && typeof origin.lat === 'number' && typeof origin.lon === 'number'){
    // If the app supports an override, set it
    window.__SF_ORIGIN_OVERRIDE__ = origin;
    runSearch();
  }
}

/* Fallback: global error forwarder if geolocation fails elsewhere */
function onGeolocationError(err){
  if (window.__sfHandleGeoError) window.__sfHandleGeoError(err);
}
