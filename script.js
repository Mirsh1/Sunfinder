// Sun Finder — Patched build (location fallbacks, concurrency, strict interest filtering via Overpass, abortable searches)
// This file is safe to require() in Node for tests. Browser init only runs when window/document are present.

(function(global){
  'use strict';

  // ---------------- Utilities ----------------
// ---- Affiliate (Amazon) ----
const AFFIL = {
  tag: "mirsh-21",
  domain: "amazon.co.uk",
};

// One hand-picked UK product per interest (you can change these URLs anytime)
const INTEREST_LINKS = {
  theme_park: {
    label: "Portable Power Bank – keep your phone alive in the queues",
    url: "https://www.amazon.co.uk/dp/B0B8X9YVZN"
  },
  beach: {
    label: "Sand-Free Microfibre Beach Towel",
    url: "https://www.amazon.co.uk/dp/B07G4J6H83"
  },
  nature_reserve: {
    label: "Lightweight Waterproof Daypack",
    url: "https://www.amazon.co.uk/dp/B08C5HYWP5"
  },
  lake: {
    label: "Quick-Dry Travel Towel",
    url: "https://www.amazon.co.uk/dp/B07KXBL1T3"
  },
  scenic_view: {
    label: "Compact Travel Binoculars",
    url: "https://www.amazon.co.uk/dp/B07R16K47X"
  },
  park: {
    label: "Reusable Stainless Steel Water Bottle",
    url: "https://www.amazon.co.uk/dp/B07Q5W4L1V"
  },
  historic: {
    label: "Windproof Compact Umbrella",
    url: "https://www.amazon.co.uk/dp/B08D6XPL5V"
  },
  zoo: {
    label: "Mini Sunscreen Stick SPF50",
    url: "https://www.amazon.co.uk/dp/B07PYF1V8D"
  }
};

function tagAmazonUrl(raw, tag=AFFIL.tag) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    u.hostname = AFFIL.domain || u.hostname;
    u.searchParams.set("tag", tag);
    return u.toString();
  } catch { return null; }
}

function renderAffiliate(interest){
  // Choose a product:
  // - If specific interest has a product, use it.
  // - If 'any' (or unknown), rotate randomly across all interest products.
  const entries = Object.entries(INTEREST_LINKS);
  let linkDef = null;
  if (interest && INTEREST_LINKS[interest]) {
    linkDef = INTEREST_LINKS[interest];
  } else {
    const idx = Math.floor(Math.random() * entries.length);
    linkDef = entries[idx][1];
  }
  if (!linkDef || !linkDef.url) return;
  const url = tagAmazonUrl(linkDef.url);
  if (!url) return;

  const mount = document.getElementById("affiliate");
  if (!mount) return;

  mount.innerHTML = `
    <div class="aff-card">
      <div class="aff-title">Heading out?</div>
      <div class="aff-body">
        <a href="${url}" target="_blank" rel="nofollow sponsored noopener">${linkDef.label}</a>
      </div>
      <div class="aff-disclosure">Disclosure: As an Amazon Associate, we earn from qualifying purchases.</div>
    </div>
  `;
}

  const KM_PER_MI = 1.609344;
  const R_EARTH_KM = 6371.0088;

  function toRad(d){ return d * Math.PI / 180; }
  function toDeg(r){ return r * 180 / Math.PI; }

  function haversineKm(a, b){
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const sinDLat = Math.sin(dLat/2), sinDLon = Math.sin(dLon/2);
    const h = sinDLat*sinDLat + Math.cos(lat1)*Math.cos(lat2)*sinDLon*sinDLon;
    return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function bearingToCardinal(b){
    const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
    return dirs[Math.round((((b % 360)+360)%360) / 22.5) % 16];
  }

  // Toast + loading helpers are no-ops in Node
  let toastEl = null, btn = null;
  function showToast(msg){
    if(!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    setTimeout(()=> toastEl.classList.remove("show"), 3200);
  }
  function setLoading(on){
    if(!btn) return;
    if(on){ btn.classList.add('loading'); btn.disabled = true; }
    else { btn.classList.remove('loading'); btn.disabled = false; }
  }

  // Simple promise timeout
  function withTimeout(promise, ms, label="request"){
    const t = new Promise((_, rej)=> setTimeout(()=> rej(new Error(label+" timeout")), ms));
    return Promise.race([promise, t]);
  }

  // Concurrency limiter
  function pLimit(n){
    let active=0, queue=[];
    const next=()=>{ active--; if(queue.length) queue.shift()(); };
    return (fn)=> new Promise((res, rej)=>{
      const run = ()=>{
        active++;
        fn().then(v=>{ res(v); next(); }, e=>{ rej(e); next(); });
      };
      active < n ? run() : queue.push(run);
    });
  }
  const limit8 = pLimit(8);

  // Grid of candidate points around origin (km radius)
  function makeGrid(origin, radiusMi){
    const radiusKm = Math.max(10, Math.min(60*KM_PER_MI, radiusMi*KM_PER_MI));
    const ringStepKm = 10; // distance between rings
    const bearings = [];
    for(let b=0;b<360;b+=15) bearings.push(b);
    const points = [];
    for(let r=ringStepKm; r<=radiusKm; r+=ringStepKm){
      for(const b of bearings){
        points.push(destPoint(origin.lat, origin.lon, r, b));
      }
    }
    return points;
  }
  function destPoint(lat, lon, distKm, bearingDeg){
    const b = toRad(bearingDeg);
    const dR = distKm / R_EARTH_KM;
    const lat1 = toRad(lat), lon1 = toRad(lon);
    const lat2 = Math.asin(Math.sin(lat1)*Math.cos(dR) + Math.cos(lat1)*Math.sin(dR)*Math.cos(b));
    const lon2 = lon1 + Math.atan2(Math.sin(b)*Math.sin(dR)*Math.cos(lat1), Math.cos(dR)-Math.sin(lat1)*Math.cos(lat2));
    return { lat: toDeg(lat2), lon: (((toDeg(lon2)+540)%360)-180) };
  }

  // ---------------- Weather ----------------
  const weatherCache = new Map(); // cellKey -> { current, next }
  function cellKey(lat, lon){ return `${lat.toFixed(2)},${lon.toFixed(2)}`; } // ~2km

  async function fetchNowAndHourly(lat, lon, signal){
    const key = cellKey(lat, lon);
    if(weatherCache.has(key)) return weatherCache.get(key);

    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", lat.toFixed(3));
    url.searchParams.set("longitude", lon.toFixed(3));
    url.searchParams.set("current","temperature_2m,precipitation,cloud_cover,shortwave_radiation,is_day");
    url.searchParams.set("hourly","cloud_cover,shortwave_radiation,precipitation,temperature_2m");
    url.searchParams.set("forecast_days","1");
    url.searchParams.set("timezone","auto");

    const attempt = async ()=>{
      const res = await withTimeout(fetch(url.toString(), { signal }), 9000, "weather");
      if(!res.ok) throw new Error("weather "+res.status);
      const data = await res.json();
      const nowISO = data.current.time;
      const idx = data.hourly.time.indexOf(nowISO);
      const from = (idx>=0) ? idx+1 : 0;
      const out = {
        current: data.current,
        next: {
          time: data.hourly.time.slice(from, from+12),
          cloud: data.hourly.cloud_cover.slice(from, from+12),
          sw: data.hourly.shortwave_radiation.slice(from, from+12),
          pr: data.hourly.precipitation.slice(from, from+12),
          temp: data.hourly.temperature_2m.slice(from, from+12),
        }
      };
      weatherCache.set(key, out);
      return out;
    };

    try { return await attempt(); }
    catch { return await attempt(); } // one retry
  }

  function isSunnyLike(cc, sw, pr){ return (cc <= 45) && (pr < 0.25) && (sw >= 70); }
  function sunshineWindow(next){
    let minutes=0, until=null;
    for(let i=0;i<next.time.length;i++){
      const ok = isSunnyLike(next.cloud[i], next.sw[i], next.pr[i]);
      if(ok){ minutes += 60; until = next.time[i]; } else if(minutes>0){ break; }
    }
    return { minutes, until };
  }

  // ---------------- Interests (OSM Overpass) ----------------
  const INTEREST_TAGS = {
    beach: [{ key: "natural", val: "beach" }],
    nature_reserve: [{ key: "leisure", val: "nature_reserve" }, { key: "boundary", val: "protected_area" }],
    lake: [{ key: "natural", val: "water" }, { key: "water", val: "lake" }],
    theme_park: [{ key: "tourism", val: "theme_park" }, { key: "attraction", val: "theme_park" }],
    historic: [{ key: "historic" }],
    scenic_view: [{ key: "tourism", val: "viewpoint" }],
    park: [{ key: "leisure", val: "park" }],
    zoo: [{ key: "tourism", val: "zoo" }, { key: "tourism", val: "aquarium" }],
  };

  function buildOverpassQL(lat, lon, radiusMeters, interest){
    const tags = INTEREST_TAGS[interest];
    if(!tags) return null;
    const ors = tags.map(t => {
      if(t.val){
        return `node["${t.key}"="${t.val}"](around:${radiusMeters},${lat},${lon});way["${t.key}"="${t.val}"](around:${radiusMeters},${lat},${lon});rel["${t.key}"="${t.val}"](around:${radiusMeters},${lat},${lon});`;
      }
      return `node["${t.key}"](around:${radiusMeters},${lat},${lon});way["${t.key}"](around:${radiusMeters},${lat},${lon});rel["${t.key}"](around:${radiusMeters},${lat},${lon});`;
    }).join("");
    return `[out:json][timeout:25];(${ors});out center 30;`;
  }

  async function fetchActivities(lat, lon, interest, radiusMeters=20000, signal){
    const ql = buildOverpassQL(lat, lon, radiusMeters, interest);
    if(!ql) return [];
    const res = await withTimeout(fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: ql,
      signal
    }), 12000, "overpass");
    if(!res.ok) return [];
    const data = await res.json();
    const els = data.elements || [];
    return els.map(el => {
      const c = el.center || { lat: el.lat, lon: el.lon };
      const name = (el.tags && (el.tags.name || el.tags["name:en"] || el.tags.brand)) || "Unnamed";
      return { name, lat: c.lat, lon: c.lon };
    }).slice(0, 8);
  }

  // ---------------- Location (robust, cached, manual fallback) ----------------
  async function getOrigin(){
    // 1) High accuracy quick
    try {
      const pos = await new Promise((res, rej)=>
        navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 8000 })
      );
      const o = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      try { localStorage.setItem("origin", JSON.stringify(o)); } catch {}
      return o;
    } catch {}

    // 2) Standard accuracy
    try {
      const pos = await new Promise((res, rej)=>
        navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: false, timeout: 15000 })
      );
      const o = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      try { localStorage.setItem("origin", JSON.stringify(o)); } catch {}
      return o;
    } catch {}

    // 3) Last good
    try {
      const cached = localStorage.getItem("origin");
      if(cached) return JSON.parse(cached);
    } catch {}

    // 4) Manual
    const q = typeof prompt !== "undefined" ? prompt("Type your town/city:") : null;
    if(q){
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}`);
      const hit = (await r.json())[0];
      if(hit){
        const o = { lat: +hit.lat, lon: +hit.lon };
        try { localStorage.setItem("origin", JSON.stringify(o)); } catch {}
        return o;
      }
    }
    throw new Error("Location unavailable");
  }

  // ---------------- Rendering (browser only) ----------------
  function formatTimeISO(iso){
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    } catch { return "—"; }
  }

  // ---------------- Search orchestration ----------------
  let currentSearch = null;

  async function runSearch(){
    if(typeof document === "undefined") return; // Node
    if(currentSearch) currentSearch.abort();
    const controller = new AbortController();
    currentSearch = controller;

    const resultsEl = document.getElementById('results');
    const top3El = document.getElementById('top3');
    const statusEl = document.getElementById('status');
    const spotsLayer = global.spotsLayer; // created in init
    resultsEl.innerHTML = ""; top3El.innerHTML = ""; if(spotsLayer) spotsLayer.clearLayers();

    // inputs
    const radiusInput = document.getElementById('radiusMi');
    let radiusMi = Number(radiusInput?.value)||40;
    if(radiusMi > 60){ radiusMi = 60; if(radiusInput) radiusInput.value = 60; showToast("Max search radius is 60 miles for faster results."); }
    const limit = Number(document.getElementById('limit')?.value)||12;
    const interest = (document.getElementById('interest')?.value)||'any';

    try {
      setLoading(true);
      statusEl.textContent = "Getting your location…";
      const origin = await getOrigin();

      // mark user + center map
      if(global.map && global.L){
        if(!global.userMarker){
          global.userMarker = L.marker([origin.lat, origin.lon], { title: "You" }).addTo(global.spotsLayer);
        } else {
          global.userMarker.setLatLng([origin.lat, origin.lon]);
        }
        global.map.setView([origin.lat, origin.lon], 9);
      }

      statusEl.textContent = "Scanning nearby weather…";
      const candidates = [{ lat: origin.lat, lon: origin.lon, here: true }].concat(makeGrid(origin, radiusMi));
      const batches = candidates.map(c => () => fetchNowAndHourly(c.lat, c.lon, controller.signal).then(w => ({...c, weather: w})));
      const data = await Promise.all(batches.map(fn => limit8(fn)));

      // evaluate & filter
      const accepted = [];
      for(const c of data){
        if(!c || !c.weather) continue;
        const sunny = sunshineWindow(c.weather.next);
        if(sunny.minutes === 0) continue; // not sunny; skip
        let activities = [];
        if(interest !== "any"){
          activities = await fetchActivities(c.lat, c.lon, interest, 20000, controller.signal);
          if(!activities.length) continue; // require interest near
        }
        const distMi = haversineKm({lat:origin.lat, lon:origin.lon}, {lat:c.lat, lon:c.lon}) / KM_PER_MI;
        accepted.push({
          lat: c.lat, lon: c.lon,
          distMi: distMi,
          place: `${c.here ? "Your area" : "Spot"} (${distMi.toFixed(1)} mi ${bearingToCardinal(bearingBetween(origin, c))})`,
          sunnyMinutes: sunny.minutes,
          sunnyUntil: sunny.until,
          activities: activities
        });
        if(accepted.length >= limit) break;
      }

      // sort
      accepted.sort((a,b)=> (b.sunnyMinutes - a.sunnyMinutes) || (a.distMi - b.distMi));

      // render
      if(global.L && global.spotsLayer){
        const group = [];
        accepted.forEach((r, idx)=>{
          const m = L.circleMarker([r.lat, r.lon], { radius:7, weight:2 })
            .bindPopup(`<b>${idx+1}. ${escapeHtml(r.place)}</b><br>Sunny for ${r.sunnyMinutes} min${r.sunnyUntil?` (until ${formatTimeISO(r.sunnyUntil)})`:''}<br>${r.distMi.toFixed(1)} mi away`)
            .addTo(global.spotsLayer);
          group.push(m);
        });
        if(group.length){
          const b = L.featureGroup(group).getBounds().pad(0.2);
          global.map.fitBounds(b);
        }
      }

      // top3 cards
      top3El.innerHTML = "";
      accepted.slice(0,3).forEach((r, idx)=>{
        const card = document.createElement('div');
        card.className = "card top";
        card.innerHTML = `<div class="title">${idx+1}. ${escapeHtml(r.place)}</div>
          <div class="meta">Sunny for ${r.sunnyMinutes} min ${r.sunnyUntil?`(until ${formatTimeISO(r.sunnyUntil)})`:''}</div>`;
        top3El.appendChild(card);
      });

      // results list
      resultsEl.innerHTML = "";
      accepted.forEach((r, idx)=>{
        const id = `acts-${idx}`;
        const acts = r.activities && r.activities.length ?
          `<button class="toggle" data-target="${id}">Show ${r.activities.length} ${interest.replace('_',' ')} spots</button>
           <div id="${id}" class="activities">${r.activities.map(a=> `<div class="poi">${escapeHtml(a.name)}</div>`).join("")}</div>`
          : '';

        const el = document.createElement('div');
        el.className = "card";
        el.innerHTML = `<div class="title">${idx+1}. ${escapeHtml(r.place)}</div>
          <div class="meta">${r.distMi.toFixed(1)} mi • Sunny for ${r.sunnyMinutes} min ${r.sunnyUntil?`(until ${formatTimeISO(r.sunnyUntil)})`:''}</div>
          ${acts}`;
        resultsEl.appendChild(el);
      });

      // wire toggles
      document.querySelectorAll('.toggle').forEach(b=>{
        b.onclick = (e)=>{
          const id = e.currentTarget.getAttribute('data-target');
          const box = document.getElementById(id);
          if(!box) return;
          box.classList.toggle('open');
          b.textContent = box.classList.contains('open') ? "Hide spots" : b.textContent.replace(/^Show/, "Show");
        };
      });

      statusEl.textContent = accepted.length ? `Showing ${accepted.length} sunny ${interest.replace('_',' ')} result(s).` : `No perfect sun right now.`;
    } catch (e){
      console.error(e);
      const statusEl = document.getElementById('status');
      statusEl.textContent = "Search failed. Please allow location and try again.";
      showToast(e.message || "Search failed.");
    } finally {
      if(currentSearch === controller) currentSearch = null;
      setLoading(false);
    }
  }

  function bearingBetween(a, b){
    const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
    const dLon = toRad(b.lon - a.lon);
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1)*Math.cos(lat2)*Math.cos(dLon) - Math.sin(lat1)*Math.sin(lat2);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

  // ---------------- Browser init ----------------
  function initBrowser(){
    if(typeof document === "undefined" || typeof window === "undefined") return;

    // cache UI elements
    toastEl = document.getElementById('toast');
    btn = document.getElementById('go');

    // Persist inputs
    try {
      const radiusInput = document.getElementById('radiusMi');
      const interestSel = document.getElementById('interest');
      if(localStorage.getItem("radiusMi")) radiusInput.value = localStorage.getItem("radiusMi");
      if(localStorage.getItem("interest")) interestSel.value = localStorage.getItem("interest");
      radiusInput.addEventListener('change', ()=> localStorage.setItem("radiusMi", radiusInput.value));
      interestSel.addEventListener('change', ()=> localStorage.setItem("interest", interestSel.value));
    } catch {}

    // Map
    if(window.L){
      const tile = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
      global.map = L.map('map').setView([55, -2], 6);
      L.tileLayer(tile, { maxZoom: 18, attribution: '&copy; OpenStreetMap' }).addTo(global.map);
      global.spotsLayer = L.layerGroup().addTo(global.map);
    }

    document.getElementById('go')?.addEventListener('click', runSearch);
  }

  // Run init in browser
  if(typeof window !== "undefined"){
    if(document.readyState === "loading"){
      document.addEventListener("DOMContentLoaded", initBrowser);
    } else {
      initBrowser();
    }
  }

  // Expose testable API for Node
  const TestAPI = {
    toRad, toDeg, haversineKm, bearingBetween, bearingToCardinal,
    makeGrid, destPoint,
    isSunnyLike, sunshineWindow,
    buildOverpassQL,
  };

  if(typeof module !== "undefined" && module.exports){
    module.exports = { TestAPI };
  } else {
    global.SunFinderTest = TestAPI;
  }

})(typeof window !== "undefined" ? window : globalThis);