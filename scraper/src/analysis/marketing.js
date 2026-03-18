/**
 * Análise de status de marketing digital da barbearia
 *
 * Framework de maturidade digital em 5 níveis (0-4):
 *   0 "Invisível"    (score  0-15): Apenas ficha Google Maps, sem site, sem Instagram
 *   1 "Básico"       (score 16-35): Ficha com fotos, talvez Instagram <500 seguidores
 *   2 "Ativo"        (score 36-55): Site básico, Instagram >500, responde avaliações
 *   3 "Engajado"     (score 56-75): WhatsApp Business, posts regulares, site com formulários
 *   4 "Sofisticado"  (score 76-100): CRM/concorrente, GA/Pixel, múltiplos canais integrados
 */

const MATURITY_LEVELS = [
  { level: 0, label: 'Invisível',    min: 0,  max: 15  },
  { level: 1, label: 'Básico',       min: 16, max: 35  },
  { level: 2, label: 'Ativo',        min: 36, max: 55  },
  { level: 3, label: 'Engajado',     min: 56, max: 75  },
  { level: 4, label: 'Sofisticado',  min: 76, max: 100 },
];

/**
 * Resolve o nível de maturidade a partir do score (0-100).
 * @param {number} score
 * @returns {{ level: number, label: string }}
 */
function resolveMaturity(score) {
  const clamped = Math.max(0, Math.min(100, score));
  for (const tier of MATURITY_LEVELS) {
    if (clamped >= tier.min && clamped <= tier.max) {
      return { level: tier.level, label: tier.label };
    }
  }
  return { level: 0, label: 'Invisível' };
}

/**
 * Mapeia o presenceScore (0-100) para o label legado de 3 níveis.
 * Mantido para compatibilidade com código existente que lê digitalPresence.
 * @param {number} score
 * @returns {'baixa'|'media'|'alta'}
 */
function scoreTo3TierPresence(score) {
  if (score >= 56) return 'alta';
  if (score >= 26) return 'media';
  return 'baixa';
}

/**
 * Avalia o status de marketing baseado em Instagram, website e canais disponíveis.
 *
 * @param {Object|null} instagram       - Dados do Instagram scrapeado
 * @param {Object|null} websiteAnalysis - Análise do website (website-analyzer)
 * @param {Object}      leadChannels    - Canais extras extraídos do lead
 * @param {boolean}     leadChannels.hasGoogleMaps  - Tem ficha no Google Maps
 * @param {boolean}     leadChannels.hasWhatsapp    - Tem WhatsApp (número encontrado)
 * @param {boolean}     leadChannels.hasFacebook    - Tem página no Facebook
 * @param {boolean}     leadChannels.hasEmail       - Tem e-mail de contato
 * @returns {Object} Status completo de marketing
 */
function analyzeMarketingStatus(instagram, websiteAnalysis, leadChannels = {}) {
  const signals = [];

  // ─── SCORE BASE (0-100) ───────────────────────────────────────────────────
  let score = 0;

  // ─── INSTAGRAM ────────────────────────────────────────────────────────────
  let instagramStatus = 'desconhecido';

  if (instagram?.found) {
    score += 10; // Ter Instagram já vale

    // Tamanho da audiência
    const seguidores = instagram.seguidores ?? 0;
    if (seguidores >= 5000) {
      score += 15;
      signals.push('Instagram forte (5k+ seguidores)');
    } else if (seguidores >= 1000) {
      score += 10;
      signals.push('Instagram ativo (1k+ seguidores)');
    } else if (seguidores >= 500) {
      score += 5;
      signals.push('Instagram com audiência inicial (500+ seguidores)');
    } else {
      signals.push('Instagram pequeno (<500 seguidores)');
    }

    // Atividade por volume de posts
    const posts = instagram.posts ?? null;
    if (posts !== null) {
      if (posts < 10) {
        instagramStatus = 'abandonado';
        signals.push('Instagram praticamente abandonado (<10 posts)');
      } else if (posts < 50) {
        instagramStatus = 'irregular';
        signals.push('Instagram com poucos posts (<50)');
      } else {
        instagramStatus = 'ativo';
        score += 5;
      }
    }

    // Combinação de audiência forte + volume alto = muito ativo
    if (seguidores >= 5000 && (instagram.posts ?? 0) >= 100) {
      score += 5;
      signals.push('Instagram muito ativo (5k+ seguidores e 100+ posts)');
    }

    // Conta Business / Creator
    if (instagram.isBusiness) {
      score += 5;
      signals.push('Conta Instagram Business/Creator');
    }

    // WhatsApp na bio = usa WhatsApp Business de forma integrada
    if (instagram.temWhatsappLink) {
      score += 5;
      signals.push('Usa WhatsApp Business (link na bio do Instagram)');
    }

    // Linktree ou agregador de links = dono tech-savvy
    if (instagram.temLinkTree || instagram.bioUrl?.includes('linktr.ee') || instagram.bioUrl?.includes('linkin.bio') || instagram.bioUrl?.includes('bio.link')) {
      score += 5;
      signals.push('Usa agregador de links (Linktree/similar) — dono tech-savvy');
    }

    // Link de agendamento online
    if (instagram.temAgendamentoOnline) {
      score += 5;
      signals.push('Tem link de agendamento no Instagram');
    }
  } else {
    instagramStatus = 'nao_encontrado';
    signals.push('Instagram não encontrado');
  }

  // ─── WEBSITE ──────────────────────────────────────────────────────────────
  let websiteStatus = 'sem_site';

  if (websiteAnalysis?.analyzed) {
    websiteStatus = 'ativo';
    score += 10; // Ter site já vale

    // Analytics e rastreamento (sinal de maturidade avançada)
    if (websiteAnalysis.hasGoogleAnalytics) {
      score += 10;
      signals.push('Site usa Google Analytics');
    }
    if (websiteAnalysis.hasFacebookPixel) {
      score += 10;
      signals.push('Site usa Facebook Pixel');
    }

    // Responsividade mobile
    if (websiteAnalysis.isMobileResponsive) {
      score += 5;
      signals.push('Site responsivo para mobile');
    }

    // Gateway de pagamento = transações online
    if (websiteAnalysis.hasPaymentGateway) {
      score += 5;
      signals.push('Site com gateway de pagamento');
    }

    // CMS identificado (não "unknown") = site mais profissional
    if (websiteAnalysis.cms && websiteAnalysis.cms !== 'unknown' && websiteAnalysis.cms !== null) {
      score += 5;
      signals.push(`Site construído em ${websiteAnalysis.cms}`);
    }

    // Agendamento online no site
    if (websiteAnalysis.temAgendamentoOnline) {
      score += 5;
      signals.push('Site tem agendamento online');
    }

    // Usa concorrente direto
    if (websiteAnalysis.usaConcorrente) {
      score += 5;
      signals.push(`Usa concorrente: ${(websiteAnalysis.competitorsFound || []).join(', ')}`);
    }

    // Maturidade digital legada (campo do website-analyzer antigo, 0-10)
    if (websiteAnalysis.maturidadeDigital >= 7) {
      score += 5;
      signals.push('Site com boa maturidade digital (score legado)');
    } else if (websiteAnalysis.maturidadeDigital >= 5) {
      score += 2;
    }
  } else {
    signals.push('Sem website');
  }

  // ─── CANAIS EXTRAS ────────────────────────────────────────────────────────
  const {
    hasGoogleMaps = true, // Presume-se que sempre tem ficha Google Maps (pipeline parte disso)
    hasWhatsapp   = false,
    hasFacebook   = false,
    hasEmail      = false,
  } = leadChannels;

  if (hasWhatsapp) {
    score += 5;
    signals.push('WhatsApp disponível para contato');
  }
  if (hasFacebook) {
    score += 3;
    signals.push('Presença no Facebook');
  }
  if (hasEmail) {
    score += 3;
    signals.push('E-mail de contato disponível');
  }

  // ─── MULTI-CHANNEL SCORE ─────────────────────────────────────────────────
  const channels = {
    googleMaps : hasGoogleMaps,
    website    : !!(websiteAnalysis?.analyzed),
    instagram  : !!(instagram?.found),
    whatsapp   : hasWhatsapp,
    facebook   : hasFacebook,
    email      : hasEmail,
  };

  const channelCount = Object.values(channels).filter(Boolean).length;

  // Fragmentação: múltiplos canais mas sem sinais de integração entre eles.
  // Indicadores de integração: link de agendamento, link de WhatsApp no Instagram,
  // Pixel/Analytics no site, uso de concorrente ou CRM.
  const hasIntegrationSignal = (
    !!(instagram?.temWhatsappLink) ||
    !!(instagram?.temAgendamentoOnline) ||
    !!(websiteAnalysis?.hasFacebookPixel) ||
    !!(websiteAnalysis?.hasGoogleAnalytics) ||
    !!(websiteAnalysis?.usaConcorrente) ||
    !!(websiteAnalysis?.temAgendamentoOnline)
  );
  const channelFragmentation = channelCount >= 2 && !hasIntegrationSignal;

  if (channelFragmentation) {
    signals.push('Múltiplos canais sem integração detectada (fragmentação)');
  }

  // ─── SCORE FINAL E MATURIDADE ────────────────────────────────────────────
  const presenceScore = Math.max(0, Math.min(100, score));
  const { level: maturityLevel, label: maturityLabel } = resolveMaturity(presenceScore);
  const digitalPresence = scoreTo3TierPresence(presenceScore);

  return {
    // Campos legados — mantidos para compatibilidade
    digitalPresence,
    instagramStatus,
    websiteStatus,
    presenceScore,
    signals,

    // Novos campos
    maturityLevel,
    maturityLabel,
    channelCount,
    channelFragmentation,
    channels,
  };
}

module.exports = { analyzeMarketingStatus };
