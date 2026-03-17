const axios = require('axios');

/**
 * Busca no Foursquare Places API (v3)
 * Free tier: 200 req/dia
 */
async function searchFoursquare(city, state, apiKey, config = null) {
  if (!apiKey) {
    console.log('[Foursquare] API key não configurada, pulando...');
    return [];
  }

  const fsqQuery = config?.busca?.foursquareQuery || 'barbearia';
  const fsqCategory = config?.busca?.foursquareCategory || '';

  const allResults = [];
  const query = `${fsqQuery} ${city}`;

  console.log(`[Foursquare] Buscando: "${query}"`);

  try {
    const params = {
      query: fsqQuery,
      near: `${city}, ${state}, Brazil`,
      limit: 50,
    };
    if (fsqCategory) {
      params.categories = fsqCategory;
    }

    const { data } = await axios.get('https://api.foursquare.com/v3/places/search', {
      headers: {
        'Authorization': apiKey,
        'Accept': 'application/json',
      },
      params,
    });

    for (const place of (data.results || [])) {
      allResults.push({
        source: 'foursquare',
        fsq_id: place.fsq_id,
        nome: place.name,
        endereco: [
          place.location?.address,
          place.location?.locality,
          place.location?.region,
        ].filter(Boolean).join(', '),
        lat: place.geocodes?.main?.latitude,
        lng: place.geocodes?.main?.longitude,
        telefone: place.tel || '',
        categorias: (place.categories || []).map(c => c.name),
        distancia: place.distance,
      });
    }

    console.log(`[Foursquare] Total: ${allResults.length} resultados`);
  } catch (err) {
    console.error(`[Foursquare] Erro:`, err.response?.data?.message || err.message);
  }

  return allResults;
}

module.exports = { searchFoursquare };
