const axios = require('axios');

/**
 * Busca leads via Google Custom Search API
 * Pega resultados orgânicos — descobre negócios com site que podem não aparecer no Maps
 *
 * Requer:
 * - GOOGLE_SEARCH_API_KEY (API key do Google Cloud)
 * - GOOGLE_SEARCH_ENGINE_ID (ID do Custom Search Engine — criar em cse.google.com)
 *
 * Free tier: 100 buscas/dia
 */

/**
 * Busca estabelecimentos via Google Custom Search
 * @param {string} city - Cidade
 * @param {string} state - Estado (sigla)
 * @param {Object} config - Config do segmento
 * @returns {Array} Leads encontrados
 */
async function searchGoogleCustom(city, state, config = null) {
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
  const engineId = process.env.GOOGLE_SEARCH_ENGINE_ID;

  if (!apiKey || !engineId) {
    console.log('[Google Search] API key ou Engine ID não configurados, pulando...');
    return [];
  }

  const queries = config?.busca?.googleSearchQueries || config?.busca?.queries || [
    'barbearia', 'barber shop',
  ];

  // Limitar queries para economizar cota (100/dia)
  const limitedQueries = queries.slice(0, 3);
  const allResults = [];
  const seenUrls = new Set();

  for (const query of limitedQueries) {
    const fullQuery = `${query} ${city} ${state}`;
    console.log(`[Google Search] Buscando: "${fullQuery}"`);

    try {
      const results = await executeSearch(fullQuery, apiKey, engineId, 1);
      for (const result of results) {
        if (!seenUrls.has(result.website)) {
          seenUrls.add(result.website);
          allResults.push(result);
        }
      }

      console.log(`[Google Search] "${query}": ${results.length} resultados`);
      await sleep(500);
    } catch (err) {
      console.error(`[Google Search] Erro na busca "${query}":`, err.message);
      if (err.response?.status === 429) {
        console.warn('[Google Search] Cota diária atingida, parando buscas');
        break;
      }
    }
  }

  console.log(`[Google Search] Total: ${allResults.length} resultados únicos`);
  return allResults;
}

/**
 * Executa uma busca no Google Custom Search API
 */
async function executeSearch(query, apiKey, engineId, startIndex) {
  const { data } = await axios.get('https://www.googleapis.com/customsearch/v1', {
    params: {
      key: apiKey,
      cx: engineId,
      q: query,
      gl: 'br',
      lr: 'lang_pt',
      num: 10,
      start: startIndex,
    },
    timeout: 10000,
  });

  const results = [];
  for (const item of (data.items || [])) {
    const parsed = parseSearchResult(item);
    if (parsed) results.push(parsed);
  }

  return results;
}

/**
 * Parseia um resultado do Google Search para formato de lead
 */
function parseSearchResult(item) {
  const url = item.link || '';

  // Filtrar resultados irrelevantes
  if (isIrrelevantUrl(url)) return null;

  const snippet = item.snippet || '';
  const title = item.title || '';
  const metatags = item.pagemap?.metatags?.[0] || {};

  // Tentar extrair telefone do snippet
  const phoneMatch = snippet.match(/\(?\d{2}\)?\s?\d{4,5}[-.\s]?\d{4}/);

  // Tentar extrair endereço do snippet ou metatags
  const address = metatags['og:street-address']
    || metatags['business:contact_data:street_address']
    || extractAddressFromSnippet(snippet)
    || '';

  // Tentar extrair coordenadas
  const lat = parseFloat(metatags['place:location:latitude'] || metatags['og:latitude'] || '');
  const lng = parseFloat(metatags['place:location:longitude'] || metatags['og:longitude'] || '');

  return {
    source: 'google_search',
    nome: cleanTitle(title),
    website: url,
    endereco: address,
    telefone: phoneMatch ? phoneMatch[0] : '',
    snippet,
    lat: isNaN(lat) ? null : lat,
    lng: isNaN(lng) ? null : lng,
    rating: 0,
    totalAvaliacoes: 0,
    metaTags: {
      title,
      description: metatags['og:description'] || metatags.description || snippet,
    },
  };
}

/**
 * Filtra URLs de sites genéricos / diretórios que não são o negócio em si
 */
function isIrrelevantUrl(url) {
  const blocked = [
    'facebook.com', 'instagram.com', 'twitter.com', 'youtube.com',
    'linkedin.com', 'tiktok.com', 'pinterest.com',
    'google.com/maps', 'maps.google',
    'yelp.com', 'tripadvisor.com', 'foursquare.com',
    'wikipedia.org', 'reclameaqui.com',
    'guiamais.com', 'telelistas.net', 'hagah.com', 'apontador.com',
    'ifood.com', 'rappi.com',
    'indeed.com', 'glassdoor.com', 'catho.com',
  ];
  const urlLower = url.toLowerCase();
  return blocked.some(domain => urlLower.includes(domain));
}

/**
 * Limpa o título removendo sufixos comuns de SEO
 */
function cleanTitle(title) {
  return title
    .replace(/\s*[|\-–—]\s*(google|maps|yelp|instagram|facebook).*/i, '')
    .replace(/\s*-\s*home$/i, '')
    .replace(/\s*\|.*$/i, '')
    .trim();
}

/**
 * Tenta extrair endereço do snippet do Google
 */
function extractAddressFromSnippet(snippet) {
  const addrMatch = snippet.match(
    /(?:R\.|Rua|Av\.|Avenida|Al\.|Alameda|Tv\.|Travessa)[^,]+,\s*\d+[^.!?]*/i
  );
  return addrMatch ? addrMatch[0].trim() : '';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { searchGoogleCustom };
