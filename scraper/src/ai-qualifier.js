const axios = require('axios');
const { analyzeReviews } = require('./analysis/reviews');
const { analyzeMarketingStatus } = require('./analysis/marketing');
const { interpolate } = require('./config-loader');

// ════════════════════════════════════════════════════
// QUALIFICAÇÃO COM IA (Claude Haiku)
// ════════════════════════════════════════════════════

async function qualifyWithAI(lead, config = null) {
  const apiKey = process.env.GROQ_API_KEY || process.env.ANTHROPIC_API_KEY;
  const useGroq = !!process.env.GROQ_API_KEY;

  if (!apiKey) {
    return qualifyWithRulesV2(lead, config);
  }

  // Pré-qualificar por regras: só chamar IA para leads com potencial real
  const preScore = qualifyWithRulesV2(lead, config);

  // Hard disqualifiers: não enviar para IA se já descartado
  if (preScore.tags.includes('DESCARTADO')) {
    return { ...preScore, ai_analyzed: false, ai_skipped: true };
  }

  // Threshold elevado para economizar tokens
  const threshold = isAltSource(lead) ? 35 : 55;
  if (preScore.score < threshold) {
    return { ...preScore, ai_analyzed: false, ai_skipped: true };
  }

  try {
    const prompt = buildPrompt(lead, config);
    const systemMsg = 'Consultor B2B qualificação de leads. Responda APENAS JSON válido, sem markdown, sem explicações.';

    let text;

    if (useGroq) {
      // Rate limit: 30 req/min na Groq free tier — esperar 2.5s entre chamadas
      await new Promise(r => setTimeout(r, 2500));

      // ── Groq (Llama 3.3 70B — gratuito) ──
      const { data } = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model: 'llama-3.3-70b-versatile',
        max_tokens: 400,
        temperature: 0.2,
        messages: [
          { role: 'system', content: systemMsg },
          { role: 'user', content: prompt },
        ],
      }, {
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      });
      text = data.choices[0].message.content;
    } else {
      // ── Claude (Anthropic) ──
      const { data } = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: systemMsg,
        messages: [{ role: 'user', content: prompt }],
      }, {
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        timeout: 30000,
      });
      text = data.content[0].text;
    }

    return parseAIResponse(text, lead, config);
  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.message;
    console.error(`[AI Qualifier] Erro (${useGroq ? 'Groq' : 'Claude'}):`, errMsg);
    return qualifyWithRulesV2(lead, config);
  }
}

function buildPrompt(lead, config = null) {
  const contexto = config
    ? config.qualificacao.promptContexto
    : 'Consultor B2B SaaS barbearias. Produto: Bookou (agendamento, financeiro, comissões, lembretes WhatsApp). Start R$79,90/mês, Profissional R$149,90/mês.';

  // Usar painSummary se disponível; senão, pegar até 3 reviews negativos resumidos
  const reviewAnalysis = lead.reviewAnalysis || {};
  let reviewContext = '';
  if (reviewAnalysis.painSummary) {
    reviewContext = `Dores: ${reviewAnalysis.painSummary}`;
  } else {
    const negReviews = (lead.reviews || [])
      .filter(r => r.nota <= 3)
      .slice(0, 3)
      .map(r => `${r.nota}/5: "${(r.texto || '').substring(0, 100)}"`)
      .join(' | ');
    if (negReviews) reviewContext = `Reviews: ${negReviews}`;
  }

  const concorrente = lead.websiteAnalysis?.usaConcorrente
    ? lead.websiteAnalysis.competitorsFound.join(', ')
    : '';

  // Sinais compactos — só flags relevantes, uma linha
  const flags = [];
  if (!lead.website) flags.push('SEM_SITE');
  if (concorrente) flags.push(`CONCORRENTE:${concorrente}`);
  if (lead.instagram?.temAgendamentoOnline) flags.push('IG_AGENDAMENTO');
  if (lead.instagram?.seguidores) flags.push(`IG:${lead.instagram.seguidores}`);
  if (lead.instagram?.isBusiness) flags.push('IG_BIZ');
  if (lead.whatsapp) flags.push('WHATSAPP');
  if (lead.cnpj) flags.push(`CNPJ:${lead.porte || '?'}`);
  if (reviewAnalysis.ownerMentionsScheduling) flags.push('DONO_AGENDA_MANUAL');
  if (reviewAnalysis.noShowPain) flags.push('NO_SHOW');
  if (reviewAnalysis.bimodalDistribution) flags.push('BIMODAL');
  if (reviewAnalysis.reviewVelocity > 1.5) flags.push(`VEL:${reviewAnalysis.reviewVelocity.toFixed(1)}/m`);
  if (reviewAnalysis.ownerResponds) flags.push('DONO_RESPONDE');
  const marketingStatus = lead.marketingStatus || {};
  if (marketingStatus.maturityLevel !== undefined) flags.push(`MAT:${marketingStatus.maturityLevel}/4`);
  if (marketingStatus.channelFragmentation) flags.push('FRAG_CANAIS');
  const websiteAnalysis = lead.websiteAnalysis || {};
  if (websiteAnalysis.hasGoogleAnalytics || websiteAnalysis.hasFacebookPixel) flags.push('ANALYTICS');
  if (websiteAnalysis.cms) flags.push(`CMS:${websiteAnalysis.cms}`);
  const staffEstimate = estimateStaff(lead);
  if (staffEstimate) flags.push(`EQUIPE:${staffEstimate}`);
  if (lead.abertura) flags.push(`DESDE:${lead.abertura}`);

  return `${contexto}
${lead.nome}|${lead.cidade || ''}|${lead.rating}/5(${lead.totalAvaliacoes}av)|${lead.website || 'sem-site'}
${flags.join(' ')}
${reviewContext}
JSON:{"score":<0-100>,"classificacao":"QUENTE|MORNO|FRIO","perfil":"1frase","dores_provaveis":["d1","d2"],"argumento_principal":"1frase","plano_recomendado":"start|profissional","mensagem_whatsapp":"max280ch","mensagem_instagram":"max180ch","mensagem_followup":"max150ch","melhor_horario_contato":"quando","risco":"baixo|medio|alto"}`;
}

function parseAIResponse(text, lead, config = null) {
  try {
    const clean = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(clean);
    return {
      ...parsed,
      ai_analyzed: true,
    };
  } catch (err) {
    console.error('[AI Qualifier] Erro ao parsear resposta:', err.message);
    return qualifyWithRulesV2(lead, config);
  }
}

// ════════════════════════════════════════════════════
// QUALIFICAÇÃO V2 — POR REGRAS (PONDERADA + MULTI-FONTE)
// ════════════════════════════════════════════════════

function qualifyWithRulesV2(lead, config = null) {
  const reviewAnalysis = lead.reviewAnalysis || analyzeReviews(lead.reviews, config);
  const marketingStatus = lead.marketingStatus || analyzeMarketingStatus(lead.instagram, lead.websiteAnalysis, {
    hasGoogleMaps: !!lead.place_id,
    hasWhatsapp: !!lead.whatsapp,
    hasFacebook: !!lead.websiteAnalysis?.socialMedia?.facebook,
    hasEmail: !!lead.email,
  });

  // ═══ HARD DISQUALIFIERS — verifica antes de qualquer scoring ═══
  const hardDisqualifier = checkHardDisqualifiers(lead);
  if (hardDisqualifier) {
    const tags = ['DESCARTADO', ...buildTags(lead, { oportunidade: 0, alcancabilidade: 0, tamanho: 0, urgencia: 0, confianca: 0 }, reviewAnalysis, marketingStatus)];
    return {
      score: 0,
      scores: { oportunidade: 0, alcancabilidade: 0, tamanho: 0, urgencia: 0, confianca: 0 },
      classificacao: 'FRIO',
      tags,
      perfil: hardDisqualifier.motivo,
      dores_provaveis: [],
      argumento_principal: '',
      plano_recomendado: 'start',
      mensagem_whatsapp: '',
      mensagem_instagram: '',
      mensagem_followup: '',
      melhor_horario_contato: suggestContactTime(lead.horarios).horario,
      sazonal: suggestContactTime(lead.horarios).sazonal,
      risco: 'alto',
      motivo_risco: hardDisqualifier.motivo,
      ai_analyzed: false,
      reviewAnalysis: {
        painSummary: reviewAnalysis.painSummary || '',
        hasSchedulingPain: reviewAnalysis.hasSchedulingPain || false,
      },
      marketingStatus: {
        digitalPresence: marketingStatus.digitalPresence,
        signals: marketingStatus.signals,
      },
    };
  }

  const scores = {
    oportunidade: 0,
    alcancabilidade: 0,
    tamanho: 0,
    urgencia: 0,
    confianca: 0,
  };

  // ═══ OPORTUNIDADE (0-100) ═══
  // Presença digital
  if (!lead.website) {
    scores.oportunidade += 35;
  } else if (!lead.websiteAnalysis?.temAgendamentoOnline) {
    scores.oportunidade += 25;
  } else if (lead.websiteAnalysis?.usaConcorrente) {
    scores.oportunidade += 15;
  } else {
    scores.oportunidade += 5;
  }

  // Dores em reviews
  if (reviewAnalysis.hasSchedulingPain) scores.oportunidade += 25;
  if (reviewAnalysis.hasSchedulingPraise) scores.oportunidade -= 25;

  // Concorrentes fortes em plano pago = muito menos oportunidade
  if (lead.websiteAnalysis?.usaConcorrente) {
    const competitors = (lead.websiteAnalysis.competitorsFound || []).map(c => c.toLowerCase());
    const strongCompetitors = ['booksy', 'fresha', 'mindbody'];
    if (competitors.some(c => strongCompetitors.includes(c))) {
      scores.oportunidade -= 30;
    }
  }

  // Instagram com link de agendamento funcional = menos oportunidade
  if (lead.instagram?.temAgendamentoOnline) {
    scores.oportunidade -= 25;
  }

  // Site com agendamento E chat widget = muito menos oportunidade
  if (lead.websiteAnalysis?.temAgendamentoOnline && lead.websiteAnalysis?.hasChatWidget) {
    scores.oportunidade -= 40;
  }

  // Marketing
  if (marketingStatus.instagramStatus === 'abandonado') scores.oportunidade += 15;
  if (marketingStatus.instagramStatus === 'nao_encontrado' && !lead.website) scores.oportunidade += 10;

  // Maturidade digital (sweet spot = nível 2-3)
  if (marketingStatus.maturityLevel === 2 || marketingStatus.maturityLevel === 3) {
    scores.oportunidade += 10;
  } else if (marketingStatus.maturityLevel === 0 || marketingStatus.maturityLevel === 1) {
    scores.oportunidade -= 5; // muito cedo, ciclo de venda longo
  }

  // WhatsApp sem concorrente E sem agendamento em nenhum canal = sinal forte combinado
  const hasAnyScheduling = lead.websiteAnalysis?.temAgendamentoOnline || lead.instagram?.temAgendamentoOnline;
  if (lead.whatsapp && !lead.websiteAnalysis?.usaConcorrente && !hasAnyScheduling) {
    scores.oportunidade += 25;
  } else if (lead.whatsapp && !lead.websiteAnalysis?.usaConcorrente) {
    // Já tem agendamento mas usa WhatsApp = ainda relevante, mas bônus menor
    scores.oportunidade += 10;
  }

  // Dias abertos
  const diasAbertos = (lead.horarios || []).filter(h => !/fechado/i.test(h)).length;
  if (diasAbertos >= 6) scores.oportunidade += 10;

  // Instagram sem agendamento = oportunidade
  if (lead.instagram?.found && !lead.instagram?.temAgendamentoOnline && !lead.websiteAnalysis?.usaConcorrente) {
    scores.oportunidade += 10;
  }

  // CMS pago = já aberto a SaaS
  if (lead.websiteAnalysis?.cms === 'wix' || lead.websiteAnalysis?.cms === 'squarespace') {
    scores.oportunidade += 5;
  }

  // CNPJ: empresa formal sem presença digital = grande oportunidade
  if (lead.cnpj && !lead.website && !lead.instagram?.found) {
    scores.oportunidade += 15;
  }

  scores.oportunidade = clamp(scores.oportunidade, 0, 100);

  // ═══ ALCANÇABILIDADE (0-100) ═══
  // Zero info de contato = penalidade severa
  const hasAnyContact = lead.whatsapp || lead.telefone || lead.email || lead.instagram?.found;
  if (!hasAnyContact) {
    scores.alcancabilidade -= 50;
  } else {
    if (lead.whatsapp) scores.alcancabilidade += 45;
    else if (lead.telefone) scores.alcancabilidade += 20;

    if (lead.instagram?.found) scores.alcancabilidade += 25;
    if (lead.email) scores.alcancabilidade += 15;
    if (lead.googleMapsUrl) scores.alcancabilidade += 10;

    // CNPJ com telefone da Receita é confiável
    if (lead.cnpj && lead.telefone) scores.alcancabilidade += 5;
  }

  scores.alcancabilidade = clamp(scores.alcancabilidade, 0, 100);

  // ═══ TAMANHO (0-100) — multi-sinal ═══
  scores.tamanho = estimateSize(lead);

  // ═══ URGÊNCIA (0-100) — multi-sinal ═══
  scores.urgencia = estimateUrgency(lead, reviewAnalysis, marketingStatus, config);

  // ═══ CONFIANÇA (0-100) — qualidade dos dados ═══
  scores.confianca = estimateConfidence(lead, reviewAnalysis);

  // ═══ SCORE FINAL (ponderado com confiança) ═══
  const rawScore = Math.round(
    scores.oportunidade * 0.35 +
    scores.alcancabilidade * 0.25 +
    scores.tamanho * 0.15 +
    scores.urgencia * 0.10 +
    scores.confianca * 0.15
  );

  const finalScore = clamp(rawScore, 0, 100);

  // Classificação
  let classificacao;
  if (finalScore >= 58) classificacao = 'QUENTE';
  else if (finalScore >= 38) classificacao = 'MORNO';
  else classificacao = 'FRIO';

  // Tags
  const tags = buildTags(lead, scores, reviewAnalysis, marketingStatus);

  // Dores prováveis
  const dores = buildDores(lead, reviewAnalysis, marketingStatus, config);

  // Mensagens
  const mensagens = buildMensagens(lead, dores, classificacao, config);

  // Plano recomendado — multi-sinal
  const plano = recommendPlan(lead, reviewAnalysis, marketingStatus);

  return {
    score: finalScore,
    scores,
    classificacao,
    tags,
    perfil: buildPerfil(lead, marketingStatus, config),
    dores_provaveis: dores,
    argumento_principal: buildArgumento(lead, dores, config),
    plano_recomendado: plano.plan,
    plano_tags: plano.tags,
    ...mensagens,
    melhor_horario_contato: suggestContactTime(lead.horarios).horario,
    sazonal: suggestContactTime(lead.horarios).sazonal,
    risco: buildRisk(classificacao, scores, lead),
    motivo_risco: buildRiskReason(lead, scores),
    ai_analyzed: false,
    reviewAnalysis: {
      painSummary: reviewAnalysis.painSummary || '',
      hasSchedulingPain: reviewAnalysis.hasSchedulingPain || false,
    },
    marketingStatus: {
      digitalPresence: marketingStatus.digitalPresence,
      signals: marketingStatus.signals,
    },
  };
}

// ════════════════════════════════════════════════════
// HARD DISQUALIFIERS
// ════════════════════════════════════════════════════

/**
 * Verifica condições que descartam imediatamente o lead.
 * Retorna { motivo } se descartado, ou null se OK.
 */
function checkHardDisqualifiers(lead) {
  // Estabelecimento fechado permanentemente ou temporariamente
  if (lead.business_status === 'CLOSED_PERMANENTLY') {
    return { motivo: 'Estabelecimento fechado permanentemente' };
  }
  if (lead.business_status === 'CLOSED_TEMPORARILY') {
    return { motivo: 'Estabelecimento fechado temporariamente' };
  }

  // CNPJ com situação irregular
  if (lead.cnpjStatus) {
    const status = lead.cnpjStatus.toUpperCase();
    if (status.includes('BAIXADA')) {
      return { motivo: 'CNPJ baixado — empresa encerrada' };
    }
    if (status.includes('INAPTA')) {
      return { motivo: 'CNPJ inapto — empresa irregular' };
    }
  }

  // Rating muito baixo com volume suficiente de avaliações = negócio com problemas sérios
  if (lead.rating < 3.0 && lead.totalAvaliacoes >= 20) {
    return { motivo: `Rating crítico (${lead.rating}/5 com ${lead.totalAvaliacoes} avaliações) — negócio com problemas graves` };
  }

  return null;
}

// ════════════════════════════════════════════════════
// ESTIMADORES MULTI-SINAL
// ════════════════════════════════════════════════════

/**
 * Estima tamanho do negócio usando múltiplos sinais
 * Avaliações Google > Seguidores Instagram > Porte CNPJ > Tempo de existência
 */
function estimateSize(lead) {
  let score = 0;
  let hasSignal = false;

  // Sinal 1: avaliações Google Maps (mais confiável)
  if (lead.totalAvaliacoes > 0) {
    hasSignal = true;
    if (lead.totalAvaliacoes >= 200) score = Math.max(score, 100);
    else if (lead.totalAvaliacoes >= 100) score = Math.max(score, 80);
    else if (lead.totalAvaliacoes >= 50) score = Math.max(score, 60);
    else if (lead.totalAvaliacoes >= 20) score = Math.max(score, 40);
    else if (lead.totalAvaliacoes >= 10) score = Math.max(score, 25);
    else score = Math.max(score, 15);

    // Sweet spot: 50-200 avaliações — grande o suficiente para precisar de ferramentas,
    // mas não enterprise. Bônus adicional.
    if (lead.totalAvaliacoes >= 50 && lead.totalAvaliacoes <= 200) {
      score = Math.min(100, score + 15);
    }
  }

  // Sinal 2: seguidores Instagram
  if (lead.instagram?.seguidores > 0) {
    hasSignal = true;
    const seg = lead.instagram.seguidores;
    if (seg >= 10000) score = Math.max(score, 90);
    else if (seg >= 5000) score = Math.max(score, 75);
    else if (seg >= 2000) score = Math.max(score, 60);
    else if (seg >= 500) score = Math.max(score, 40);
    else if (seg >= 100) score = Math.max(score, 25);
  }

  // Sinal 3: porte CNPJ
  if (lead.porte) {
    hasSignal = true;
    const porteMap = {
      'DEMAIS': 90,        // Empresa grande
      'EPP': 70,           // Empresa de Pequeno Porte
      'ME': 45,            // Microempresa
      'MEI': 20,           // Microempreendedor Individual
    };
    const porteKey = lead.porte.toUpperCase().replace(/[^A-Z]/g, '');
    for (const [key, val] of Object.entries(porteMap)) {
      if (porteKey.includes(key)) {
        score = Math.max(score, val);
        break;
      }
    }
  }

  // Sinal 4: tempo de existência (CNPJ abertura)
  if (lead.abertura) {
    hasSignal = true;
    const anos = calcYears(lead.abertura);
    if (anos >= 10) score = Math.max(score, 60);
    else if (anos >= 5) score = Math.max(score, 45);
    else if (anos >= 2) score = Math.max(score, 30);
    else score = Math.max(score, 15);
  }

  // Bônus: rating na faixa ideal 4.0-4.7 = negócio estabelecido e saudável
  // (5.0 perfeito com poucas reviews = muito novo ou poucas avaliações)
  if (lead.rating >= 4.0 && lead.rating <= 4.7 && lead.totalAvaliacoes >= 10) {
    score = Math.min(100, score + 10);
  }

  // Se nenhum sinal disponível, score neutro
  if (!hasSignal) score = 30;

  return clamp(score, 0, 100);
}

/**
 * Estima urgência usando múltiplos sinais
 * Reviews com dor > Sem presença digital > Instagram abandonado > Concorrente fraco
 */
function estimateUrgency(lead, reviewAnalysis, marketingStatus, config = null) {
  let score = 0;

  // Sinal 1: dores explícitas em reviews — usa weightedPainCount se disponível
  const schedulingPainKeys = config ? config.analise.schedulingPainKeys : ['fila', 'agendamento', 'lotado'];
  let painCount;
  if (reviewAnalysis.weightedPainCount !== undefined) {
    painCount = reviewAnalysis.weightedPainCount;
  } else {
    painCount = schedulingPainKeys.reduce(
      (sum, key) => sum + (reviewAnalysis.painCounts?.[key] || 0), 0
    );
  }

  if (painCount >= 5) score += 50;
  else if (painCount >= 3) score += 35;
  else if (painCount >= 1) score += 20;

  // Sinal 2: desorganização em reviews
  if (reviewAnalysis.hasOrganizationIssues) score += 15;

  // Sinal 3: dono menciona agendamento manual nas respostas = SINAL DE OURO
  if (reviewAnalysis.ownerMentionsScheduling) score += 30;

  // Sinal 4: velocidade de reviews alta = crescendo rápido, precisa de ferramentas urgente
  if (reviewAnalysis.reviewVelocity > 1.5) score += 20;

  // Sinal 5: distribuição bimodal = caos operacional (clientes adoram OU odeiam)
  if (reviewAnalysis.bimodalDistribution) score += 15;

  // Sinal 6: dor de no-show = problema de agendamento explícito
  if (reviewAnalysis.noShowPain) score += 20;

  // Sinal 7: sem presença digital nenhuma (urgente digitalizar)
  if (!lead.website && !lead.instagram?.found) score += 20;

  // Sinal 8: Instagram abandonado (tentou e parou)
  if (marketingStatus.instagramStatus === 'abandonado') score += 15;

  // Sinal 9: canais fragmentados = dor de gestão múltiplos canais
  if (marketingStatus.channelFragmentation) score += 10;

  // Sinal 10: alto volume sem solução de agendamento
  const isHighVolume = (lead.totalAvaliacoes >= 80) || (lead.instagram?.seguidores >= 3000);
  const hasScheduling = lead.websiteAnalysis?.temAgendamentoOnline || lead.instagram?.temAgendamentoOnline;
  if (isHighVolume && !hasScheduling) score += 20;

  // Sinal 11: usa concorrente fraco / barato (oportunidade de troca)
  if (lead.websiteAnalysis?.usaConcorrente) {
    const competitors = lead.websiteAnalysis.competitorsFound || [];
    const weakCompetitors = ['simpleag', 'barzelink', 'barberapp', 'grazy', 'beautydock'];
    if (competitors.some(c => weakCompetitors.includes(c))) {
      score += 15;
    } else {
      score += 5; // usa concorrente forte, menor urgência de troca
    }
  }

  // Sinal 12: empresa antiga sem digital (urgente modernizar)
  if (lead.abertura) {
    const anos = calcYears(lead.abertura);
    if (anos >= 5 && !lead.website && !lead.instagram?.found) score += 10;
  }

  return clamp(score, 0, 100);
}

/**
 * Estima confiança/qualidade dos dados do lead
 * Mais fontes = mais confiável. Mais dados = mais confiável.
 */
function estimateConfidence(lead, reviewAnalysis = {}) {
  let score = 0;

  // Múltiplas fontes confirmam que o negócio existe
  const sources = lead.sources || [lead.source];
  if (sources.length >= 3) score += 35;
  else if (sources.length >= 2) score += 25;
  else score += 10;

  // Tem place_id do Google (negócio verificado)
  if (lead.place_id) score += 15;

  // Tem CNPJ (empresa registrada)
  if (lead.cnpj) score += 15;

  // Dados de contato disponíveis
  if (lead.telefone) score += 10;
  if (lead.whatsapp) score += 5;
  if (lead.email) score += 5;

  // Dados de endereço
  if (lead.endereco && lead.endereco.length > 10) score += 5;
  if (lead.lat && lead.lng) score += 5;

  // Perfil completo do Instagram
  if (lead.instagram?.found && lead.instagram?.seguidores !== null) score += 5;

  // Reviews disponíveis para análise
  if (lead.reviews && lead.reviews.length > 0) score += 5;

  // Dono digitalmente engajado (responde avaliações) = negócio ativo e receptivo
  if (reviewAnalysis.ownerResponds) score += 10;

  // Investe em analytics = negócio real com presença digital intencional
  if (lead.websiteAnalysis?.hasGoogleAnalytics || lead.websiteAnalysis?.hasFacebookPixel) score += 10;

  return clamp(score, 0, 100);
}

// ════════════════════════════════════════════════════
// HELPERS DE QUALIFICAÇÃO
// ════════════════════════════════════════════════════

function buildTags(lead, scores, reviewAnalysis, marketingStatus) {
  const tags = [];

  // Situação digital
  if (!lead.website) tags.push('SEM_SITE');
  if (!lead.website && !lead.instagram?.found) tags.push('ZERO_DIGITAL');
  if (lead.websiteAnalysis?.usaConcorrente) tags.push('USA_CONCORRENTE');

  // Reviews
  if (reviewAnalysis.hasSchedulingPain) tags.push('RECLAMA_FILA');
  if (reviewAnalysis.hasOrganizationIssues) tags.push('DESORGANIZACAO');

  // Novas tags de review analysis
  if (reviewAnalysis.bimodalDistribution) tags.push('BIMODAL_REVIEWS');
  if (reviewAnalysis.noShowPain) tags.push('NO_SHOW_PAIN');
  if (reviewAnalysis.ownerMentionsScheduling) tags.push('AGENDA_MANUAL');
  if (reviewAnalysis.reviewVelocity > 1.5) tags.push('CRESCIMENTO_RAPIDO');

  // Sweet spot de tamanho
  if (lead.totalAvaliacoes >= 50 && lead.totalAvaliacoes <= 200) tags.push('SWEET_SPOT_SIZE');

  // Marketing
  if (marketingStatus.instagramStatus === 'abandonado') tags.push('MARKETING_ABANDONADO');

  // Volume
  const isHighVolume = (lead.totalAvaliacoes >= 100) || (lead.instagram?.seguidores >= 5000);
  if (isHighVolume) tags.push('ALTO_VOLUME');

  // Contato
  const hasAnyContact = lead.whatsapp || lead.telefone || lead.email || lead.instagram?.found;
  if (!hasAnyContact) tags.push('SEM_CONTATO');

  // Scores
  if (scores.oportunidade >= 70) tags.push('ALTA_OPORTUNIDADE');
  if (scores.alcancabilidade >= 70) tags.push('FACIL_CONTATO');
  if (scores.confianca >= 70) tags.push('DADOS_CONFIAVEIS');
  if (scores.confianca < 30) tags.push('DADOS_LIMITADOS');

  // Fonte
  if (lead.cnpj) tags.push('TEM_CNPJ');
  const sources = lead.sources || [lead.source];
  if (sources.length >= 3) tags.push('MULTI_FONTE');

  // Instagram específico
  if (lead.instagram?.isBusiness && !lead.instagram?.temAgendamentoOnline) {
    tags.push('IG_BUSINESS_SEM_AGENDA');
  }

  return tags;
}

function buildDores(lead, reviewAnalysis, marketingStatus, config = null) {
  const templates = config ? config.qualificacao.doresTemplates : null;
  const dores = [];

  // Presença digital
  if (!lead.website && !lead.instagram?.found) {
    dores.push(templates ? templates.sem_site : 'Sem presença digital — clientes não conseguem agendar online');
  } else if (!lead.website) {
    dores.push(templates ? templates.sem_site : 'Sem presença digital — clientes não conseguem agendar online');
  } else if (!lead.websiteAnalysis?.temAgendamentoOnline) {
    dores.push(templates ? templates.sem_agendamento : 'Tem site mas sem agendamento online — perde clientes que querem praticidade');
  }

  // Reviews
  if (reviewAnalysis.hasSchedulingPain) {
    dores.push(templates ? templates.reclama_fila : 'Clientes reclamam de fila e espera nas avaliações do Google');
  }

  // Dono menciona agendamento manual = dor direta e explícita
  if (reviewAnalysis.ownerMentionsScheduling) {
    dores.push('Dono confirma agendamento manual nas respostas — processo caótico');
  }

  // No-show pain
  if (reviewAnalysis.noShowPain) {
    dores.push('Dor com no-show / ausências sem aviso — precisa de confirmação automática');
  }

  // Caos operacional (reviews bimodais)
  if (reviewAnalysis.bimodalDistribution) {
    dores.push('Reviews divididas (adoram ou odeiam) — inconsistência no serviço');
  }

  // Alto volume
  const isHighVolume = (lead.totalAvaliacoes >= 100) || (lead.instagram?.seguidores >= 3000);
  if (isHighVolume) {
    dores.push(templates ? templates.alto_volume : 'Alto volume de clientes — gestão manual de agenda é insustentável');
  }

  // Dias abertos
  const diasAbertos = (lead.horarios || []).filter(h => !/fechado/i.test(h)).length;
  if (diasAbertos >= 6) {
    dores.push(templates ? templates.muitos_dias : 'Abre 6+ dias por semana — precisa otimizar agenda e comissões');
  }

  // Concorrente
  if (lead.websiteAnalysis?.usaConcorrente) {
    const concorrentes = lead.websiteAnalysis.competitorsFound.join('/');
    const tpl = templates ? templates.usa_concorrente : 'Usa {concorrentes} — pode estar insatisfeito com custo ou funcionalidades';
    dores.push(interpolate(tpl, { concorrentes }));
  }

  // Marketing abandonado
  if (marketingStatus.instagramStatus === 'abandonado') {
    dores.push(templates ? templates.marketing_abandonado : 'Marketing digital abandonado — precisa de ferramentas que simplifiquem a gestão');
  }

  // Canais fragmentados
  if (marketingStatus.channelFragmentation) {
    dores.push('Vários canais desconectados — perde atendimentos e histórico de clientes');
  }

  // Desorganização
  if (reviewAnalysis.hasOrganizationIssues) {
    dores.push(templates ? templates.desorganizacao : 'Reviews mencionam desorganização — sistema de gestão resolveria');
  }

  // Defaults
  if (dores.length === 0) {
    const defaults = templates ? templates.default : ['Gestão manual de agenda', 'Sem relatórios financeiros automatizados'];
    dores.push(...defaults);
  }

  return dores.slice(0, 4);
}

function buildPerfil(lead, marketingStatus, config = null) {
  const labels = config ? config.qualificacao.perfilLabels : null;
  const parts = [];

  // Determinar tamanho por múltiplos sinais
  const sizeLabel = getSizeLabel(lead);

  if (labels) {
    const vars = {
      segmentoSingular: config.qualificacao.segmentoSingular,
      genero: config.qualificacao.genero,
    };
    parts.push(interpolate(labels[sizeLabel], vars));
  } else {
    const map = {
      grande: 'Barbearia grande e estabelecida',
      popular: 'Barbearia popular',
      crescimento: 'Barbearia em crescimento',
      bairro: 'Barbearia de bairro',
      pequeno: 'Barbearia pequena/nova',
    };
    parts.push(map[sizeLabel]);
  }

  if (lead.rating >= 4.5 && lead.totalAvaliacoes >= 10) parts.push('com excelente reputação');
  else if (lead.rating >= 4.0 && lead.totalAvaliacoes >= 10) parts.push('com boa reputação');

  if (marketingStatus.digitalPresence === 'alta') parts.push('e forte presença digital');
  else if (marketingStatus.digitalPresence === 'baixa') parts.push('com presença digital fraca');

  // Info extra por fonte
  if (lead.cnpj && !lead.website && !lead.instagram?.found) {
    parts.push('— só encontrado na Receita Federal');
  }

  return parts.join(' ');
}

/**
 * Determina label de tamanho usando melhor sinal disponível
 */
function getSizeLabel(lead) {
  // Prioridade 1: avaliações Google
  if (lead.totalAvaliacoes >= 200) return 'grande';
  if (lead.totalAvaliacoes >= 100) return 'popular';
  if (lead.totalAvaliacoes >= 50) return 'crescimento';
  if (lead.totalAvaliacoes >= 20) return 'bairro';

  // Prioridade 2: seguidores Instagram
  if (lead.instagram?.seguidores >= 10000) return 'grande';
  if (lead.instagram?.seguidores >= 5000) return 'popular';
  if (lead.instagram?.seguidores >= 2000) return 'crescimento';
  if (lead.instagram?.seguidores >= 500) return 'bairro';

  // Prioridade 3: porte CNPJ
  if (lead.porte) {
    const p = lead.porte.toUpperCase();
    if (p.includes('DEMAIS') || p.includes('EPP')) return 'popular';
    if (p.includes('ME') && !p.includes('MEI')) return 'bairro';
  }

  // Prioridade 4: tempo de existência
  if (lead.abertura) {
    const anos = calcYears(lead.abertura);
    if (anos >= 10) return 'crescimento';
    if (anos >= 5) return 'bairro';
  }

  if (lead.totalAvaliacoes >= 10) return 'pequeno';

  return 'pequeno';
}

function buildArgumento(lead, dores, config = null) {
  const args = config ? config.qualificacao.argumentos : null;
  const produtoNome = config ? config.produto.nome : 'Bookou';

  if (dores.some(d => d.includes('fila') || d.includes('espera'))) {
    return args ? args.fila : 'Agendamento online elimina filas — seus clientes agendam pelo celular';
  }
  if (!lead.website) {
    return args ? args.sem_site : 'Página de agendamento online pronta — seus clientes agendam sem ligar';
  }
  if (lead.websiteAnalysis?.usaConcorrente) {
    const tpl = args ? args.concorrente : '{produto} é mais completo (agenda + financeiro + comissões) e com suporte brasileiro';
    return interpolate(tpl, { produto: produtoNome });
  }
  const isHighVolume = (lead.totalAvaliacoes >= 100) || (lead.instagram?.seguidores >= 3000);
  if (isHighVolume) {
    return args ? args.alto_volume : 'Gestão completa: agenda, financeiro, comissões e lembretes automáticos';
  }
  return args ? args.default : 'Agendamento online + gestão financeira em um só lugar';
}

function buildMensagens(lead, dores, classificacao, config = null) {
  const templates = config ? config.qualificacao.mensagensTemplates : null;
  const nome = lead.nome;
  const segmentoSingular = config ? config.qualificacao.segmentoSingular : 'Barbearia';
  const nomeSimples = nome.replace(new RegExp(segmentoSingular + '\\s*', 'i'), '').trim();
  const produtoNome = config ? config.produto.nome : 'Bookou';
  const segmentoPlural = config ? config.qualificacao.segmentoPlural : 'barbearias';
  const trial = config ? config.produto.trial : '14 dias grátis';

  const vars = {
    nome,
    nomeSimples,
    produto: produtoNome,
    segmento: segmentoPlural,
    avaliacoes: String(lead.totalAvaliacoes || lead.instagram?.seguidores || ''),
    trial,
  };

  let mensagem_whatsapp;
  if (templates) {
    if (dores.some(d => d.includes('fila'))) {
      mensagem_whatsapp = interpolate(templates.fila, vars);
    } else if (!lead.website) {
      mensagem_whatsapp = interpolate(templates.sem_site, vars);
    } else if (lead.websiteAnalysis?.usaConcorrente) {
      mensagem_whatsapp = interpolate(templates.concorrente, vars);
    } else if (lead.totalAvaliacoes >= 100 || lead.instagram?.seguidores >= 3000) {
      mensagem_whatsapp = interpolate(templates.alto_volume, vars);
    } else {
      mensagem_whatsapp = interpolate(templates.default, vars);
    }
  } else {
    // Mensagens humanizadas — tom de conversa real, não vendedor
    if (dores.some(d => d.includes('fila'))) {
      mensagem_whatsapp = `E aí, tudo bem? Vi que a ${nomeSimples} tá sempre cheia — isso é ótimo! Mas imagino que organizar a agenda com tanto movimento não deve ser fácil né? Eu trabalho com um sistema de agendamento que resolve isso de um jeito bem simples. Se tiver 2 minutos pra eu te mostrar, acho que ia gostar.`;
    } else if (!lead.website && lead.totalAvaliacoes >= 50) {
      mensagem_whatsapp = `Oi, tudo bem? Tava pesquisando barbearias aqui na região e vi que a ${nomeSimples} tem avaliações muito boas! Notei que vocês ainda não têm um link de agendamento online. Trabalho com isso e queria te mostrar como funciona — é bem rápido. Posso te mandar um vídeo curtinho?`;
    } else if (!lead.website) {
      mensagem_whatsapp = `Oi! Achei a ${nomeSimples} pelo Google e curti bastante. Vi que vocês ainda não têm um sistema pra cliente agendar online. Eu trabalho com uma ferramenta bem simples pra isso, sem complicação nenhuma. Quer que eu te explique rapidinho como funciona?`;
    } else if (lead.websiteAnalysis?.usaConcorrente) {
      mensagem_whatsapp = `Oi, tudo certo? Vi que a ${nomeSimples} já usa sistema de agendamento — show! Queria só te apresentar uma alternativa que além da agenda, tem controle financeiro, comissão dos barbeiros e lembretes automáticos pro cliente. Se tiver curiosidade, posso te mostrar rapidinho.`;
    } else if (lead.totalAvaliacoes >= 100) {
      mensagem_whatsapp = `E aí, beleza? A ${nomeSimples} tá com uma reputação incrível, ${lead.totalAvaliacoes} avaliações no Google é coisa séria! Com esse volume todo, vocês já usam algum sistema pra organizar agenda e financeiro? Pergunto porque trabalho com isso e talvez faça sentido pra vocês.`;
    } else {
      mensagem_whatsapp = `Oi, tudo bem? Conheci a ${nomeSimples} pelo Google e curti o trabalho de vocês. Eu trabalho com um sistema de agendamento e gestão pra barbearias, bem simples de usar. Se tiver interesse em conhecer, posso te mostrar em poucos minutos. Sem compromisso nenhum!`;
    }
  }

  const mensagem_instagram = templates
    ? interpolate(templates.instagram, vars)
    : `E aí, tudo bem? Curti demais o trabalho da ${nomeSimples}! Eu trabalho com um sistema de agendamento pra barbearias e acho que ia fazer sentido pra vocês. Posso te mostrar rapidinho?`;

  const mensagem_followup = templates
    ? interpolate(templates.followup, vars)
    : `Oi! Tô passando só pra saber se viu minha mensagem. Sem pressão nenhuma, mas se quiser testar são 14 dias grátis. Qualquer coisa é só me chamar!`;

  return { mensagem_whatsapp, mensagem_instagram, mensagem_followup };
}

/**
 * Recomenda plano baseado em múltiplos sinais de tamanho
 * Retorna { plan, tags }
 */
function recommendPlan(lead, reviewAnalysis = {}, marketingStatus = {}) {
  const planTags = [];

  // Verificar se é MEI/solo sem presença digital = risco de budget
  const isMEI = lead.porte && lead.porte.toUpperCase().includes('MEI');
  const hasNoDigital = !lead.website && !lead.instagram?.found;
  if (isMEI && hasNoDigital) {
    planTags.push('RISCO_BUDGET');
  }

  // Profissional: negócios maiores com múltiplos sinais
  const reviewVelocityHigh = reviewAnalysis.reviewVelocity > 15; // >15 reviews/mês
  const manyFollowers = lead.instagram?.seguidores >= 5000;
  const isEPPPlus = lead.porte && (lead.porte.toUpperCase().includes('EPP') || lead.porte.toUpperCase().includes('DEMAIS'));
  const manyReviews = lead.totalAvaliacoes > 80;
  const oldBusiness = lead.abertura && calcYears(lead.abertura) >= 8;

  if (manyReviews || reviewVelocityHigh || manyFollowers || isEPPPlus || oldBusiness) {
    return { plan: 'profissional', tags: planTags };
  }

  return { plan: 'start', tags: planTags };
}

/**
 * Estima número de funcionários com base em sinais disponíveis
 */
function estimateStaff(lead) {
  // Baseado em review velocity e horários
  const velocity = lead.reviewAnalysis?.reviewVelocity;
  const diasAbertos = (lead.horarios || []).filter(h => !/fechado/i.test(h)).length;

  if (!velocity && !diasAbertos) return null;

  // Heurística: ~1 review por 15-20 clientes, barbearia faz ~5-8 clientes/barbeiro/dia
  if (velocity > 5 && diasAbertos >= 6) return '3-5 barbeiros (alta demanda)';
  if (velocity > 2 && diasAbertos >= 5) return '2-3 barbeiros';
  if (velocity > 1) return '1-2 barbeiros';
  if (diasAbertos >= 6) return '2-3 barbeiros (aberto 6 dias)';

  return '1-2 barbeiros';
}

function suggestContactTime(horarios) {
  // Sazonalidade por mês
  const month = new Date().getMonth() + 1; // 1-12
  let sazonal;
  if ([1, 3, 7].includes(month)) {
    sazonal = 'alta';
  } else if (month === 12) {
    sazonal = 'baixa';
  } else {
    sazonal = 'media';
  }

  let horario;
  if (!horarios || horarios.length === 0) {
    horario = 'Segunda ou terça de manhã (antes do movimento)';
  } else {
    const segunda = horarios.find(h => /segunda|monday|seg/i.test(h));
    if (segunda && /fechado|closed/i.test(segunda)) {
      horario = 'Terça-feira de manhã (segunda é folga)';
    } else {
      const hasLateOpening = horarios.some(h => {
        const match = h.match(/(\d{2}):(\d{2})/);
        return match && parseInt(match[1]) >= 10;
      });

      if (hasLateOpening) {
        horario = 'Pela manhã, antes do horário de abertura';
      } else {
        horario = 'Segunda ou terça de manhã (antes do movimento)';
      }
    }
  }

  return { horario, sazonal };
}

function buildRisk(classificacao, scores, lead) {
  // Leads com dados limitados têm risco extra
  if (scores.confianca < 30) return 'alto';
  if (classificacao === 'FRIO') return 'alto';
  if (classificacao === 'MORNO') return 'medio';
  return 'baixo';
}

function buildRiskReason(lead, scores) {
  if (scores.confianca < 30) return 'Poucos dados disponíveis — validar manualmente antes de abordar';
  if (scores.oportunidade < 30) return 'Já tem solução de agendamento ou pouco interesse digital';
  if (scores.alcancabilidade < 30) return 'Difícil de contatar — sem WhatsApp nem Instagram';
  if (scores.tamanho < 20) return 'Estabelecimento muito pequeno — pode não ter budget';
  return 'Perfil adequado ao produto';
}

// ════════════════════════════════════════════════════
// UTILS
// ════════════════════════════════════════════════════

function isAltSource(lead) {
  const source = lead.source || '';
  return ['receita_federal', 'google_search', 'instagram_search'].includes(source);
}

function calcYears(dateStr) {
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return 0;
    return Math.floor((Date.now() - date.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
  } catch {
    return 0;
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

module.exports = { qualifyWithAI, qualifyWithRulesV2 };
