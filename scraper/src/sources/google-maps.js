const axios = require('axios');

const SEARCH_QUERIES = [
  'barbearia',
  'barber shop',
  'barbearia masculina',
  'studio barber',
  'barbeiro',
  'salão masculino',
];

// ════════════════════════════════════════════════════
// V1 — TEXT SEARCH (mantido para compatibilidade)
// ════════════════════════════════════════════════════

async function searchGoogleMaps(city, state, apiKey, options = {}) {
  const { maxPages = 3, queries = SEARCH_QUERIES } = options;
  const allResults = [];
  const seenPlaceIds = new Set();

  for (const query of queries) {
    const fullQuery = `${query} em ${city}, ${state}`;
    console.log(`[Google Maps] Buscando: "${fullQuery}"`);

    let pageToken = null;
    let page = 0;

    while (page < maxPages) {
      try {
        const params = {
          query: fullQuery,
          key: apiKey,
          language: 'pt-BR',
        };

        if (pageToken) {
          params.pagetoken = pageToken;
          await sleep(2000);
        }

        const { data } = await axios.get(
          'https://maps.googleapis.com/maps/api/place/textsearch/json',
          { params }
        );

        if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
          console.warn(`[Google Maps] Status: ${data.status} - ${data.error_message || ''}`);
          break;
        }

        for (const place of (data.results || [])) {
          if (!seenPlaceIds.has(place.place_id)) {
            seenPlaceIds.add(place.place_id);
            allResults.push(parsePlaceResult(place, 'text_search'));
          }
        }

        console.log(`[Google Maps] "${query}" página ${page + 1}: ${data.results?.length || 0} resultados (total único: ${allResults.length})`);

        pageToken = data.next_page_token || null;
        if (!pageToken) break;
        page++;
      } catch (err) {
        console.error(`[Google Maps] Erro na busca "${query}":`, err.message);
        break;
      }
    }
  }

  console.log(`[Google Maps] Total: ${allResults.length} barbearias únicas em ${city}/${state}`);
  return allResults;
}

// ════════════════════════════════════════════════════
// V2 — NEARBY SEARCH (grid geográfico)
// ════════════════════════════════════════════════════

/**
 * Busca barbearias usando Nearby Search em grid de pontos
 * Cobre a cidade inteira com overlapping de raio
 * @param {Array} gridPoints - [{ lat, lng }, ...]
 * @param {number} radiusMeters - Raio em metros
 * @param {string} apiKey - Google Maps API key
 * @returns {Array} Leads únicos
 */
async function nearbySearchGrid(gridPoints, radiusMeters, apiKey) {
  const allResults = [];
  const seenPlaceIds = new Set();
  let pointIndex = 0;

  const keywords = ['barbearia', 'barber'];

  for (const point of gridPoints) {
    pointIndex++;
    const keywordIndex = pointIndex % keywords.length;
    const keyword = keywords[keywordIndex];

    console.log(`[Nearby] Ponto ${pointIndex}/${gridPoints.length} (${point.lat},${point.lng}) keyword="${keyword}"`);

    let pageToken = null;
    let page = 0;

    while (page < 2) {
      try {
        const params = {
          location: `${point.lat},${point.lng}`,
          radius: radiusMeters,
          keyword,
          type: 'hair_care',
          key: apiKey,
          language: 'pt-BR',
        };

        if (pageToken) {
          params.pagetoken = pageToken;
          await sleep(2000);
        }

        const { data } = await axios.get(
          'https://maps.googleapis.com/maps/api/place/nearbysearch/json',
          { params }
        );

        if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
          if (data.status === 'INVALID_REQUEST' && pageToken) {
            // Token expirado, tentar novamente com mais delay
            await sleep(3000);
            page++;
            continue;
          }
          console.warn(`[Nearby] Status: ${data.status} - ${data.error_message || ''}`);
          break;
        }

        let newCount = 0;
        for (const place of (data.results || [])) {
          if (!seenPlaceIds.has(place.place_id)) {
            seenPlaceIds.add(place.place_id);
            allResults.push({
              ...parsePlaceResult(place, 'nearby_search'),
              gridPoint: point,
            });
            newCount++;
          }
        }

        if (newCount > 0) {
          console.log(`[Nearby]   Página ${page + 1}: +${newCount} novos (total: ${allResults.length})`);
        }

        pageToken = data.next_page_token || null;
        if (!pageToken) break;
        page++;
      } catch (err) {
        console.error(`[Nearby] Erro no ponto ${pointIndex}:`, err.message);
        break;
      }
    }

    // Rate limit entre pontos
    await sleep(300);
  }

  console.log(`[Nearby] Total: ${allResults.length} barbearias únicas`);
  return allResults;
}

/**
 * Busca combinada: Nearby Search (grid) + Text Search (complementar)
 * Maximiza cobertura sem duplicatas
 */
async function combinedSearch(city, state, gridPoints, radiusMeters, apiKey) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`BUSCA: ${city}/${state} (${gridPoints.length} pontos, raio ${radiusMeters}m)`);
  console.log('═'.repeat(60));

  const results = await nearbySearchGrid(gridPoints, radiusMeters, apiKey);
  console.log(`[Busca] ${results.length} barbearias únicas em ${city}/${state}`);
  return results;
}

// ════════════════════════════════════════════════════
// PLACE DETAILS (otimizado)
// ════════════════════════════════════════════════════

/**
 * Busca detalhes completos usando fields otimizados para reduzir custo
 */
async function getPlaceDetails(placeId, apiKey) {
  try {
    const { data } = await axios.get(
      'https://maps.googleapis.com/maps/api/place/details/json',
      {
        params: {
          place_id: placeId,
          key: apiKey,
          fields: [
            'formatted_phone_number',
            'international_phone_number',
            'website',
            'opening_hours',
            'url',
            'reviews',
            'business_status',
          ].join(','),
          language: 'pt-BR',
          reviews_sort: 'newest',
        }
      }
    );

    if (data.status !== 'OK') return null;

    const p = data.result;
    return {
      telefone: p.formatted_phone_number || '',
      telefoneInternacional: p.international_phone_number || '',
      website: p.website || '',
      horarios: p.opening_hours?.weekday_text || [],
      horariosAberto: p.opening_hours?.open_now || false,
      googleMapsUrl: p.url || '',
      status: p.business_status || '',
      reviews: (p.reviews || []).slice(0, 3).map(r => ({
        autor: r.author_name,
        nota: r.rating,
        texto: r.text,
        tempo: r.relative_time_description,
        idioma: r.language,
      })),
    };
  } catch (err) {
    console.error(`[Place Details] Erro para ${placeId}:`, err.message);
    return null;
  }
}

// ════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════

function parsePlaceResult(place, source) {
  return {
    source,
    place_id: place.place_id,
    nome: place.name,
    endereco: place.formatted_address || place.vicinity || '',
    lat: place.geometry?.location?.lat,
    lng: place.geometry?.location?.lng,
    rating: place.rating || 0,
    totalAvaliacoes: place.user_ratings_total || 0,
    tipos: place.types || [],
    aberto: place.opening_hours?.open_now || null,
    priceLevel: place.price_level || null,
    businessStatus: place.business_status || 'OPERATIONAL',
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  searchGoogleMaps,
  nearbySearchGrid,
  combinedSearch,
  getPlaceDetails,
  SEARCH_QUERIES,
};
