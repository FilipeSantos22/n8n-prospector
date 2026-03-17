/**
 * Análise de reviews do Google Maps
 * Detecta dores, reclamações e sinais de necessidade de agendamento
 */

// Fallback hardcoded (usado se nenhum config for passado)
const DEFAULT_PAIN_KEYWORDS = {
  fila: /\b(fila|espera|esper[eiao]|demorou|demora|atras[oa]d?[oa]?|aguard)\b/i,
  agendamento: /\b(agenda[r]?|agend|marca[rç]|marcação|horário|ligar para|sem hora|por ordem)\b/i,
  organizacao: /\b(desorganizad|bagunça|confus|perdid|caótic|perdeu)\b/i,
  atendimento_ruim: /\b(mal atendid|grosso|grosseria|falta de educação|desrespeit)\b/i,
  lotado: /\b(lotad|chei[oa]|muita gente|muito mov|superlotad)\b/i,
};

const DEFAULT_POSITIVE_SCHEDULING = /\b(agend.*fácil|fácil.*agend|app.*ótimo|sistema.*bom|agenda.*online|marc.*online|pratic|sem espera)\b/i;

const DEFAULT_SCHEDULING_PAIN_KEYS = ['fila', 'agendamento', 'lotado'];

/**
 * Analisa reviews para detectar dores e oportunidades
 * @param {Array} reviews - Array de reviews { autor, nota, texto, tempo }
 * @param {Object} config - Config do segmento (opcional)
 * @returns {Object} Resultado da análise
 */
function analyzeReviews(reviews, config = null) {
  if (!reviews || reviews.length === 0) {
    return { analyzed: false, reason: 'sem_reviews' };
  }

  const painKeywords = config ? config.analise.painKeywords : DEFAULT_PAIN_KEYWORDS;
  const positiveScheduling = config ? config.analise.positiveKeywords : DEFAULT_POSITIVE_SCHEDULING;
  const schedulingPainKeys = config ? config.analise.schedulingPainKeys : DEFAULT_SCHEDULING_PAIN_KEYS;

  const painCounts = {};
  const painExamples = {};
  let totalNegative = 0;
  let totalPositive = 0;
  let hasSchedulingPraise = false;

  for (const review of reviews) {
    const text = review.texto || review.text || '';
    const nota = review.nota || review.rating || 0;

    if (nota <= 3) totalNegative++;
    if (nota >= 4) totalPositive++;

    // Detectar dores
    for (const [pain, regex] of Object.entries(painKeywords)) {
      if (regex.test(text)) {
        painCounts[pain] = (painCounts[pain] || 0) + 1;
        if (!painExamples[pain]) {
          painExamples[pain] = text.substring(0, 120) + (text.length > 120 ? '...' : '');
        }
      }
    }

    // Detectar elogios ao agendamento (já resolveram o problema)
    if (positiveScheduling.test(text)) {
      hasSchedulingPraise = true;
    }
  }

  const schedulingPainCount = schedulingPainKeys.reduce(
    (sum, key) => sum + (painCounts[key] || 0), 0
  );

  return {
    analyzed: true,
    totalReviews: reviews.length,
    totalNegative,
    totalPositive,
    painCounts,
    painExamples,
    hasSchedulingPain: schedulingPainCount >= 2,
    schedulingPainCount,
    hasSchedulingPraise,
    hasOrganizationIssues: (painCounts.organizacao || 0) >= 1,
    avgRating: reviews.reduce((sum, r) => sum + (r.nota || r.rating || 0), 0) / reviews.length,
    painSummary: Object.entries(painCounts)
      .sort(([, a], [, b]) => b - a)
      .map(([pain, count]) => `${pain} (${count}x)`)
      .join(', '),
  };
}

module.exports = { analyzeReviews };
