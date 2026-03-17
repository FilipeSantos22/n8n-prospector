const axios = require('axios');

/**
 * Busca de leads via Instagram — scraping de perfis por hashtag/localização
 *
 * Duas estratégias:
 * 1. Web scraping: busca por hashtags e extrai perfis de negócios
 * 2. Geração de handles prováveis e verificação em massa
 *
 * Nota: Instagram bloqueia scraping agressivo.
 * Rate limit conservador: 1 req/2s, max ~100 perfis por execução
 */

/**
 * Busca leads no Instagram por hashtags do segmento + cidade
 * @param {string} city - Cidade
 * @param {string} state - Estado
 * @param {Object} config - Config do segmento
 * @returns {Array} Leads encontrados
 */
async function searchInstagram(city, state, config = null) {
  const hashtags = buildHashtags(city, state, config);
  const allResults = [];
  const seenHandles = new Set();

  console.log(`[Instagram Search] Buscando com ${hashtags.length} hashtags...`);

  // Estratégia 1: buscar perfis via hashtags no web
  for (const hashtag of hashtags) {
    console.log(`[Instagram Search] Hashtag: #${hashtag}`);

    try {
      const profiles = await scrapeHashtagProfiles(hashtag);

      for (const profile of profiles) {
        if (!seenHandles.has(profile.handle)) {
          seenHandles.add(profile.handle);

          // Verificar se o perfil é de negócio relevante
          const details = await fetchProfileDetails(profile.handle);
          if (details && isBusinessProfile(details, config)) {
            allResults.push({
              source: 'instagram_search',
              nome: details.nome || profile.handle,
              instagram: {
                found: true,
                handle: profile.handle,
                url: `https://www.instagram.com/${profile.handle}/`,
                bio: details.bio,
                seguidores: details.seguidores,
                posts: details.posts,
                linkExterno: details.linkExterno,
                isBusiness: details.isBusiness,
                temWhatsappLink: details.temWhatsappLink,
              },
              website: details.linkExterno && !details.linkExterno.includes('linktr.ee')
                ? details.linkExterno : '',
              telefone: extractPhoneFromBio(details.bio),
              endereco: '',
              rating: 0,
              totalAvaliacoes: 0,
              lat: null,
              lng: null,
            });

            console.log(`  [Instagram Search] ✅ @${profile.handle} — ${details.nome} (${details.seguidores || '?'} seguidores)`);
          }

          await sleep(2000); // Rate limit conservador
        }
      }
    } catch (err) {
      if (err.response?.status === 429) {
        console.warn('[Instagram Search] Rate limited, parando buscas');
        break;
      }
      console.error(`[Instagram Search] Erro hashtag #${hashtag}:`, err.message);
    }

    await sleep(3000);
  }

  // Estratégia 2: gerar handles prováveis com base nos termos de busca
  const generatedHandles = generateCityHandles(city, config);
  console.log(`[Instagram Search] Testando ${generatedHandles.length} handles gerados...`);

  for (const handle of generatedHandles) {
    if (seenHandles.has(handle)) continue;
    seenHandles.add(handle);

    try {
      const details = await fetchProfileDetails(handle);
      if (details && isBusinessProfile(details, config)) {
        allResults.push({
          source: 'instagram_search',
          nome: details.nome || handle,
          instagram: {
            found: true,
            handle,
            url: `https://www.instagram.com/${handle}/`,
            bio: details.bio,
            seguidores: details.seguidores,
            posts: details.posts,
            linkExterno: details.linkExterno,
            isBusiness: details.isBusiness,
            temWhatsappLink: details.temWhatsappLink,
          },
          website: details.linkExterno && !details.linkExterno.includes('linktr.ee')
            ? details.linkExterno : '',
          telefone: extractPhoneFromBio(details.bio),
          endereco: '',
          rating: 0,
          totalAvaliacoes: 0,
          lat: null,
          lng: null,
        });
        console.log(`  [Instagram Search] ✅ @${handle} — ${details.nome}`);
      }
    } catch (err) {
      // Silencioso — a maioria dos handles gerados não vai existir
    }

    await sleep(1500);
  }

  console.log(`[Instagram Search] Total: ${allResults.length} perfis de negócios encontrados`);
  return allResults;
}

/**
 * Constrói hashtags de busca baseadas no segmento e cidade
 */
function buildHashtags(city, state, config = null) {
  const cityClean = city
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '');

  const stateClean = state.toLowerCase();

  // Hashtags do segmento
  const segmentTags = config?.busca?.instagramHashtags || [
    'barbearia', 'barber', 'barbershop', 'barbeiro', 'fadebrasileiro',
  ];

  const hashtags = [];

  // Combinações: segmento + cidade
  for (const tag of segmentTags.slice(0, 3)) {
    hashtags.push(`${tag}${cityClean}`);
    hashtags.push(`${tag}${stateClean}`);
  }

  // Hashtags genéricas da cidade
  hashtags.push(`${cityClean}`);

  return hashtags.slice(0, 8); // Limitar para não bater rate limit
}

/**
 * Scrape de perfis que postaram em uma hashtag (via web)
 */
async function scrapeHashtagProfiles(hashtag) {
  try {
    const { data, status } = await axios.get(`https://www.instagram.com/explore/tags/${hashtag}/`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Cookie': '',
      },
      timeout: 10000,
      maxRedirects: 3,
      validateStatus: (s) => s < 500,
    });

    if (status >= 400) return [];

    // Extrair usernames do HTML/JSON embeddado
    const profiles = [];
    const usernamePattern = /"username":"([a-zA-Z0-9_.]+)"/g;
    let match;
    const seen = new Set();

    while ((match = usernamePattern.exec(data)) !== null) {
      const handle = match[1];
      if (!seen.has(handle) && handle !== 'instagram' && handle.length >= 3) {
        seen.add(handle);
        profiles.push({ handle });
      }
    }

    // Também tentar extrair de links de perfil
    const linkPattern = /instagram\.com\/([a-zA-Z0-9_.]{3,30})\//g;
    while ((match = linkPattern.exec(data)) !== null) {
      const handle = match[1];
      const excluded = ['explore', 'p', 'reel', 'stories', 'accounts', 'tags', 'locations', 'directory'];
      if (!seen.has(handle) && !excluded.includes(handle)) {
        seen.add(handle);
        profiles.push({ handle });
      }
    }

    return profiles.slice(0, 20); // Limitar por hashtag
  } catch (err) {
    return [];
  }
}

/**
 * Busca detalhes de um perfil do Instagram (web scraping)
 */
async function fetchProfileDetails(handle) {
  try {
    const { data, status } = await axios.get(`https://www.instagram.com/${handle}/`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'pt-BR,pt;q=0.9',
      },
      timeout: 8000,
      maxRedirects: 3,
      validateStatus: (s) => s < 500,
    });

    if (status === 404 || status === 302) return null;

    const bioMatch = data.match(/"biography":"([^"]*?)"/);
    const followersMatch = data.match(/"edge_followed_by":\{"count":(\d+)\}/);
    const postsMatch = data.match(/"edge_owner_to_timeline_media":\{"count":(\d+)\}/);
    const nameMatch = data.match(/"full_name":"([^"]*?)"/);
    const externalUrlMatch = data.match(/"external_url":"([^"]*?)"/);
    const isBusinessMatch = data.match(/"is_business_account":(true|false)/);

    const bio = bioMatch ? decodeUnicode(bioMatch[1]) : '';
    const externalUrl = externalUrlMatch ? decodeUnicode(externalUrlMatch[1]) : '';

    return {
      nome: nameMatch ? decodeUnicode(nameMatch[1]) : handle,
      bio,
      seguidores: followersMatch ? parseInt(followersMatch[1]) : null,
      posts: postsMatch ? parseInt(postsMatch[1]) : null,
      linkExterno: externalUrl,
      isBusiness: isBusinessMatch?.[1] === 'true',
      temWhatsappLink: externalUrl.includes('wa.me') || externalUrl.includes('whatsapp') || bio.toLowerCase().includes('whatsapp'),
    };
  } catch (err) {
    return null;
  }
}

/**
 * Verifica se um perfil do Instagram é um negócio do segmento
 */
function isBusinessProfile(details, config = null) {
  if (!details) return false;

  const bio = (details.bio || '').toLowerCase();
  const nome = (details.nome || '').toLowerCase();
  const combined = bio + ' ' + nome;

  // Keywords do segmento (do config ou default para barbearias)
  const keywords = config?.busca?.instagramBioKeywords || [
    'barb', 'corte', 'cabelo', 'beard', 'fade', 'degradê',
    'agend', 'hair', 'navalha', 'barbearia',
  ];

  const isSegment = keywords.some(k => combined.includes(k));

  // Filtros adicionais: não é conta pessoal pequena
  const minFollowers = 50;
  if (details.seguidores !== null && details.seguidores < minFollowers) return false;

  // Preferir contas business
  if (details.isBusiness && isSegment) return true;

  // Se tem keywords do segmento e seguidores razoáveis
  if (isSegment && (details.seguidores === null || details.seguidores >= minFollowers)) return true;

  return false;
}

/**
 * Gera handles prováveis para negócios em uma cidade
 */
function generateCityHandles(city, config = null) {
  const cityClean = city
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '');

  const prefixes = config?.busca?.instagramHandlePrefixes || [
    'barbearia', 'barber', 'studio.barber', 'barbearia_',
  ];

  const handles = [];
  for (const prefix of prefixes) {
    handles.push(`${prefix}${cityClean}`);
    handles.push(`${prefix}_${cityClean}`);
    handles.push(`${prefix}.${cityClean}`);
  }

  return handles.slice(0, 12);
}

/**
 * Extrai telefone da bio do Instagram
 */
function extractPhoneFromBio(bio) {
  if (!bio) return '';
  const match = bio.match(/\(?\d{2}\)?\s?9?\s?\d{4}[-.\s]?\d{4}/);
  return match ? match[0] : '';
}

function decodeUnicode(str) {
  return str.replace(/\\u([0-9a-fA-F]{4})/g, (_, code) =>
    String.fromCharCode(parseInt(code, 16))
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { searchInstagram };
