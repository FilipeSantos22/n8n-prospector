const axios = require('axios');

/**
 * Busca barbearias via Google Custom Search
 * Pega resultados de diretórios, redes sociais e sites próprios
 *
 * API: https://developers.google.com/custom-search/v1/overview
 * Free: 100 queries/dia
 * Custom Search Engine ID: criar em https://cse.google.com/
 */
async function searchGoogleCustom(city, state, apiKey, searchEngineId) {
  if (!apiKey || !searchEngineId) {
    console.log('[Google Search] API key ou Search Engine ID não configurado, pulando...');
    return [];
  }

  const allResults = [];
  const queries = [
    `barbearia ${city} ${state} telefone`,
    `barbearia ${city} ${state} instagram`,
    `barber shop ${city} ${state} agendamento`,
    `barbearia ${city} ${state} site:instagram.com`,
  ];

  for (const query of queries) {
    try {
      console.log(`[Google Search] Buscando: "${query}"`);

      const { data } = await axios.get('https://www.googleapis.com/customsearch/v1', {
        params: {
          key: apiKey,
          cx: searchEngineId,
          q: query,
          num: 10,
          gl: 'br',
          lr: 'lang_pt',
        }
      });

      for (const item of (data.items || [])) {
        // Extrair Instagram handles
        const igMatch = item.link?.match(/instagram\.com\/([a-zA-Z0-9_.]+)/);

        allResults.push({
          source: 'google_search',
          titulo: item.title,
          link: item.link,
          descricao: item.snippet,
          instagramHandle: igMatch ? igMatch[1] : null,
        });
      }
    } catch (err) {
      console.error(`[Google Search] Erro:`, err.response?.data?.error?.message || err.message);
    }
  }

  console.log(`[Google Search] Total: ${allResults.length} resultados`);
  return allResults;
}

module.exports = { searchGoogleCustom };
