const axios = require('axios');

/**
 * Verifica perfil público do Instagram — busca multi-fonte
 * 1. Handle direto (do site/Google Maps)
 * 2. Geração de handles possíveis pelo nome
 */
async function checkInstagram(nameOrHandle, knownHandle = null, config = null) {
  // Se já temos o handle (do site ou Google), tentar primeiro
  if (knownHandle) {
    const clean = knownHandle.replace(/^@/, '').replace(/\/$/, '');
    const result = await fetchInstagramProfile(clean, config);
    if (result) {
      return { ...result, handle: clean, found: true, source: 'known_handle' };
    }
  }

  // Gerar possíveis handles a partir do nome
  const handles = generateHandles(nameOrHandle, config);

  for (const handle of handles) {
    try {
      const result = await fetchInstagramProfile(handle, config);
      if (result) {
        return { ...result, handle, found: true, source: 'generated_handle' };
      }
    } catch (err) {
      // Ignorar erros silenciosamente
    }
    // Rate limit entre tentativas
    await sleep(500);
  }

  return { found: false, handle: null };
}

/**
 * Gera possíveis usernames do Instagram baseado no nome do estabelecimento
 */
function generateHandles(nome, config = null) {
  const clean = nome
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim();

  const words = clean.split(/\s+/);
  const handles = new Set();

  // Combinações genéricas (funciona para qualquer segmento)
  handles.add(clean.replace(/\s+/g, ''));
  handles.add(clean.replace(/\s+/g, '_'));
  handles.add(clean.replace(/\s+/g, '.'));
  handles.add(words.join(''));
  handles.add(words.join('_'));

  // Palavras do segmento para manipular no nome
  const segmentWords = getSegmentWords(config);
  const firstWord = words[0];
  const isSegmentPrefix = segmentWords.some(sw => firstWord === sw || firstWord.startsWith(sw));

  if (isSegmentPrefix && words.length > 1) {
    const rest = words.slice(1);
    handles.add(firstWord + rest.join(''));
    handles.add(firstWord + '_' + rest.join('_'));
    handles.add(rest.join(''));
    handles.add(rest.join('_'));
    handles.add(rest.join('.'));
  }

  // Com prefixos do segmento
  const prefixes = config?.busca?.instagramHandlePrefixes || ['barbearia', 'barber'];
  if (!isSegmentPrefix) {
    for (const prefix of prefixes.slice(0, 2)) {
      handles.add(prefix + clean.replace(/\s+/g, ''));
      handles.add(prefix + '_' + clean.replace(/\s+/g, '_'));
    }
  }

  // Com sufixos comuns
  const mainWord = words.length > 1 ? words.slice(1).join('') : words[0];
  handles.add(mainWord + 'oficial');
  handles.add(mainWord + '_oficial');

  return [...handles].filter(h => h.length >= 3 && h.length <= 30).slice(0, 6);
}

/**
 * Tenta acessar perfil público do Instagram via web
 */
async function fetchInstagramProfile(handle, config = null) {
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

    // Extrair dados básicos do HTML
    const bioMatch = data.match(/"biography":"([^"]*?)"/);
    const followersMatch = data.match(/"edge_followed_by":\{"count":(\d+)\}/);
    const postsMatch = data.match(/"edge_owner_to_timeline_media":\{"count":(\d+)\}/);
    const nameMatch = data.match(/"full_name":"([^"]*?)"/);
    const externalUrlMatch = data.match(/"external_url":"([^"]*?)"/);
    const isBusinessMatch = data.match(/"is_business_account":(true|false)/);

    // Verificar se é realmente do segmento (usando keywords do config)
    const bio = bioMatch ? decodeUnicode(bioMatch[1]) : '';
    const bioKeywords = config?.busca?.instagramBioKeywords || [
      'barb', 'corte', 'cabelo', 'beard', 'fade', 'degradê', 'agend', 'hair', 'navalha',
    ];
    const isSegment = bioKeywords.some(k => bio.toLowerCase().includes(k));

    if (!isSegment && !isBusinessMatch) return null;

    const externalUrl = externalUrlMatch ? decodeUnicode(externalUrlMatch[1]) : '';
    const temWhatsappLink = externalUrl.includes('wa.me') || externalUrl.includes('whatsapp') || bio.includes('whatsapp');
    const temAgendamentoOnline = /booksy|trinks|calendly|linktree|linktr\.ee|agende|agendamento|avec|fresha/i.test(externalUrl + ' ' + bio);

    return {
      nome: nameMatch ? decodeUnicode(nameMatch[1]) : handle,
      bio,
      seguidores: followersMatch ? parseInt(followersMatch[1]) : null,
      posts: postsMatch ? parseInt(postsMatch[1]) : null,
      linkExterno: externalUrl,
      isBusiness: isBusinessMatch?.[1] === 'true',
      temWhatsappLink,
      temAgendamentoOnline,
      url: `https://www.instagram.com/${handle}/`,
    };
  } catch (err) {
    return null;
  }
}

/**
 * Retorna palavras do segmento normalizadas (sem acento, lowercase)
 */
function getSegmentWords(config) {
  if (!config) return ['barbearia', 'barber', 'studio'];
  const singular = (config.qualificacao?.segmentoSingular || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const plural = (config.qualificacao?.segmentoPlural || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Extrair palavras individuais
  const words = new Set([singular, plural, 'studio']);
  for (const w of plural.split(/\s+/)) { if (w.length > 2) words.add(w); }
  return [...words].filter(Boolean);
}

function decodeUnicode(str) {
  return str.replace(/\\u([0-9a-fA-F]{4})/g, (_, code) =>
    String.fromCharCode(parseInt(code, 16))
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { checkInstagram, generateHandles };
