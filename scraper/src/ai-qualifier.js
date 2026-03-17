const axios = require('axios');
const { analyzeReviews } = require('./analysis/reviews');
const { analyzeMarketingStatus } = require('./analysis/marketing');
const { interpolate } = require('./config-loader');

// ════════════════════════════════════════════════════
// QUALIFICAÇÃO COM IA (Claude Haiku)
// ════════════════════════════════════════════════════

async function qualifyWithAI(lead, config = null) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return qualifyWithRulesV2(lead, config);
  }

  // Pré-qualificar por regras: só chamar IA para leads com potencial real
  const preScore = qualifyWithRulesV2(lead, config);
  // Threshold mais baixo para leads de fontes alternativas (têm menos dados)
  const threshold = isAltSource(lead) ? 20 : 35;
  if (preScore.score < threshold) {
    return { ...preScore, ai_analyzed: false, ai_skipped: true };
  }

  try {
    const prompt = buildPrompt(lead, config);

    const { data } = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 700,
      messages: [{ role: 'user', content: prompt }],
    }, {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: 30000,
    });

    const text = data.content[0].text;
    return parseAIResponse(text, lead, config);
  } catch (err) {
    console.error('[AI Qualifier] Erro:', err.response?.data?.error?.message || err.message);
    return qualifyWithRulesV2(lead, config);
  }
}

function buildPrompt(lead, config = null) {
  const reviews = (lead.reviews || [])
    .slice(0, 2)
    .map(r => `${r.nota}/5: "${(r.texto || '').substring(0, 80)}"`)
    .join('\n');

  const concorrente = lead.websiteAnalysis?.usaConcorrente
    ? lead.websiteAnalysis.competitorsFound.join(', ')
    : 'não';

  const contexto = config
    ? config.qualificacao.promptContexto
    : 'Consultor B2B SaaS barbearias. Produto: Bookou (agendamento, financeiro, comissões, lembretes WhatsApp). Start R$79,90/mês, Profissional R$149,90/mês.';

  // Dados extras por fonte
  const extras = [];
  if (lead.cnpj) extras.push(`CNPJ: ${lead.cnpj} | Porte: ${lead.porte || '?'}`);
  if (lead.abertura) extras.push(`Aberto desde: ${lead.abertura}`);
  if (lead.instagram?.seguidores) extras.push(`Instagram: ${lead.instagram.seguidores} seguidores, ${lead.instagram.posts || '?'} posts`);
  if (lead.instagram?.isBusiness) extras.push('Conta business no Instagram');
  if (lead.instagram?.temAgendamentoOnline) extras.push('Já tem link de agendamento no Instagram');
  if (lead.instagram?.temWhatsappLink) extras.push('Usa WhatsApp Business (link na bio)');
  const sources = lead.sources || [lead.source];
  if (sources.length > 1) extras.push(`Encontrado em ${sources.length} fontes: ${sources.join(', ')}`);

  return `${contexto}

LEAD: ${lead.nome} | ${lead.cidade || ''}
Site: ${lead.website || 'NÃO TEM'} | Instagram: ${lead.instagram?.url || 'não'} | WhatsApp: ${lead.whatsapp ? 'sim' : 'não'}
Rating: ${lead.rating}/5 (${lead.totalAvaliacoes} avaliações) | Concorrente: ${concorrente}
${extras.length > 0 ? extras.join('\n') : ''}
${lead.reviewAnalysis?.painSummary ? `Dores: ${lead.reviewAnalysis.painSummary}` : ''}
${reviews ? `Reviews:\n${reviews}` : ''}

JSON (sem markdown):
{"score":<0-100>,"classificacao":"<QUENTE|MORNO|FRIO>","perfil":"<1 frase>","dores_provaveis":["<d1>","<d2>"],"argumento_principal":"<1 frase>","plano_recomendado":"<start|profissional>","mensagem_whatsapp":"<máx 280 chars, personalizada>","mensagem_instagram":"<máx 180 chars>","mensagem_followup":"<máx 150 chars>","melhor_horario_contato":"<quando abordar>","risco":"<baixo|medio|alto>"}`;
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
  const marketingStatus = lead.marketingStatus || analyzeMarketingStatus(lead.instagram, lead.websiteAnalysis);

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

  // Marketing
  if (marketingStatus.instagramStatus === 'abandonado') scores.oportunidade += 15;
  if (marketingStatus.instagramStatus === 'nao_encontrado' && !lead.website) scores.oportunidade += 10;

  // WhatsApp sem concorrente = receptivo mas sem solução
  if (lead.whatsapp && !lead.websiteAnalysis?.usaConcorrente) scores.oportunidade += 10;

  // Dias abertos
  const diasAbertos = (lead.horarios || []).filter(h => !/fechado/i.test(h)).length;
  if (diasAbertos >= 6) scores.oportunidade += 10;

  // Instagram sem agendamento = oportunidade
  if (lead.instagram?.found && !lead.instagram?.temAgendamentoOnline && !lead.websiteAnalysis?.usaConcorrente) {
    scores.oportunidade += 10;
  }
  // Instagram já tem agendamento = menos oportunidade
  if (lead.instagram?.temAgendamentoOnline) {
    scores.oportunidade -= 15;
  }

  // CNPJ: empresa formal sem presença digital = grande oportunidade
  if (lead.cnpj && !lead.website && !lead.instagram?.found) {
    scores.oportunidade += 15;
  }

  scores.oportunidade = clamp(scores.oportunidade, 0, 100);

  // ═══ ALCANÇABILIDADE (0-100) ═══
  if (lead.whatsapp) scores.alcancabilidade += 45;
  else if (lead.telefone) scores.alcancabilidade += 20;

  if (lead.instagram?.found) scores.alcancabilidade += 25;
  if (lead.email) scores.alcancabilidade += 15;
  if (lead.googleMapsUrl) scores.alcancabilidade += 10;

  // CNPJ com telefone da Receita é confiável
  if (lead.cnpj && lead.telefone) scores.alcancabilidade += 5;

  scores.alcancabilidade = clamp(scores.alcancabilidade, 0, 100);

  // ═══ TAMANHO (0-100) — multi-sinal ═══
  scores.tamanho = estimateSize(lead);

  // ═══ URGÊNCIA (0-100) — multi-sinal ═══
  scores.urgencia = estimateUrgency(lead, reviewAnalysis, marketingStatus, config);

  // ═══ CONFIANÇA (0-100) — qualidade dos dados ═══
  scores.confianca = estimateConfidence(lead);

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
  if (finalScore >= 65) classificacao = 'QUENTE';
  else if (finalScore >= 40) classificacao = 'MORNO';
  else classificacao = 'FRIO';

  // Tags
  const tags = buildTags(lead, scores, reviewAnalysis, marketingStatus);

  // Dores prováveis
  const dores = buildDores(lead, reviewAnalysis, marketingStatus, config);

  // Mensagens
  const mensagens = buildMensagens(lead, dores, classificacao, config);

  // Plano recomendado — multi-sinal
  const plano = recommendPlan(lead);

  return {
    score: finalScore,
    scores,
    classificacao,
    tags,
    perfil: buildPerfil(lead, marketingStatus, config),
    dores_provaveis: dores,
    argumento_principal: buildArgumento(lead, dores, config),
    plano_recomendado: plano,
    ...mensagens,
    melhor_horario_contato: suggestContactTime(lead.horarios),
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

  // Bônus: rating alto = negócio estabelecido
  if (lead.rating >= 4.5 && lead.totalAvaliacoes >= 10) score = Math.min(100, score + 10);

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

  // Sinal 1: dores explícitas em reviews (mais forte)
  const schedulingPainKeys = config ? config.analise.schedulingPainKeys : ['fila', 'agendamento', 'lotado'];
  const painCount = schedulingPainKeys.reduce(
    (sum, key) => sum + (reviewAnalysis.painCounts?.[key] || 0), 0
  );

  if (painCount >= 5) score += 50;
  else if (painCount >= 3) score += 35;
  else if (painCount >= 1) score += 20;

  // Sinal 2: desorganização em reviews
  if (reviewAnalysis.hasOrganizationIssues) score += 15;

  // Sinal 3: sem presença digital nenhuma (urgente digitalizar)
  if (!lead.website && !lead.instagram?.found) score += 20;

  // Sinal 4: Instagram abandonado (tentou e parou)
  if (marketingStatus.instagramStatus === 'abandonado') score += 15;

  // Sinal 5: alto volume sem solução de agendamento
  const isHighVolume = (lead.totalAvaliacoes >= 80) || (lead.instagram?.seguidores >= 3000);
  const hasScheduling = lead.websiteAnalysis?.temAgendamentoOnline || lead.instagram?.temAgendamentoOnline;
  if (isHighVolume && !hasScheduling) score += 20;

  // Sinal 6: usa concorrente fraco / barato (oportunidade de troca)
  if (lead.websiteAnalysis?.usaConcorrente) {
    const competitors = lead.websiteAnalysis.competitorsFound || [];
    const weakCompetitors = ['simpleag', 'barzelink', 'barberapp', 'grazy', 'beautydock'];
    if (competitors.some(c => weakCompetitors.includes(c))) {
      score += 15;
    } else {
      score += 5; // usa concorrente forte, menor urgência de troca
    }
  }

  // Sinal 7: empresa antiga sem digital (urgente modernizar)
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
function estimateConfidence(lead) {
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

  // Marketing
  if (marketingStatus.instagramStatus === 'abandonado') tags.push('MARKETING_ABANDONADO');

  // Volume
  const isHighVolume = (lead.totalAvaliacoes >= 100) || (lead.instagram?.seguidores >= 5000);
  if (isHighVolume) tags.push('ALTO_VOLUME');

  // Contato
  if (!lead.whatsapp && !lead.telefone) tags.push('SEM_CONTATO');

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
    if (dores.some(d => d.includes('fila'))) {
      mensagem_whatsapp = `Oi! Vi nas avaliações da ${nome} que o movimento é forte! 💈 Sou da Bookou — com nosso agendamento online, seus clientes marcam pelo celular e acabam as filas. Posso te mostrar em 5 min?`;
    } else if (!lead.website) {
      mensagem_whatsapp = `Oi! Vi a ${nome} no Google e curti o trabalho! 💈 Criei uma plataforma de agendamento online pra barbearias — seus clientes agendam pelo celular, sem precisar ligar. Posso te mostrar rapidinho?`;
    } else if (lead.websiteAnalysis?.usaConcorrente) {
      mensagem_whatsapp = `Oi! Conheço a ${nome} e sei que já usam sistema de agendamento. 💈 Sou da Bookou — além de agenda, temos financeiro, comissões e lembretes WhatsApp automáticos. Queria te mostrar, topa?`;
    } else if (lead.totalAvaliacoes >= 100) {
      mensagem_whatsapp = `Oi! A ${nome} é referência no Google com ${lead.totalAvaliacoes} avaliações! 💈 Sou da Bookou, plataforma de gestão pra barbearias (agenda + financeiro + comissões). Queria te mostrar como pode ajudar, topa?`;
    } else {
      mensagem_whatsapp = `Oi! Conheci a ${nome} e achei o trabalho incrível! 💈 Sou da Bookou — plataforma de gestão pra barbearias com agendamento online, financeiro e lembretes automáticos. Posso te mostrar em 5 min?`;
    }
  }

  const mensagem_instagram = templates
    ? interpolate(templates.instagram, vars)
    : `Oi! Curti muito o trabalho da ${nomeSimples}! 🔥 Criei uma plataforma de agendamento online pra barbearias, posso te mostrar?`;

  const mensagem_followup = templates
    ? interpolate(templates.followup, vars)
    : `Oi de novo! 😊 Só passando pra ver se viu minha mensagem. Temos 14 dias grátis pra testar, sem compromisso!`;

  return { mensagem_whatsapp, mensagem_instagram, mensagem_followup };
}

/**
 * Recomenda plano baseado em múltiplos sinais de tamanho
 */
function recommendPlan(lead) {
  // Profissional: negócios maiores
  if (lead.totalAvaliacoes > 80) return 'profissional';
  if (lead.instagram?.seguidores >= 5000) return 'profissional';
  if (lead.porte && (lead.porte.toUpperCase().includes('EPP') || lead.porte.toUpperCase().includes('DEMAIS'))) return 'profissional';
  if (lead.abertura && calcYears(lead.abertura) >= 8) return 'profissional';

  return 'start';
}

function suggestContactTime(horarios) {
  if (!horarios || horarios.length === 0) return 'Segunda ou terça de manhã (antes do movimento)';

  const segunda = horarios.find(h => /segunda|monday|seg/i.test(h));
  if (segunda && /fechado|closed/i.test(segunda)) {
    return 'Terça-feira de manhã (segunda é folga)';
  }

  const hasLateOpening = horarios.some(h => {
    const match = h.match(/(\d{2}):(\d{2})/);
    return match && parseInt(match[1]) >= 10;
  });

  if (hasLateOpening) {
    return 'Pela manhã, antes do horário de abertura';
  }

  return 'Segunda ou terça de manhã (antes do movimento)';
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
