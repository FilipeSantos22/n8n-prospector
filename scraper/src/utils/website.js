const { normalizePhone } = require('./phone');

/**
 * O campo "site" da ficha do Google nem sempre é um site.
 *
 * Negócio pequeno costuma pôr ali o Instagram, o wa.me, um Linktree ou o anúncio
 * no OLX/Webmotors. Contado como site, o lead perdia a pontuação de "sem site
 * próprio" — justamente o sinal que mais pesa no modelo de oportunidade — e o
 * website-analyzer gastava uma requisição analisando o HTML do Instagram.
 * Medido no nicho de veículos, onde isso é a regra, não a exceção.
 */

const DOMINIOS_NAO_PROPRIOS = [
  { tipo: 'instagram', re: /(^|\.)instagram\.com$/ },
  { tipo: 'facebook', re: /(^|\.)(facebook\.com|fb\.com|fb\.me)$/ },
  { tipo: 'whatsapp', re: /(^|\.)(wa\.me|whatsapp\.com|wa\.link)$/ },
  { tipo: 'agregador', re: /(^|\.)(linktr\.ee|linktree\.com|beacons\.ai|bio\.link|taplink\.cc|linkbio\.co|campsite\.bio|lnk\.bio|msha\.ke)$/ },
  { tipo: 'rede_social', re: /(^|\.)(tiktok\.com|youtube\.com|youtu\.be|twitter\.com|x\.com|kwai\.com|linkedin\.com|pinterest\.com)$/ },
  // Anúncio em portal não é site: o estoque fica no layout e nas regras do portal.
  { tipo: 'marketplace', re: /(^|\.)(olx\.com\.br|webmotors\.com\.br|icarros\.com\.br|mobiauto\.com\.br|usadosbr\.com|chavesnamao\.com\.br|napista\.com\.br|mercadolivre\.com\.br|ifood\.com\.br)$/ },
  // Site gratuito do Perfil da Empresa (descontinuado pelo Google em 2024).
  { tipo: 'google', re: /(^|\.)(business\.site|g\.page|goo\.gl|google\.com)$/ },
];

/**
 * @param {string} url - valor do campo website
 * @returns {{ proprio: boolean, tipo: string, instagramHandle?: string, whatsapp?: string }}
 */
function classificarLinkDoSite(url) {
  if (!url) return { proprio: false, tipo: 'vazio' };

  let host;
  let parsed;
  try {
    parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return { proprio: true, tipo: 'proprio' }; // não dá pra afirmar que não é — o analyzer decide
  }

  const achado = DOMINIOS_NAO_PROPRIOS.find(d => d.re.test(host));
  if (!achado) return { proprio: true, tipo: 'proprio' };

  const resultado = { proprio: false, tipo: achado.tipo };

  if (achado.tipo === 'instagram') {
    const handle = parsed.pathname.split('/').filter(Boolean)[0];
    if (handle && !['p', 'reel', 'explore', 'stories'].includes(handle)) {
      resultado.instagramHandle = handle;
    }
  }

  if (achado.tipo === 'whatsapp') {
    const digitos = (parsed.pathname.replace(/\D/g, '') || parsed.searchParams.get('phone') || '').replace(/\D/g, '');
    const numero = normalizePhone(digitos);
    if (numero) resultado.whatsapp = numero;
  }

  return resultado;
}

module.exports = { classificarLinkDoSite };
