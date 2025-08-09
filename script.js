// Sun Finder v5.4 (rollback stable) — strict places, activities, minimal ads
const KM_PER_MI = 1.609344;

const goBtn = document.getElementById('go');
const resultsEl = document.getElementById('results');
const statusEl = document.getElementById('status');
const how = document.getElementById('how'); const howBtn = document.getElementById('howBtn'); const closeBtn = how.querySelector('.close');

howBtn.addEventListener('click', ()=> how.classList.add('show'));
closeBtn.addEventListener('click', ()=> how.classList.remove('show'));
window.addEventListener('keydown', e=> { if(e.key==='Escape') how.classList.remove('show'); });

function setLoading(on){ if(on){ goBtn.classList.add('loading'); goBtn.disabled=true; } else { goBtn.classList.remove('loading'); goBtn.disabled=false; } }

goBtn.addEventListener('click', async()=>{
  setLoading(true);
  resultsEl.innerHTML = `<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`;
  statusEl.textContent = 'Getting your location…';
  try{
    const pos = await new Promise((res,rej)=> navigator.geolocation.getCurrentPosition(res,rej,{enableHighAccuracy:true,timeout:12000}));
    const origin = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    const radiusMi = Number(document.getElementById('radiusMi').value)||50;
    const interest = document.getElementById('interest').value||'';
    statusEl.textContent = 'Scanning nearby weather…';
    const spots = await findSpots(origin, radiusMi, interest);
    resultsEl.innerHTML = '';
    if(!spots.length){ statusEl.textContent = `No perfect sun right now — showing best weather.`; }
    else { statusEl.textContent = interest? `Best spots for ${interest} within ${radiusMi} miles.` : `Best weather within ${radiusMi} miles.`; }
    render(spots, interest);
  }catch(e){
    console.error(e); statusEl.textContent = 'Location blocked or failed. Make sure the site is on HTTPS and allow location.'; resultsEl.innerHTML='';
  }finally{ setLoading(false); }
});

function toRad(d){return d*Math.PI/180} function toDeg(r){return r*180/Math.PI}
function offset(lat, lon, bDeg, distKm){ const R=6371.0088, b=toRad(bDeg), dR=distKm/R;
  const lat1=toRad(lat), lon1=toRad(lon);
  const lat2=Math.asin(Math.sin(lat1)*Math.cos(dR)+Math.cos(lat1)*Math.sin(dR)*Math.cos(b));
  const lon2=lon1+Math.atan2(Math.sin(b)*Math.sin(dR)*Math.cos(lat1), Math.cos(dR)-Math.sin(lat1)*Math.cos(lat2));
  return { lat: toDeg(lat2), lon: ((toDeg(lon2)+540)%360)-180 };
}
function buildCandidates(origin, radiusMi){
  const rkm = radiusMi*KM_PER_MI;
  const rings=[Math.min(12,rkm/3), Math.min(24,rkm*0.6), Math.min(rkm, Math.max(12,rkm))].filter(Boolean);
  const bearings = Array.from({length:12},(_,i)=>i*30);
  const pts=[{lat:origin.lat, lon:origin.lon, here:true}]; const seen=new Set();
  for(const d of rings){ for(const b of bearings){ const p=offset(origin.lat, origin.lon, b, d);
    const key=`${p.lat.toFixed(2)},${p.lon.toFixed(2)}`; if(seen.has(key)) continue; seen.add(key); pts.push(p); } }
  return pts.slice(0,36);
}

// Settlement naming with Nominatim
const nameCache=new Map();
async function settlementName(lat, lon){
  const key=`${lat.toFixed(3)},${lon.toFixed(3)}`; if(nameCache.has(key)) return nameCache.get(key);
  const u = new URL('https://nominatim.openstreetmap.org/reverse');
  u.searchParams.set('lat', lat); u.searchParams.set('lon', lon);
  u.searchParams.set('format','jsonv2'); u.searchParams.set('zoom','14'); u.searchParams.set('addressdetails','1');
  const r = await fetch(u, { headers:{ 'Accept':'application/json' } });
  if(!r.ok){ nameCache.set(key,null); return null; }
  const d = await r.json(); const a=d.address||{};
  const place = a.city||a.town||a.village||a.hamlet||a.suburb||a.neighbourhood||null;
  // filter out obvious non-places
  const bad = /(school|station|memorial|incident|murder|academy|college|campus)/i.test(place||'');
  const label = bad? null : place;
  nameCache.set(key,label); return label;
}

// Weather via Open-Meteo
async function fetchWeather(lat, lon){
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', lat.toFixed(3));
  url.searchParams.set('longitude', lon.toFixed(3));
  url.searchParams.set('current', 'temperature_2m,precipitation,cloud_cover,shortwave_radiation,is_day');
  url.searchParams.set('timezone','auto');
  const r = await fetch(url); if(!r.ok) return null; const d = await r.json();
  return { temp: d.current?.temperature_2m??null, cloud: d.current?.cloud_cover??100, precip: d.current?.precipitation??0, sw: d.current?.shortwave_radiation??0 };
}

const interestKeywords = {
  beach:['beach','bay','coast','sand'],
  nature:['nature reserve','country park','forest','trail'],
  lake:['lake','loch','reservoir'],
  themepark:['theme park','amusement park','rides'],
  historic:['castle','abbey','cathedral','monument','ruins'],
  scenic:['viewpoint','scenic','lookout'],
  park:['park','playground','greenspace'],
  zoo:['zoo','aquarium','wildlife park']
};
async function fetchActivities(lat, lon, interest){
  const terms = interestKeywords[interest]||[]; if(!terms.length) return [];
  const url = `https://en.wikipedia.org/w/api.php?origin=*&action=query&list=geosearch&gsradius=10000&gslimit=25&format=json&gscoord=${lat}%7C${lon}`;
  try{ const r=await fetch(url); if(!r.ok) return []; const d=await r.json();
    const titles=(d?.query?.geosearch||[]).map(x=>x.title).filter(Boolean);
    return titles.filter(t=> terms.some(term=> t.toLowerCase().includes(term))).slice(0,3);
  }catch{ return []; }
}

async function findSpots(origin, radiusMi, interest){
  const candidates = buildCandidates(origin, radiusMi);
  const out=[];
  for(const p of candidates){
    const name = p.here? 'Your location' : await settlementName(p.lat, p.lon);
    if(!name) continue;
    const w = await fetchWeather(p.lat, p.lon); if(!w) continue;
    const sunny = (w.cloud<=30 && w.precip<0.1 && w.sw>=100);
    const score = w.sw - 1.4*w.cloud - 180*w.precip + (sunny?100:0);
    out.push({ ...p, name, weather:w, sunny, score });
  }
  out.sort((a,b)=> b.score-a.score);
  const top = out.slice(0,10);
  if(interest){
    await Promise.all(top.map(async(r)=>{ r.activities = await fetchActivities(r.lat, r.lon, interest); }));
  } else { top.forEach(r=> r.activities=[]); }
  return top;
}

function render(list, interest){
  resultsEl.innerHTML='';
  list.forEach((r, idx)=>{
    if(idx===3){
      const ad=document.createElement('div'); ad.className='ad'; ad.innerHTML='<span>Ad slot (inline)</span>'; resultsEl.appendChild(ad);
    }
    const card=document.createElement('div'); card.className='card';
    const sunnyTxt=r.sunny? 'Sunny now':'Sun may vary';
    card.innerHTML = `
      <h3>${idx+1}. ${r.name}</h3>
      <div class="row">
        <span class="pill ${r.sunny?'ok':'warn'}">${sunnyTxt}</span>
        <span class="pill">Temp ${Math.round(r.weather.temp)}°C</span>
        <span class="pill">${Math.round(r.weather.cloud)}% cloud</span>
        <a class="pill" href="https://maps.google.com/?q=${r.lat},${r.lon}" target="_blank" rel="noopener">Open in Maps</a>
      </div>
      ${r.activities?.length? `<div class="row" style="margin-top:8px"><span class="pill">Nearby:</span> ${r.activities.map(a=>`<span class="pill">${a}</span>`).join(' ')}</div>`:''}
    `;
    resultsEl.appendChild(card);
  });
}
