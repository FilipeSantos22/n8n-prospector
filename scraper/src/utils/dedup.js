/**
 * Deduplicação avançada de leads
 * Usa place_id + nome normalizado + distância geográfica
 */

// Palavras genéricas removidas na normalização (independente de segmento)
const GENERIC_WORDS = /studio|salao|salão|shop|center|centro|espaco|espaço/gi;

/**
 * Deduplica leads usando múltiplos critérios
 * @param {Array} leads - Array de leads (podem vir de múltiplas fontes)
 * @param {Object} config - Config do segmento (opcional, melhora normalização)
 * @returns {Array} Leads únicos
 */
function deduplicateLeads(leads, config = null) {
  const segmentWords = buildSegmentRegex(config);
  const unique = new Map(); // place_id → lead
  const nameIndex = [];     // para comparação por nome+distância

  for (const lead of leads) {
    // 1. Dedup por place_id (mais confiável)
    if (lead.place_id) {
      if (unique.has(lead.place_id)) {
        // Merge: manter o que tem mais dados
        const existing = unique.get(lead.place_id);
        unique.set(lead.place_id, mergeLead(existing, lead));
        continue;
      }
    }

    // 2. Dedup por nome normalizado + proximidade geográfica
    const nameKey = normalizeName(lead.nome, segmentWords);
    let isDuplicate = false;

    for (const entry of nameIndex) {
      if (nameSimilarity(nameKey, entry.nameKey) > 0.75) {
        // Nomes similares — verificar distância
        if (lead.lat && entry.lead.lat) {
          const dist = haversineDistance(lead.lat, lead.lng, entry.lead.lat, entry.lead.lng);
          if (dist < 300) { // menos de 300m = provavelmente o mesmo lugar
            // Merge com o existente
            const mergedKey = entry.lead.place_id || entry.nameKey;
            const existing = unique.get(mergedKey);
            if (existing) {
              unique.set(mergedKey, mergeLead(existing, lead));
            }
            isDuplicate = true;
            break;
          }
        } else {
          // Sem coordenadas — comparar endereço
          const addrSim = addressSimilarity(lead.endereco, entry.lead.endereco);
          if (addrSim > 0.7) {
            // Merge
            const mergedKey = entry.lead.place_id || entry.nameKey;
            const existing = unique.get(mergedKey);
            if (existing) {
              unique.set(mergedKey, mergeLead(existing, lead));
            }
            isDuplicate = true;
            break;
          }
        }
      }
    }

    if (!isDuplicate) {
      const key = lead.place_id || `name:${nameKey}:${lead.lat || ''}`;
      unique.set(key, lead);
      nameIndex.push({ nameKey, lead });
    }
  }

  return [...unique.values()];
}

/**
 * Merge dois registros do mesmo lead, preferindo dados mais completos
 */
function mergeLead(existing, newLead) {
  return {
    ...existing,
    // Preferir dados do Google Maps (mais confiáveis)
    place_id: existing.place_id || newLead.place_id,
    nome: existing.nome || newLead.nome,
    endereco: existing.endereco || newLead.endereco,
    lat: existing.lat || newLead.lat,
    lng: existing.lng || newLead.lng,
    rating: existing.rating || newLead.rating,
    totalAvaliacoes: Math.max(existing.totalAvaliacoes || 0, newLead.totalAvaliacoes || 0),
    telefone: existing.telefone || newLead.telefone,
    website: existing.website || newLead.website,
    email: existing.email || newLead.email,
    cnpj: existing.cnpj || newLead.cnpj,
    instagram: existing.instagram?.found ? existing.instagram : (newLead.instagram || existing.instagram),
    // Manter fontes
    sources: [...new Set([...(existing.sources || [existing.source]), newLead.source])],
  };
}

/**
 * Constrói regex para remover palavras do segmento na normalização
 */
function buildSegmentRegex(config) {
  if (!config) {
    // Fallback: palavras mais comuns de todos os segmentos
    return /barbearia|barber|clinica|clínica|estetica|estética|pet\s?shop|salao|salão|studio/gi;
  }

  const words = new Set();
  const singular = config.qualificacao?.segmentoSingular || '';
  const plural = config.qualificacao?.segmentoPlural || '';

  // Adicionar singular e plural
  if (singular) words.add(escapeRegex(singular));
  if (plural) {
    words.add(escapeRegex(plural));
    // Também adicionar cada palavra do plural separadamente
    for (const w of plural.split(/\s+/)) {
      if (w.length > 2) words.add(escapeRegex(w));
    }
  }

  // Adicionar keywords de busca que são nomes de segmento
  for (const q of (config.busca?.queries || [])) {
    const qWords = q.split(/\s+/);
    for (const w of qWords) {
      if (w.length > 3) words.add(escapeRegex(w));
    }
  }

  if (words.size === 0) return GENERIC_WORDS;

  const pattern = [...words].join('|');
  return new RegExp(pattern, 'gi');
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normaliza nome para comparação
 */
function normalizeName(name, segmentWords = null) {
  const regex = segmentWords || /barbearia|barber\s?shop|studio|salao|salão|barber|clinica|clínica|estetica|estética/gi;
  return (name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(regex, '')
    .replace(GENERIC_WORDS, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/**
 * Similaridade entre dois nomes (0-1)
 * Usa containment + Dice coefficient
 */
function nameSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;

  // Containment: um contém o outro
  if (a.includes(b) || b.includes(a)) return 0.9;

  // Dice coefficient com bigrams
  const bigramsA = getBigrams(a);
  const bigramsB = getBigrams(b);
  const intersection = bigramsA.filter(bg => bigramsB.includes(bg));
  return (2 * intersection.length) / (bigramsA.length + bigramsB.length);
}

function getBigrams(str) {
  const bigrams = [];
  for (let i = 0; i < str.length - 1; i++) {
    bigrams.push(str.substring(i, i + 2));
  }
  return bigrams;
}

/**
 * Similaridade de endereço simplificada
 */
function addressSimilarity(a, b) {
  if (!a || !b) return 0;
  const cleanA = a.toLowerCase().replace(/[^a-z0-9]/g, '');
  const cleanB = b.toLowerCase().replace(/[^a-z0-9]/g, '');
  return nameSimilarity(cleanA, cleanB);
}

/**
 * Distância entre dois pontos em metros (Haversine)
 */
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000; // raio da Terra em metros
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

module.exports = { deduplicateLeads, normalizeName, haversineDistance };
