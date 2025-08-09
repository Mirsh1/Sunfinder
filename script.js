const findSunBtn = document.getElementById('findSunBtn');
const resultsContainer = document.getElementById('results');
const howItWorksBtn = document.getElementById('howItWorksBtn');
const howItWorksModal = document.getElementById('howItWorksModal');
const closeModal = document.querySelector('.close');

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/reverse?format=json&lat=';
const WEATHER_API = 'https://api.open-meteo.com/v1/forecast';

// Exclude non-town words
const excludedKeywords = [
  'school', 'station', 'memorial', 'incident', 'murder', 'primary', 'academy', 'college'
];

// Interest → OSM tags
const interestTags = {
  beach: ['beach', 'bay', 'coast'],
  nature: ['nature_reserve', 'park', 'forest'],
  lake: ['lake', 'reservoir'],
  themepark: ['theme_park', 'amusement_park']
};

// Modal open/close
howItWorksBtn.addEventListener('click', () => {
  howItWorksModal.style.display = 'block';
});
closeModal.addEventListener('click', () => {
  howItWorksModal.style.display = 'none';
});
window.addEventListener('click', (e) => {
  if (e.target === howItWorksModal) {
    howItWorksModal.style.display = 'none';
  }
});

findSunBtn.addEventListener('click', async () => {
  resultsContainer.innerHTML = '<p>Loading...</p>';
  const radius = document.getElementById('radius').value;
  const interest = document.getElementById('interest').value;

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const { latitude, longitude } = pos.coords;
      const results = await findSunnySpots(latitude, longitude, radius, interest);
      renderResults(results);
    }, () => {
      resultsContainer.innerHTML = '<p>Location permission denied.</p>';
    });
  } else {
    resultsContainer.innerHTML = '<p>Geolocation not supported.</p>';
  }
});

async function findSunnySpots(lat, lon, radius, interest) {
  // Dummy grid search within radius for example purposes
  const step = 0.2; // ~20km
  const coords = [];
  for (let x = -1; x <= 1; x++) {
    for (let y = -1; y <= 1; y++) {
      coords.push([lat + x * step, lon + y * step]);
    }
  }

  const spots = [];
  for (const [clat, clon] of coords) {
    const placeName = await reverseGeocode(clat, clon);
    if (!placeName) continue;

    const weather = await fetchWeather(clat, clon);
    if (!weather) continue;

    if (weather.sunshine > 50) { // example threshold
      const activities = interest ? await fetchActivities(clat, clon, interest) : [];
      spots.push({
        name: placeName,
        lat: clat,
        lon: clon,
        temp: weather.temp,
        sunshine: weather.sunshine,
        activities
      });
    }
  }

  return spots.slice(0, 10); // cap results
}

async function reverseGeocode(lat, lon) {
  const res = await fetch(`${NOMINATIM_BASE}${lat}&lon=${lon}&zoom=10`);
  const data = await res.json();
  if (!data.address) return null;

  const place = data.address.city || data.address.town || data.address.village || data.address.suburb;
  if (!place) return null;

  // Exclude bad keywords
  const lower = place.toLowerCase();
  if (excludedKeywords.some(k => lower.includes(k))) return null;

  return place;
}

async function fetchWeather(lat, lon) {
  const res = await fetch(`${WEATHER_API}?latitude=${lat}&longitude=${lon}&current=temperature_2m,sunshine_duration`);
  const data = await res.json();
  if (!data.current) return null;
  return {
    temp: data.current.temperature_2m,
    sunshine: data.current.sunshine_duration
  };
}

async function fetchActivities(lat, lon, interest) {
  const tags = interestTags[interest] || [];
  if (tags.length === 0) return [];

  const query = `[out:json][timeout:25];
    (
      ${tags.map(t => `node["${t}"](around:5000,${lat},${lon});`).join('\n')}
    );
    out body;`;

  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: query
  });
  const data = await res.json();
  if (!data.elements) return [];
  return data.elements.slice(0, 3).map(e => e.tags.name).filter(Boolean);
}

function renderResults(spots) {
  resultsContainer.innerHTML = '';
  if (spots.length === 0) {
    resultsContainer.innerHTML = '<p>No sunny spots found nearby.</p>';
    return;
  }

  spots.forEach((spot, index) => {
    if (index === 3) {
      // Ad slot after 3rd card
      const adDiv = document.createElement('div');
      adDiv.className = 'ad-slot';
      adDiv.innerHTML = '<p>Ad slot (inline)</p>';
      resultsContainer.appendChild(adDiv);
    }

    const card = document.createElement('div');
    card.className = 'result-card';
    card.innerHTML = `
      <h3>${spot.name}</h3>
      <p>Temp: ${spot.temp}°C</p>
      <p>Sunshine: ${spot.sunshine} mins</p>
      ${spot.activities.length ? `<p>Activities: ${spot.activities.join(', ')}</p>` : ''}
      <a href="https://www.google.com/maps?q=${spot.lat},${spot.lon}" target="_blank">Open in Maps</a>
    `;
    resultsContainer.appendChild(card);
  });
}
