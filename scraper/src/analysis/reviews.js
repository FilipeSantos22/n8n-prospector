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

// Palavras de negação que invalidam uma detecção de dor
const NEGATION_WORDS = /\b(nunca|não|nao|sem|nenhum|jamais|zero|nada de)\b/i;

// Sinaliza agendamento manual nas respostas do dono
const OWNER_MANUAL_SCHEDULING = /\b(ligue para marcar|ligar para marcar|mande whatsapp|chame no whatsapp|chama no whatsapp|entre em contato para agendar|nos chame|fale conosco para marcar|whatsapp para agendar|agendar pelo whatsapp|marcar pelo whatsapp)\b/i;

// Sinaliza caos de agenda / no-show
const NOSHOW_CHAOS_KEYWORDS = /\b(marquei e não atenderam|marquei e nao atenderam|fui e estava lotado|horário errado|horario errado|cancelou meu horário|cancelou meu horario|não apareceu|nao apareceu|não foi atendid|nao foi atendid|meu horário não foi|meu horario nao foi)\b/i;

/**
 * Verifica se há palavra de negação nas N palavras anteriores ao match
 * @param {string} text - Texto completo
 * @param {number} matchIndex - Índice onde o match ocorreu
 * @param {number} lookback - Número de palavras para trás a verificar (default 5)
 * @returns {boolean} true se negado
 */
function isNegated(text, matchIndex, lookback = 5) {
  const before = text.substring(0, matchIndex);
  const words = before.split(/\s+/);
  const window = words.slice(-lookback).join(' ');
  return NEGATION_WORDS.test(window);
}

/**
 * Faz match de regex verificando negação antes do match
 * @param {RegExp} regex - Expressão regular (sem flag g)
 * @param {string} text - Texto a testar
 * @returns {boolean} true se houve match real (não negado)
 */
function matchWithNegationCheck(regex, text) {
  // Cria versão global da regex para encontrar todos os matches e seus índices
  const globalRegex = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  let match;
  while ((match = globalRegex.exec(text)) !== null) {
    if (!isNegated(text, match.index)) {
      return true;
    }
  }
  return false;
}

/**
 * Converte campo "tempo" textual para número de meses aproximado
 * Suporta: "2 semanas atrás", "3 meses atrás", "1 ano atrás", "há 2 meses", etc.
 * @param {string} tempo
 * @returns {number} meses (0 se não reconhecido / muito recente)
 */
function tempoToMonths(tempo) {
  if (!tempo || typeof tempo !== 'string') return 6; // assume médio se desconhecido

  const t = tempo.toLowerCase().trim();

  // semanas
  const semMatch = t.match(/(\d+)\s*semana/);
  if (semMatch) return parseInt(semMatch[1], 10) / 4;

  // dias
  const diaMatch = t.match(/(\d+)\s*dia/);
  if (diaMatch) return parseInt(diaMatch[1], 10) / 30;

  // meses
  const mesMatch = t.match(/(\d+)\s*m[eê]s/);
  if (mesMatch) return parseInt(mesMatch[1], 10);

  // anos
  const anoMatch = t.match(/(\d+)\s*ano/);
  if (anoMatch) return parseInt(anoMatch[1], 10) * 12;

  // "há pouco", "recentemente", "ontem", "hoje"
  if (/hoje|agora|ontem|recente|pouco/.test(t)) return 0.1;

  // "uma semana", "um mês", etc.
  if (/uma?\s*semana/.test(t)) return 0.25;
  if (/um\s*m[eê]s/.test(t)) return 1;
  if (/um\s*ano/.test(t)) return 12;

  return 6; // fallback conservador
}

/**
 * Calcula peso de recência baseado em meses
 * Reviews mais recentes têm peso maior
 * @param {number} months
 * @returns {number} peso entre 0 e 3
 */
function recencyWeight(months) {
  if (months <= 1) return 3;
  if (months <= 3) return 2;
  return 1 / (1 + months * 0.2);
}

/**
 * Extrai texto de resposta do dono de um review
 * @param {Object} review
 * @returns {string|null}
 */
function getOwnerResponse(review) {
  return review.ownerResponse || review.resposta_dono || review.owner_response || null;
}

/**
 * Analisa as respostas do dono para detectar sinais de agendamento manual
 * @param {Array} reviews
 * @returns {Object}
 */
function analyzeOwnerResponses(reviews) {
  let totalWithResponse = 0;
  let manualSchedulingSignals = 0;
  const manualExamples = [];

  for (const review of reviews) {
    const ownerText = getOwnerResponse(review);
    if (!ownerText) continue;

    totalWithResponse++;

    if (OWNER_MANUAL_SCHEDULING.test(ownerText)) {
      manualSchedulingSignals++;
      if (manualExamples.length < 2) {
        manualExamples.push(ownerText.substring(0, 120) + (ownerText.length > 120 ? '...' : ''));
      }
    }
  }

  const responseRate = reviews.length > 0 ? totalWithResponse / reviews.length : 0;

  return {
    ownerRespondsToReviews: totalWithResponse > 0,
    ownerResponseCount: totalWithResponse,
    ownerResponseRate: Math.round(responseRate * 100) / 100,
    ownerMentionsManualScheduling: manualSchedulingSignals > 0,
    ownerManualSchedulingCount: manualSchedulingSignals,
    ownerManualSchedulingExamples: manualExamples,
    // Sinal forte: dono digitalmente engajado MAS usa WhatsApp/ligação para agendar
    ownerDigitallyEngagedButManual: totalWithResponse > 0 && manualSchedulingSignals > 0,
  };
}

/**
 * Analisa velocidade de reviews (recentes vs geral)
 * @param {Array} reviews - Com campo tempo
 * @returns {Object}
 */
function analyzeReviewVelocity(reviews) {
  const recentMonths = 3;
  let recentCount = 0;

  for (const review of reviews) {
    const months = tempoToMonths(review.tempo || review.time || '');
    if (months <= recentMonths) recentCount++;
  }

  const totalMonths = reviews.length > 0 ? (() => {
    // estima período total baseado no review mais antigo
    let maxMonths = 0;
    for (const r of reviews) {
      const m = tempoToMonths(r.tempo || r.time || '');
      if (m > maxMonths) maxMonths = m;
    }
    return maxMonths || 12; // fallback 12 meses
  })() : 12;

  const overallPerMonth = totalMonths > 0 ? reviews.length / totalMonths : 0;
  const recentPerMonth = recentCount / recentMonths;

  const velocityRatio = overallPerMonth > 0 ? recentPerMonth / overallPerMonth : (recentCount > 0 ? 2 : 1);

  return {
    recentReviewCount: recentCount,
    recentReviewMonths: recentMonths,
    reviewsPerMonthRecent: Math.round(recentPerMonth * 10) / 10,
    reviewsPerMonthOverall: Math.round(overallPerMonth * 10) / 10,
    velocityRatio: Math.round(velocityRatio * 100) / 100,
    growingFast: velocityRatio > 1.5,
  };
}

/**
 * Analisa distribuição de notas — detecta distribuição bimodal
 * (muitos 5★ E muitos 1-2★ = ótimo serviço mas caos operacional = lead ideal)
 * @param {Array} reviews
 * @returns {Object}
 */
function analyzeRatingDistribution(reviews) {
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

  for (const r of reviews) {
    const nota = Math.round(r.nota || r.rating || 0);
    if (nota >= 1 && nota <= 5) dist[nota]++;
  }

  const total = reviews.length || 1;
  const pct = {};
  for (const k of Object.keys(dist)) {
    pct[k] = Math.round((dist[k] / total) * 100);
  }

  const highStarPct = pct[5];
  const lowStarPct = pct[1] + pct[2];

  // Bimodal: >= 50% notas 5 e >= 15% notas 1-2
  const isBimodal = highStarPct >= 50 && lowStarPct >= 15;

  return {
    ratingDistribution: dist,
    ratingDistributionPct: pct,
    bimodalDistribution: isBimodal,
    highRatingPct: highStarPct,
    lowRatingPct: lowStarPct,
    // Bimodal = ótimo serviço + caos operacional = lead perfeito para Bookou
    bimodalLeadSignal: isBimodal,
  };
}

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

  const painCounts = {};         // contagem bruta (não ponderada)
  const painCountsWeighted = {}; // contagem ponderada por recência
  const painExamples = {};
  let totalNegative = 0;
  let totalPositive = 0;
  let hasSchedulingPraise = false;
  let noshowChaosCount = 0;
  const noshowExamples = [];

  for (const review of reviews) {
    const text = review.texto || review.text || '';
    const nota = review.nota || review.rating || 0;
    const months = tempoToMonths(review.tempo || review.time || '');
    const weight = recencyWeight(months);

    if (nota <= 3) totalNegative++;
    if (nota >= 4) totalPositive++;

    // Detectar dores com verificação de negação e peso de recência
    for (const [pain, regex] of Object.entries(painKeywords)) {
      if (matchWithNegationCheck(regex, text)) {
        painCounts[pain] = (painCounts[pain] || 0) + 1;
        painCountsWeighted[pain] = (painCountsWeighted[pain] || 0) + weight;
        if (!painExamples[pain]) {
          painExamples[pain] = text.substring(0, 120) + (text.length > 120 ? '...' : '');
        }
      }
    }

    // Detectar elogios ao agendamento (já resolveram o problema)
    if (positiveScheduling.test(text)) {
      hasSchedulingPraise = true;
    }

    // Detectar sinais de no-show / caos de agenda
    if (NOSHOW_CHAOS_KEYWORDS.test(text)) {
      noshowChaosCount++;
      if (noshowExamples.length < 3) {
        noshowExamples.push(text.substring(0, 120) + (text.length > 120 ? '...' : ''));
      }
    }
  }

  // Usar contagem ponderada para scheduling pain
  const schedulingPainCount = schedulingPainKeys.reduce(
    (sum, key) => sum + (painCounts[key] || 0), 0
  );
  const schedulingPainWeighted = schedulingPainKeys.reduce(
    (sum, key) => sum + (painCountsWeighted[key] || 0), 0
  );

  // Análises adicionais
  const ownerAnalysis = analyzeOwnerResponses(reviews);
  const velocityAnalysis = analyzeReviewVelocity(reviews);
  const distributionAnalysis = analyzeRatingDistribution(reviews);

  return {
    // — campos originais —
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
    avgRating: Math.round(
      (reviews.reduce((sum, r) => sum + (r.nota || r.rating || 0), 0) / reviews.length) * 10
    ) / 10,
    painSummary: Object.entries(painCounts)
      .sort(([, a], [, b]) => b - a)
      .map(([pain, count]) => `${pain} (${count}x)`)
      .join(', '),

    // — dores ponderadas por recência —
    painCountsWeighted,
    schedulingPainWeighted: Math.round(schedulingPainWeighted * 10) / 10,
    hasSchedulingPainWeighted: schedulingPainWeighted >= 2,

    // — no-show / caos de agenda —
    noshowChaosCount,
    hasNoshowChaos: noshowChaosCount >= 1,
    noshowExamples,

    // — respostas do dono —
    ...ownerAnalysis,

    // — velocidade de reviews —
    ...velocityAnalysis,

    // — distribuição de notas —
    ...distributionAnalysis,
  };
}

module.exports = { analyzeReviews };
