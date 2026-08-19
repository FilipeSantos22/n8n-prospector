const axios = require('axios');

// ════════════════════════════════════════════════════
// PLACES API (NEW) — places.googleapis.com/v1
//
// A API legada (/maps/api/place/*) foi fechada para projetos novos pelo Google
// em 03/2025 e responde REQUEST_DENIED neste projeto. Todo o módulo usa a
// Places API (New).
//
// ⚠️ CUSTO — o projeto opera SOMENTE no tier gratuito.
// Na Places API (New) o `X-Goog-FieldMask` determina o SKU cobrado
// (Essentials < Pro < Enterprise, do mais generoso ao mais apertado em
// franquia mensal). Pedir campo a mais não encarece um pouco: promove a
// chamada inteira para a faixa de menor franquia.
// NÃO adicione campo ao FieldMask sem medir o impacto na cota.
// ════════════════════════════════════════════════════

const PLACES_BASE = 'https://places.googleapis.com/v1';

// Discovery — inclui rating/userRatingCount de propósito: são campos de faixa
// cara, mas 1 chamada cobre até 20 lugares e habilita o pre-filter, que corta
// o volume ANTES do enrichment (onde o custo é de 1 chamada POR lead).
// Sem eles aqui, o pre-filter por avaliações não roda e enriqueceríamos tudo.
// `websiteUri` e `nationalPhoneNumber` entram aqui de carona: rating/userRatingCount
// já colocam a chamada na faixa Enterprise, e o SKU é definido pelo campo de MAIOR
// faixa pedido — então somar mais campos da mesma faixa não muda a cobrança.
// Em troca, o pre-filter passa a poder aplicar a regra "sem telefone E sem site"
// ANTES do enrichment, que é onde o custo é por lead.
const DISCOVERY_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.businessStatus',
  'places.rating',
  'places.userRatingCount',
  'places.websiteUri',
  'places.nationalPhoneNumber',
  'nextPageToken',
].join(',');

// Details — só para leads que sobreviveram ao pre-filter.
const DETAILS_FIELD_MASK = [
  'id',
  'nationalPhoneNumber',
  'internationalPhoneNumber',
  'websiteUri',
  'regularOpeningHours',
  'googleMapsUri',
  'businessStatus',
  'reviews',
].join(',');

const MAX_PAGE_SIZE = 20; // teto da Places API (New)

// ════════════════════════════════════════════════════
// SEARCH TEXT — motor único de busca
//
// A `searchNearby` da API nova NÃO aceita keyword (só `includedTypes`), o que
// devolve resultado poluído. A `searchText` mantém o alvo por termo e ainda
// suporta paginação — é o equivalente real ao que a API legada fazia com
// type + keyword.
// ════════════════════════════════════════════════════

/**
 * Executa uma busca textual na Places API (New), com paginação.
 * @param {string} textQuery - Termo de busca (ex: "barbearia")
 * @param {string} apiKey
 * @param {Object} opts
 * @param {Object} [opts.rectangle] - { low: {latitude,longitude}, high: {...} }
 * @param {string} [opts.includedType] - Tipo Google Places (ex: "hair_care")
 * @param {number} [opts.maxPages=1] - Páginas de até 20 resultados
 * @returns {Array} Resultados brutos da API
 */
async function searchText(textQuery, apiKey, opts = {}) {
  const { rectangle, includedType, maxPages = 1 } = opts;
  const results = [];
  let pageToken = null;
  let page = 0;

  while (page < maxPages) {
    const body = {
      textQuery,
      maxResultCount: MAX_PAGE_SIZE,
      languageCode: 'pt-BR',
      regionCode: 'BR',
    };
    if (rectangle) body.locationRestriction = { rectangle };
    if (includedType) body.includedType = includedType;
    if (pageToken) body.pageToken = pageToken;

    try {
      const { data } = await axios.post(`${PLACES_BASE}/places:searchText`, body, {
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': DISCOVERY_FIELD_MASK,
        },
        timeout: 20000,
      });

      const places = data.places || [];
      results.push(...places);

      pageToken = data.nextPageToken || null;
      if (!pageToken || places.length === 0) break;

      page++;
      await sleep(2000); // token precisa de alguns instantes para valer
    } catch (err) {
      const detail = err.response?.data?.error;
      console.error(`[Places] Erro em "${textQuery}": ${detail?.status || err.message}${detail?.message ? ' — ' + detail.message.slice(0, 160) : ''}`);
      break;
    }
  }

  return results;
}

// ════════════════════════════════════════════════════
// V1 — TEXT SEARCH (compatibilidade com /api/search)
// ════════════════════════════════════════════════════

async function searchGoogleMaps(city, state, apiKey, options = {}, config = null) {
  const defaultQueries = config ? config.busca.queries : ['barbearia', 'barber shop'];
  const { maxPages = 3, queries = defaultQueries } = options;
  const includedType = config?.busca?.googlePlaceType || null;

  const allResults = [];
  const seenIds = new Set();

  for (const query of queries) {
    const fullQuery = `${query} em ${city}, ${state}`;
    console.log(`[Places] Buscando: "${fullQuery}"`);

    const places = await searchText(fullQuery, apiKey, { includedType, maxPages });

    let novos = 0;
    for (const place of places) {
      if (place.id && !seenIds.has(place.id)) {
        seenIds.add(place.id);
        allResults.push(parsePlaceResult(place, 'text_search'));
        novos++;
      }
    }

    console.log(`[Places] "${query}": ${places.length} retornados, +${novos} únicos (total: ${allResults.length})`);
    await sleep(300);
  }

  console.log(`[Places] Total: ${allResults.length} resultados únicos em ${city}/${state}`);
  return allResults;
}

// ════════════════════════════════════════════════════
// V2 — BUSCA EM GRID GEOGRÁFICO
// ════════════════════════════════════════════════════

/**
 * Varre o grid da cidade, uma busca por ponto.
 *
 * Mantém a estratégia da versão legada: as keywords do config são ALTERNADAS
 * entre os pontos (1 keyword por ponto), não varridas todas em cada ponto.
 * Varrer todas multiplicaria as chamadas pelo número de keywords — decisão de
 * custo que precisa ser tomada explicitamente, não por efeito colateral da
 * migração.
 *
 * @param {Array}  gridPoints - [{ lat, lng }, ...]
 * @param {number} radiusMeters
 * @param {string} apiKey
 * @param {Object} config - Config do segmento
 * @returns {Array} Leads únicos
 */
async function nearbySearchGrid(gridPoints, radiusMeters, apiKey, config = null) {
  const allResults = [];
  const seenIds = new Set();

  const keywords = config ? config.busca.nearbyKeywords : ['barbearia', 'barber'];
  const includedType = config?.busca?.googlePlaceType || null;

  let pointIndex = 0;
  for (const point of gridPoints) {
    pointIndex++;
    const keyword = keywords[pointIndex % keywords.length];
    const rectangle = circleToRectangle(point.lat, point.lng, radiusMeters);

    console.log(`[Places] Ponto ${pointIndex}/${gridPoints.length} (${point.lat},${point.lng}) keyword="${keyword}"`);

    const places = await searchText(keyword, apiKey, { rectangle, includedType, maxPages: 2 });

    let novos = 0;
    for (const place of places) {
      if (place.id && !seenIds.has(place.id)) {
        seenIds.add(place.id);
        allResults.push({ ...parsePlaceResult(place, 'nearby_search'), gridPoint: point });
        novos++;
      }
    }

    if (novos > 0) {
      console.log(`[Places]   +${novos} novos (total: ${allResults.length})`);
    }

    await sleep(300);
  }

  console.log(`[Places] Total: ${allResults.length} resultados únicos`);
  return allResults;
}

/**
 * Busca combinada por cidade (hoje: só o grid).
 */
async function combinedSearch(city, state, gridPoints, radiusMeters, apiKey, config = null) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`BUSCA: ${city}/${state} (${gridPoints.length} pontos, raio ${radiusMeters}m)`);
  console.log('═'.repeat(60));

  const results = await nearbySearchGrid(gridPoints, radiusMeters, apiKey, config);
  console.log(`[Busca] ${results.length} resultados únicos em ${city}/${state}`);
  return results;
}

// ════════════════════════════════════════════════════
// PLACE DETAILS
// ════════════════════════════════════════════════════

/**
 * Detalhes de um lugar. Retorno mantém EXATAMENTE o shape da versão legada
 * para não quebrar o enrichment.
 * @param {string} placeId - `id` da Places API (New)
 * @param {string} apiKey
 */
async function getPlaceDetails(placeId, apiKey) {
  try {
    const { data } = await axios.get(`${PLACES_BASE}/places/${encodeURIComponent(placeId)}`, {
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': DETAILS_FIELD_MASK,
      },
      params: { languageCode: 'pt-BR', regionCode: 'BR' },
      timeout: 15000,
    });

    return {
      telefone: data.nationalPhoneNumber || '',
      telefoneInternacional: data.internationalPhoneNumber || '',
      website: data.websiteUri || '',
      horarios: data.regularOpeningHours?.weekdayDescriptions || [],
      horariosAberto: data.regularOpeningHours?.openNow || false,
      googleMapsUrl: data.googleMapsUri || '',
      status: data.businessStatus || '',
      reviews: (data.reviews || []).slice(0, 5).map(r => ({
        autor: r.authorAttribution?.displayName || '',
        nota: r.rating || 0,
        texto: r.text?.text || r.originalText?.text || '',
        // `tempo` continua textual para o tempoToMonths() da análise de reviews.
        tempo: r.relativePublishTimeDescription || '',
        // A API nova entrega timestamp absoluto — mais preciso que o texto
        // relativo. Disponível para a ponderação por recência usar no futuro.
        publicadoEm: r.publishTime || null,
        idioma: r.text?.languageCode || '',
      })),
    };
  } catch (err) {
    const detail = err.response?.data?.error;
    console.error(`[Place Details] Erro para ${placeId}: ${detail?.status || err.message}`);
    return null;
  }
}

// ════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════

/**
 * Converte centro + raio num retângulo.
 * `searchText` só aceita `rectangle` em locationRestriction (circle existe
 * apenas em locationBias, que é sugestão e deixa vazar resultado de fora da
 * célula — ruim para cobertura de grid).
 */
function circleToRectangle(lat, lng, radiusMeters) {
  const dLat = radiusMeters / 111320;
  const dLng = radiusMeters / (111320 * Math.cos(lat * Math.PI / 180));
  return {
    low: { latitude: lat - dLat, longitude: lng - dLng },
    high: { latitude: lat + dLat, longitude: lng + dLng },
  };
}

/**
 * Normaliza um place da API nova para o shape que o pipeline já consome.
 */
function parsePlaceResult(place, source) {
  return {
    source,
    place_id: place.id,
    nome: place.displayName?.text || '',
    endereco: place.formattedAddress || '',
    lat: place.location?.latitude,
    lng: place.location?.longitude,
    rating: place.rating || 0,
    totalAvaliacoes: place.userRatingCount || 0,
    businessStatus: place.businessStatus || 'OPERATIONAL',
    // Já no discovery — habilitam o pre-filter a cortar antes do enrichment.
    telefone: place.nationalPhoneNumber || '',
    website: place.websiteUri || '',
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
};
