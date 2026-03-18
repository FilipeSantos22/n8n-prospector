const axios = require('axios');
const { extractWhatsAppLinks } = require('../utils/phone');

// Fallback hardcoded (usado se nenhum config for passado)
const DEFAULT_COMPETITORS = {
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
 * Detecta o CMS/plataforma do website a partir do HTML
 */
function detectCMS(html) {
  if (/wp-content|wp-includes|wordpress/i.test(html)) return 'wordpress';
  if (/meta[^>]+name="generator"[^>]+content="Wix|wixsite\.com|wix\.com/i.test(html)) return 'wix';
  if (/squarespace|sqsp/i.test(html)) return 'squarespace';
  if (/godaddy/i.test(html)) return 'godaddy';
  if (/webflow/i.test(html)) return 'webflow';
  if (/cdn\.shopify|shopify/i.test(html)) return 'shopify';
  return 'unknown';
}

/**
 * Detecta pixels e ferramentas de analytics no HTML
 */
function detectAnalytics(html) {
  const hasGoogleAnalytics = /gtag\(|google-analytics\.com|ga\.js|gtm\.js|['"](G-|UA-|GT-)[A-Z0-9]/i.test(html);
  const hasFacebookPixel = /fbq\(|connect\.facebook\.net|facebook.*pixel/i.test(html);
  const hasTikTokPixel = /analytics\.tiktok/i.test(html);
  const hasHotjar = /hotjar/i.test(html);

  return { hasGoogleAnalytics, hasFacebookPixel, hasTikTokPixel, hasHotjar };
}

/**
 * Detecta gateways de pagamento no HTML
 */
function detectPaymentGateways(html) {
  const gateways = [];
  if (/pagseguro/i.test(html)) gateways.push('pagseguro');
  if (/mercadopago|mercadolivre/i.test(html)) gateways.push('mercadopago');
  if (/js\.stripe\.com|stripe\.com/i.test(html)) gateways.push('stripe');
  if (/paypal/i.test(html)) gateways.push('paypal');
  if (/picpay/i.test(html)) gateways.push('picpay');

  return gateways;
}

/**
 * Analisa o website de um estabelecimento
 * Detecta: concorrentes, contatos, redes sociais, maturidade digital,
 *          CMS, analytics, pixels, gateways de pagamento e responsividade mobile
 */
async function analyzeWebsite(url, config = null) {
  if (!url) return { analyzed: false, reason: 'sem_website' };

  const competitors = config ? config.analise.competitors : DEFAULT_COMPETITORS;

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
    for (const [name, regex] of Object.entries(competitors)) {
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

    // 8. CMS / Plataforma
    const cms = detectCMS(html);

    // 9. Analytics e pixels
    const { hasGoogleAnalytics, hasFacebookPixel, hasTikTokPixel, hasHotjar } = detectAnalytics(html);

    // 10. Gateways de pagamento
    const paymentGateways = detectPaymentGateways(html);
    const hasPaymentGateway = paymentGateways.length > 0;

    // 11. Responsividade mobile
    const isMobileResponsive = /meta[^>]+name="viewport"[^>]+content="[^"]*width=device-width/i.test(html);

    // 12. Tech stack consolidado
    const techStack = {
      cms,
      analytics: {
        googleAnalytics: hasGoogleAnalytics,
        facebookPixel: hasFacebookPixel,
        tikTokPixel: hasTikTokPixel,
        hotjar: hasHotjar,
      },
      payments: paymentGateways,
      chat: temChat,
      mobileResponsive: isMobileResponsive,
    };

    // 13. Maturidade digital (0-10)
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
    // Novos sinais de maturidade
    if (hasGoogleAnalytics) maturidade += 1;
    if (hasFacebookPixel) maturidade += 1;
    if (hasPaymentGateway) maturidade += 1;
    if (isMobileResponsive) maturidade += 1;
    if (cms !== 'unknown') maturidade += 1;

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
      // Novos campos
      cms,
      hasGoogleAnalytics,
      hasFacebookPixel,
      hasPaymentGateway,
      paymentGateways,
      isMobileResponsive,
      techStack,
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
