const axios = require('axios');
const { extractWhatsAppLinks } = require('../utils/phone');

// Concorrentes de agendamento — incluindo brasileiros
const COMPETITORS = {
  booksy: /booksy\.com|booksy\b/i,
  trinks: /trinks\.com|trinks\b/i,
  simpleag: /simpleag/i,
  setmore: /setmore\.com|setmore\b/i,
  calendly: /calendly\.com|calendly\b/i,
  agendor: /agendor\.com|agendor\b/i,
  goldie: /goldie\.io|goldie\b/i,
  fresha: /fresha\.com|fresha\b/i,
  mindbody: /mindbody\.com|mindbody\b/i,
  vagaro: /vagaro\.com|vagaro\b/i,
  square: /squareup.*appointment|square.*appointment/i,
  avec: /avec\.digital|avec\b/i,
  barzelink: /barzelink/i,
  barberapp: /barberapp/i,
  grazy: /grazy\.app/i,
  beautydock: /beautydock/i,
  glamapp: /glamapp/i,
  zenoti: /zenoti/i,
};

/**
 * Analisa o website de uma barbearia
 * Detecta: concorrentes, contatos, redes sociais, maturidade digital
 */
async function analyzeWebsite(url) {
  if (!url) return { analyzed: false, reason: 'sem_website' };

  try {
    const { data: html, status } = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
      timeout: 10000,
      maxRedirects: 5,
      validateStatus: (s) => s < 500,
    });

    if (status >= 400) return { analyzed: false, reason: 'site_offline' };

    const htmlLower = html.toLowerCase();

    // 1. Detectar concorrentes
    const competitorsFound = [];
    for (const [name, regex] of Object.entries(COMPETITORS)) {
      if (regex.test(html)) {
        competitorsFound.push(name);
      }
    }

    // 2. WhatsApp links (usando módulo otimizado)
    const whatsappLinks = extractWhatsAppLinks(html);

    // 3. Telefones
    const phoneRegex = /(?:\+55\s?)?(?:\(?\d{2}\)?\s?)?\d{4,5}[-.\s]?\d{4}/g;
    const phones = [...new Set((html.match(phoneRegex) || []).slice(0, 5))];

    // 4. Emails
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const emails = [...new Set(
      (html.match(emailRegex) || [])
        .filter(e => !e.includes('example') && !e.includes('sentry') && !e.includes('wixpress'))
        .slice(0, 3)
    )];

    // 5. Redes sociais (ampliado)
    const socialMedia = extractSocialMedia(html);

    // 6. Meta tags
    const metaTags = extractMetaTags(html);

    // 7. Funcionalidades
    const temAgendamentoOnline = htmlLower.includes('agend') && (htmlLower.includes('horário') || htmlLower.includes('disponív'));
    const temPrecos = htmlLower.includes('preço') || htmlLower.includes('preco') || /R\$\s?\d+/i.test(html);
    const temFormulario = /<form/i.test(html);
    const temChat = /tawk\.to|tidio|zendesk|intercom|crisp|jivochat/i.test(html);

    // 8. Maturidade digital (0-10)
    let maturidade = 0;
    if (html.length > 10000) maturidade += 1;
    if (html.length > 50000) maturidade += 1;
    if (temPrecos) maturidade += 1;
    if (temFormulario) maturidade += 1;
    if (temAgendamentoOnline) maturidade += 2;
    if (competitorsFound.length > 0) maturidade += 2;
    if (Object.keys(socialMedia).length > 0) maturidade += 1;
    if (url.startsWith('https')) maturidade += 1;
    if (temChat) maturidade += 1;

    return {
      analyzed: true,
      url,
      competitorsFound,
      usaConcorrente: competitorsFound.length > 0,
      temAgendamentoOnline,
      temPrecos,
      temFormulario,
      temChat,
      whatsappLinks,
      phones,
      emails,
      socialMedia,
      metaTags,
      maturidadeDigital: Math.min(10, maturidade),
    };
  } catch (err) {
    return {
      analyzed: false,
      url,
      reason: err.code === 'ECONNREFUSED' ? 'site_offline' : err.message,
    };
  }
}

/**
 * Extrai links de redes sociais do HTML
 */
function extractSocialMedia(html) {
  const social = {};

  // Instagram
  const igPatterns = [
    /href="(?:https?:\/\/)?(?:www\.)?instagram\.com\/([a-zA-Z0-9_.]+)\/?"/i,
    /instagram\.com\/([a-zA-Z0-9_.]+)/i,
  ];
  for (const pattern of igPatterns) {
    const match = html.match(pattern);
    if (match && !['p', 'reel', 'stories', 'explore', 'accounts'].includes(match[1])) {
      social.instagram = match[1];
      break;
    }
  }

  // Facebook
  const fbMatch = html.match(/(?:facebook|fb)\.com\/([a-zA-Z0-9_.]+)/i);
  if (fbMatch && !['sharer', 'share', 'dialog', 'plugins'].includes(fbMatch[1])) {
    social.facebook = fbMatch[1];
  }

  // TikTok
  const tiktokMatch = html.match(/tiktok\.com\/@([a-zA-Z0-9_.]+)/i);
  if (tiktokMatch) social.tiktok = tiktokMatch[1];

  // YouTube
  const ytMatch = html.match(/youtube\.com\/(?:c\/|channel\/|@)([a-zA-Z0-9_-]+)/i);
  if (ytMatch) social.youtube = ytMatch[1];

  return social;
}

/**
 * Extrai meta tags relevantes
 */
function extractMetaTags(html) {
  const metas = {};

  const ogDescMatch = html.match(/<meta\s+(?:property|name)="og:description"\s+content="([^"]+)"/i);
  if (ogDescMatch) metas.ogDescription = ogDescMatch[1];

  const descMatch = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
  if (descMatch) metas.description = descMatch[1];

  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) metas.title = titleMatch[1].trim();

  return metas;
}

module.exports = { analyzeWebsite };
