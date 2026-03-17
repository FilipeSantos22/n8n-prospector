const axios = require('axios');
const { analyzeReviews } = require('./analysis/reviews');
const { analyzeMarketingStatus } = require('./analysis/marketing');

// ════════════════════════════════════════════════════
// QUALIFICAÇÃO COM IA (Claude Haiku)
// ════════════════════════════════════════════════════

async function qualifyWithAI(lead) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return qualifyWithRulesV2(lead);
  }

  // Pré-qualificar por regras: só chamar IA para leads com potencial real
  const preScore = qualifyWithRulesV2(lead);
  if (preScore.score < 35) {
    return { ...preScore, ai_analyzed: false, ai_skipped: true };
  }

  try {
    const prompt = buildPrompt(lead);

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
    return parseAIResponse(text, lead);
  } catch (err) {
    console.error('[AI Qualifier] Erro:', err.response?.data?.error?.message || err.message);
    return qualifyWithRulesV2(lead);
  }
}

function buildPrompt(lead) {
  const reviews = (lead.reviews || [])
    .slice(0, 2)
    .map(r => `${r.nota}/5: "${(r.texto || '').substring(0, 80)}"`)
    .join('\n');

  const concorrente = lead.websiteAnalysis?.usaConcorrente
    ? lead.websiteAnalysis.competitorsFound.join(', ')
    : 'não';

  return `Consultor B2B SaaS barbearias. Produto: Bookou (agendamento, financeiro, comissões, lembretes WhatsApp). Start R$79,90/mês, Profissional R$149,90/mês.

LEAD: ${lead.nome} | ${lead.cidade || ''}
Site: ${lead.website || 'NÃO TEM'} | Instagram: ${lead.instagram?.url || 'não'} | WhatsApp: ${lead.whatsapp ? 'sim' : 'não'}
Rating: ${lead.rating}/5 (${lead.totalAvaliacoes} avaliações) | Concorrente: ${concorrente}
${lead.reviewAnalysis?.painSummary ? `Dores: ${lead.reviewAnalysis.painSummary}` : ''}
${reviews ? `Reviews:\n${reviews}` : ''}

JSON (sem markdown):
{"score":<0-100>,"classificacao":"<QUENTE|MORNO|FRIO>","perfil":"<1 frase>","dores_provaveis":["<d1>","<d2>"],"argumento_principal":"<1 frase>","plano_recomendado":"<start|profissional>","mensagem_whatsapp":"<máx 280 chars, personalizada>","mensagem_instagram":"<máx 180 chars>","mensagem_followup":"<máx 150 chars>","melhor_horario_contato":"<quando abordar>","risco":"<baixo|medio|alto>"}`;
}

function parseAIResponse(text, lead) {
  try {
    const clean = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(clean);
    return {
      ...parsed,
      ai_analyzed: true,
    };
  } catch (err) {
    console.error('[AI Qualifier] Erro ao parsear resposta:', err.message);
    return qualifyWithRulesV2(lead);
  }
}

// ════════════════════════════════════════════════════
// QUALIFICAÇÃO V2 — POR REGRAS (PONDERADA)
// ════════════════════════════════════════════════════

function qualifyWithRulesV2(lead) {
  // Analisar reviews
  const reviewAnalysis = lead.reviewAnalysis || analyzeReviews(lead.reviews);
  // Analisar marketing
  const marketingStatus = lead.marketingStatus || analyzeMarketingStatus(lead.instagram, lead.websiteAnalysis);

  const scores = {
    oportunidade: 0,
    alcancabilidade: 0,
    tamanho: 0,
    urgencia: 0,
  };

  // ═══ OPORTUNIDADE (0-100) ═══
  if (!lead.website) {
    scores.oportunidade += 35;
  } else if (!lead.websiteAnalysis?.temAgendamentoOnline) {
    scores.oportunidade += 25;
  } else if (lead.websiteAnalysis?.usaConcorrente) {
    scores.oportunidade += 15;
  } else {
    scores.oportunidade += 5;
  }

  if (reviewAnalysis.hasSchedulingPain) scores.oportunidade += 30;
  if (reviewAnalysis.hasSchedulingPraise) scores.oportunidade -= 20;

  if (marketingStatus.instagramStatus === 'abandonado') scores.oportunidade += 15;
  if (lead.whatsapp && !lead.websiteAnalysis?.usaConcorrente) scores.oportunidade += 10;

  const diasAbertos = (lead.horarios || []).filter(h => !/fechado/i.test(h)).length;
  if (diasAbertos >= 6) scores.oportunidade += 10;

  scores.oportunidade = clamp(scores.oportunidade, 0, 100);

  // ═══ ALCANÇABILIDADE (0-100) ═══
  if (lead.whatsapp) scores.alcancabilidade += 50;
  else if (lead.telefone) scores.alcancabilidade += 20;
  if (lead.instagram?.found) scores.alcancabilidade += 25;
  if (lead.email) scores.alcancabilidade += 15;
  if (lead.googleMapsUrl) scores.alcancabilidade += 10;

  scores.alcancabilidade = clamp(scores.alcancabilidade, 0, 100);

  // ═══ TAMANHO (0-100) ═══
  if (lead.totalAvaliacoes >= 200) scores.tamanho = 100;
  else if (lead.totalAvaliacoes >= 100) scores.tamanho = 80;
  else if (lead.totalAvaliacoes >= 50) scores.tamanho = 60;
  else if (lead.totalAvaliacoes >= 20) scores.tamanho = 40;
  else if (lead.totalAvaliacoes >= 10) scores.tamanho = 20;
  else scores.tamanho = 10;

  if (lead.rating >= 4.5) scores.tamanho = Math.min(100, scores.tamanho + 10);

  // ═══ URGÊNCIA (0-100) ═══
  const painCount = (reviewAnalysis.painCounts?.fila || 0) +
    (reviewAnalysis.painCounts?.agendamento || 0) +
    (reviewAnalysis.painCounts?.lotado || 0);

  if (painCount >= 5) scores.urgencia = 100;
  else if (painCount >= 3) scores.urgencia = 70;
  else if (painCount >= 1) scores.urgencia = 40;

  // ═══ SCORE FINAL (ponderado) ═══
  const finalScore = Math.round(
    scores.oportunidade * 0.40 +
    scores.alcancabilidade * 0.30 +
    scores.tamanho * 0.20 +
    scores.urgencia * 0.10
  );

  // Classificação
  let classificacao;
  if (finalScore >= 65) classificacao = 'QUENTE';
  else if (finalScore >= 40) classificacao = 'MORNO';
  else classificacao = 'FRIO';

  // Tags
  const tags = [];
  if (!lead.website) tags.push('SEM_SITE');
  if (lead.websiteAnalysis?.usaConcorrente) tags.push('USA_CONCORRENTE');
  if (reviewAnalysis.hasSchedulingPain) tags.push('RECLAMA_FILA');
  if (marketingStatus.instagramStatus === 'abandonado') tags.push('MARKETING_ABANDONADO');
  if (lead.totalAvaliacoes >= 100) tags.push('ALTO_VOLUME');
  if (!lead.whatsapp && !lead.telefone) tags.push('SEM_CONTATO');
  if (scores.oportunidade >= 70) tags.push('ALTA_OPORTUNIDADE');
  if (scores.alcancabilidade >= 70) tags.push('FACIL_CONTATO');

  // Dores prováveis
  const dores = buildDores(lead, reviewAnalysis, marketingStatus);

  // Mensagens
  const mensagens = buildMensagens(lead, dores, classificacao);

  // Plano recomendado
  const plano = lead.totalAvaliacoes > 80 ? 'profissional' : 'start';

  return {
    score: finalScore,
    scores,
    classificacao,
    tags,
    perfil: buildPerfil(lead, marketingStatus),
    dores_provaveis: dores,
    argumento_principal: buildArgumento(lead, dores),
    plano_recomendado: plano,
    ...mensagens,
    melhor_horario_contato: suggestContactTime(lead.horarios),
    risco: classificacao === 'FRIO' ? 'alto' : classificacao === 'MORNO' ? 'medio' : 'baixo',
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
// HELPERS DE QUALIFICAÇÃO
// ════════════════════════════════════════════════════

function buildDores(lead, reviewAnalysis, marketingStatus) {
  const dores = [];

  if (!lead.website) {
    dores.push('Sem presença digital — clientes não conseguem agendar online');
  } else if (!lead.websiteAnalysis?.temAgendamentoOnline) {
    dores.push('Tem site mas sem agendamento online — perde clientes que querem praticidade');
  }

  if (reviewAnalysis.hasSchedulingPain) {
    dores.push('Clientes reclamam de fila e espera nas avaliações do Google');
  }

  if (lead.totalAvaliacoes >= 100) {
    dores.push('Alto volume de clientes — gestão manual de agenda é insustentável');
  }

  const diasAbertos = (lead.horarios || []).filter(h => !/fechado/i.test(h)).length;
  if (diasAbertos >= 6) {
    dores.push('Abre 6+ dias por semana — precisa otimizar agenda e comissões');
  }

  if (lead.websiteAnalysis?.usaConcorrente) {
    dores.push(`Usa ${lead.websiteAnalysis.competitorsFound.join('/')} — pode estar insatisfeito com custo ou funcionalidades`);
  }

  if (marketingStatus.instagramStatus === 'abandonado') {
    dores.push('Marketing digital abandonado — precisa de ferramentas que simplifiquem a gestão');
  }

  if (reviewAnalysis.hasOrganizationIssues) {
    dores.push('Reviews mencionam desorganização — sistema de gestão resolveria');
  }

  if (dores.length === 0) {
    dores.push('Gestão manual de agenda', 'Sem relatórios financeiros automatizados');
  }

  return dores.slice(0, 4);
}

function buildPerfil(lead, marketingStatus) {
  const parts = [];

  if (lead.totalAvaliacoes >= 200) parts.push('Barbearia grande e estabelecida');
  else if (lead.totalAvaliacoes >= 100) parts.push('Barbearia popular');
  else if (lead.totalAvaliacoes >= 50) parts.push('Barbearia em crescimento');
  else if (lead.totalAvaliacoes >= 20) parts.push('Barbearia de bairro');
  else parts.push('Barbearia pequena/nova');

  if (lead.rating >= 4.5) parts.push('com excelente reputação');
  else if (lead.rating >= 4.0) parts.push('com boa reputação');

  if (marketingStatus.digitalPresence === 'alta') parts.push('e forte presença digital');
  else if (marketingStatus.digitalPresence === 'baixa') parts.push('com presença digital fraca');

  return parts.join(' ');
}

function buildArgumento(lead, dores) {
  if (dores.some(d => d.includes('fila') || d.includes('espera'))) {
    return 'Agendamento online elimina filas — seus clientes agendam pelo celular';
  }
  if (!lead.website) {
    return 'Página de agendamento online pronta — seus clientes agendam sem ligar';
  }
  if (lead.websiteAnalysis?.usaConcorrente) {
    return 'Bookou é mais completo (agenda + financeiro + comissões) e com suporte brasileiro';
  }
  if (lead.totalAvaliacoes >= 100) {
    return 'Gestão completa: agenda, financeiro, comissões e lembretes automáticos';
  }
  return 'Agendamento online + gestão financeira em um só lugar';
}

function buildMensagens(lead, dores, classificacao) {
  const nomeSimples = lead.nome.replace(/barbearia\s*/i, '').trim();
  const nome = lead.nome;

  // WhatsApp — personalizada baseada nas dores
  let mensagem_whatsapp;
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

  // Instagram
  const mensagem_instagram = `Oi! Curti muito o trabalho da ${nomeSimples}! 🔥 Criei uma plataforma de agendamento online pra barbearias, posso te mostrar?`;

  // Follow-up
  const mensagem_followup = `Oi de novo! 😊 Só passando pra ver se viu minha mensagem. Temos 14 dias grátis pra testar, sem compromisso!`;

  return { mensagem_whatsapp, mensagem_instagram, mensagem_followup };
}

function suggestContactTime(horarios) {
  if (!horarios || horarios.length === 0) return 'Segunda ou terça de manhã (antes do movimento)';

  // Verificar se abre segunda
  const segunda = horarios.find(h => /segunda|monday|seg/i.test(h));
  if (segunda && /fechado|closed/i.test(segunda)) {
    return 'Terça-feira de manhã (segunda é folga)';
  }

  // Verificar se abre tarde
  const hasLateOpening = horarios.some(h => {
    const match = h.match(/(\d{2}):(\d{2})/);
    return match && parseInt(match[1]) >= 10;
  });

  if (hasLateOpening) {
    return 'Pela manhã, antes do horário de abertura';
  }

  return 'Segunda ou terça de manhã (antes do movimento)';
}

function buildRiskReason(lead, scores) {
  if (scores.oportunidade < 30) return 'Já tem solução de agendamento ou pouco interesse digital';
  if (scores.alcancabilidade < 30) return 'Difícil de contatar — sem WhatsApp nem Instagram';
  if (scores.tamanho < 20) return 'Barbearia muito pequena — pode não ter budget';
  return 'Perfil adequado ao produto';
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

module.exports = { qualifyWithAI, qualifyWithRulesV2 };
