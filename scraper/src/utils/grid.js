/**
 * Gera grid de pontos para cobertura geográfica de uma cidade
 * Cada ponto vira uma Nearby Search com radius
 */

// Bounds pré-configurados de cidades brasileiras
const CITY_BOUNDS = {
  'goiania-go': { north: -16.58, south: -16.78, east: -49.15, west: -49.40, center: { lat: -16.6869, lng: -49.2648 } },
  'sao-paulo-sp': { north: -23.38, south: -23.72, east: -46.36, west: -46.82, center: { lat: -23.5505, lng: -46.6333 } },
  'brasilia-df': { north: -15.60, south: -15.87, east: -47.70, west: -48.10, center: { lat: -15.7975, lng: -47.8919 } },
  'belo-horizonte-mg': { north: -19.78, south: -20.01, east: -43.85, west: -44.07, center: { lat: -19.9167, lng: -43.9345 } },
  'rio-de-janeiro-rj': { north: -22.75, south: -23.08, east: -43.10, west: -43.80, center: { lat: -22.9068, lng: -43.1729 } },
  'curitiba-pr': { north: -25.35, south: -25.60, east: -49.18, west: -49.40, center: { lat: -25.4284, lng: -49.2733 } },
  'fortaleza-ce': { north: -3.69, south: -3.89, east: -38.42, west: -38.64, center: { lat: -3.7172, lng: -38.5433 } },
  'salvador-ba': { north: -12.89, south: -13.01, east: -38.35, west: -38.53, center: { lat: -12.9714, lng: -38.5124 } },
  'recife-pe': { north: -7.95, south: -8.12, east: -34.84, west: -35.02, center: { lat: -8.0476, lng: -34.8770 } },
  'porto-alegre-rs': { north: -29.93, south: -30.27, east: -51.02, west: -51.27, center: { lat: -30.0346, lng: -51.2177 } },
  'manaus-am': { north: -2.97, south: -3.16, east: -59.87, west: -60.10, center: { lat: -3.1190, lng: -60.0217 } },
  'campinas-sp': { north: -22.78, south: -23.02, east: -46.92, west: -47.17, center: { lat: -22.9099, lng: -47.0626 } },
  'goiania-go-metro': { north: -16.50, south: -16.85, east: -49.05, west: -49.50, center: { lat: -16.6869, lng: -49.2648 } },
  'uberlandia-mg': { north: -18.86, south: -18.98, east: -48.22, west: -48.32, center: { lat: -18.9186, lng: -48.2772 } },
  'anapolis-go': { north: -16.28, south: -16.38, east: -48.92, west: -49.02, center: { lat: -16.3281, lng: -48.9530 } },
  'aparecida-de-goiania-go': { north: -16.71, south: -16.84, east: -49.20, west: -49.32, center: { lat: -16.8198, lng: -49.2469 } },
};

/**
 * Gera grid de pontos dentro dos bounds de uma cidade
 * @param {string} city - Nome da cidade
 * @param {string} state - Sigla do estado
 * @param {number} radiusKm - Raio de busca em km (default 3)
 * @returns {{ points: Array, bounds: Object, radiusMeters: number }}
 */
function generateGrid(city, state, radiusKm = 3) {
  const key = normalizeKey(city, state);
  const bounds = CITY_BOUNDS[key];

  if (!bounds) {
    // Fallback: gera grid simples ao redor do centro estimado
    console.warn(`[Grid] Bounds não encontrados para ${city}/${state}, usando busca centralizada`);
    return {
      points: [{ lat: 0, lng: 0 }], // será substituído por geocoding
      bounds: null,
      radiusMeters: radiusKm * 1000,
      needsGeocoding: true,
    };
  }

  const points = [];
  const centerLat = (bounds.north + bounds.south) / 2;

  // 1 grau de latitude ≈ 111km
  const stepLat = (radiusKm * 1.5) / 111; // overlap de 50% para cobertura total
  // 1 grau de longitude varia com a latitude
  const stepLng = (radiusKm * 1.5) / (111 * Math.cos(centerLat * Math.PI / 180));

  for (let lat = bounds.south; lat <= bounds.north; lat += stepLat) {
    for (let lng = bounds.west; lng <= bounds.east; lng += stepLng) {
      points.push({
        lat: Math.round(lat * 1000000) / 1000000,
        lng: Math.round(lng * 1000000) / 1000000,
      });
    }
  }

  console.log(`[Grid] ${city}/${state}: ${points.length} pontos de busca (raio ${radiusKm}km)`);

  return {
    points,
    bounds,
    center: bounds.center,
    radiusMeters: radiusKm * 1000,
  };
}

/**
 * Geocoding simples via Google Maps para cidades sem bounds pré-configurados
 */
async function geocodeCity(city, state, apiKey) {
  const axios = require('axios');
  try {
    const { data } = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: {
        address: `${city}, ${state}, Brazil`,
        key: apiKey,
      },
    });

    if (data.status === 'OK' && data.results[0]) {
      const result = data.results[0];
      const viewport = result.geometry.viewport;
      return {
        center: result.geometry.location,
        bounds: {
          north: viewport.northeast.lat,
          south: viewport.southwest.lat,
          east: viewport.northeast.lng,
          west: viewport.southwest.lng,
        },
      };
    }
  } catch (err) {
    console.error(`[Geocoding] Erro para ${city}/${state}:`, err.message);
  }
  return null;
}

function normalizeKey(city, state) {
  return city
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    + '-' + state.toLowerCase();
}

module.exports = { generateGrid, geocodeCity, CITY_BOUNDS };
