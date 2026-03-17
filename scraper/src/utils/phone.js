/**
 * Extração e normalização de telefone/WhatsApp brasileiros
 */

/**
 * Extrai WhatsApp de múltiplas fontes
 * @param {Object} sources - { phone, websiteLinks, instagramBio, googleMapsUrl }
 * @returns {string|null} Número no formato 5511999998888
 */
function extractWhatsApp(sources) {
  // 1. Telefone celular brasileiro do Google (mais confiável)
  const fromPhone = normalizePhone(sources.phone);
  if (fromPhone && isCelular(fromPhone)) {
    return fromPhone;
  }

  // 2. Telefone internacional do Google
  const fromIntl = normalizePhone(sources.phoneInternational);
  if (fromIntl && isCelular(fromIntl)) {
    return fromIntl;
  }

  // 3. Links wa.me encontrados no site
  for (const link of (sources.websiteLinks || [])) {
    const match = link.match(/wa\.me\/(\d{10,13})/);
    if (match) {
      const num = normalizePhone(match[1]);
      if (num) return num;
    }
  }

  // 4. Links api.whatsapp.com
  for (const link of (sources.websiteLinks || [])) {
    const match = link.match(/api\.whatsapp\.com\/send\?phone=(\d+)/);
    if (match) {
      const num = normalizePhone(match[1]);
      if (num) return num;
    }
  }

  // 5. Bio/link do Instagram
  if (sources.instagramBio) {
    // Padrão: (62) 9 9999-9999 ou 62999999999
    const bioMatch = sources.instagramBio.match(/\(?\d{2}\)?\s?9\s?\d{4}[\s.\-]?\d{4}/);
    if (bioMatch) {
      const num = normalizePhone(bioMatch[0]);
      if (num) return num;
    }
  }

  if (sources.instagramLink) {
    const match = sources.instagramLink.match(/wa\.me\/(\d{10,13})/);
    if (match) {
      const num = normalizePhone(match[1]);
      if (num) return num;
    }
  }

  return null;
}

/**
 * Normaliza telefone brasileiro para formato E.164 sem +
 * @param {string} phone - Telefone em qualquer formato
 * @returns {string|null} 5562999998888 ou null se inválido
 */
function normalizePhone(phone) {
  if (!phone) return null;

  let clean = phone.toString().replace(/[\s\(\)\-\.+]/g, '');

  // Remover zero à esquerda do DDD
  if (clean.startsWith('0') && clean.length === 11) {
    clean = clean.substring(1);
  }

  // Adicionar código do Brasil se não tem
  if (!clean.startsWith('55') && (clean.length === 10 || clean.length === 11)) {
    clean = '55' + clean;
  }

  // Celular sem o 9: 55 + DD(2) + XXXX-XXXX = 12 dígitos → adicionar 9
  if (clean.length === 12 && clean.startsWith('55')) {
    const ddd = clean.substring(2, 4);
    const number = clean.substring(4);
    // Verificar se é celular (começa com 6,7,8,9)
    if (['6', '7', '8', '9'].includes(number[0])) {
      clean = '55' + ddd + '9' + number;
    }
  }

  // Validar formato final: 55 + DD(2) + 9 + XXXX-XXXX = 13 dígitos
  if (clean.length === 13 && clean.startsWith('55')) {
    return clean;
  }

  // Telefone fixo: 55 + DD(2) + XXXX-XXXX = 12 dígitos
  if (clean.length === 12 && clean.startsWith('55')) {
    return clean; // retorna mesmo, mas isCelular vai dizer se é WhatsApp
  }

  return null;
}

/**
 * Verifica se é número de celular (tem 9 na frente)
 */
function isCelular(phone) {
  if (!phone || phone.length !== 13) return false;
  return phone[4] === '9';
}

/**
 * Extrai todos os links de WhatsApp de um HTML
 */
function extractWhatsAppLinks(html) {
  const links = [];
  const patterns = [
    /(?:https?:\/\/)?(?:api\.)?wa\.me\/(\d{10,13})/gi,
    /(?:https?:\/\/)?api\.whatsapp\.com\/send\?phone=(\d{10,13})/gi,
    /(?:https?:\/\/)?web\.whatsapp\.com\/send\?phone=(\d{10,13})/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const num = normalizePhone(match[1]);
      if (num) links.push(num);
    }
  }

  return [...new Set(links)];
}

module.exports = { extractWhatsApp, normalizePhone, isCelular, extractWhatsAppLinks };
