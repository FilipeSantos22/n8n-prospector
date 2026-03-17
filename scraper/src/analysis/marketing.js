/**
 * Análise de status de marketing digital da barbearia
 */

/**
 * Avalia o status de marketing baseado em Instagram e website
 * @param {Object} instagram - Dados do Instagram
 * @param {Object} websiteAnalysis - Análise do website
 * @returns {Object} Status do marketing
 */
function analyzeMarketingStatus(instagram, websiteAnalysis) {
  const status = {
    digitalPresence: 'baixa', // baixa, media, alta
    instagramStatus: 'desconhecido',
    websiteStatus: 'sem_site',
    signals: [],
  };

  // Instagram
  if (instagram?.found) {
    if (instagram.seguidores > 5000) {
      status.digitalPresence = 'alta';
      status.signals.push('Instagram forte (5k+ seguidores)');
    } else if (instagram.seguidores > 1000) {
      status.digitalPresence = 'media';
      status.signals.push('Instagram ativo');
    } else {
      status.signals.push('Instagram pequeno');
    }

    // Verificar atividade
    if (instagram.posts !== null) {
      if (instagram.posts < 10) {
        status.instagramStatus = 'abandonado';
        status.signals.push('Instagram praticamente abandonado (<10 posts)');
      } else if (instagram.posts < 50) {
        status.instagramStatus = 'irregular';
        status.signals.push('Instagram com poucos posts');
      } else {
        status.instagramStatus = 'ativo';
      }
    }

    // WhatsApp na bio = usa WhatsApp Business
    if (instagram.temWhatsappLink) {
      status.signals.push('Usa WhatsApp Business (link na bio)');
    }

    // Tem link de agendamento = já usa algo
    if (instagram.temAgendamentoOnline) {
      status.signals.push('Tem link de agendamento no Instagram');
    }
  } else {
    status.instagramStatus = 'nao_encontrado';
    status.signals.push('Instagram não encontrado');
  }

  // Website
  if (websiteAnalysis?.analyzed) {
    status.websiteStatus = 'ativo';

    if (websiteAnalysis.usaConcorrente) {
      status.signals.push(`Usa concorrente: ${websiteAnalysis.competitorsFound.join(', ')}`);
    }
    if (websiteAnalysis.temAgendamentoOnline) {
      status.signals.push('Site tem agendamento online');
    }
    if (websiteAnalysis.maturidadeDigital >= 7) {
      status.digitalPresence = 'alta';
      status.signals.push('Site com boa maturidade digital');
    }
  } else {
    status.signals.push('Sem website');
  }

  // Score de presença digital (0-10)
  let presenceScore = 0;
  if (instagram?.found) presenceScore += 2;
  if (instagram?.seguidores > 1000) presenceScore += 1;
  if (instagram?.seguidores > 5000) presenceScore += 1;
  if (websiteAnalysis?.analyzed) presenceScore += 2;
  if (websiteAnalysis?.temAgendamentoOnline) presenceScore += 2;
  if (websiteAnalysis?.usaConcorrente) presenceScore += 1;
  if (websiteAnalysis?.maturidadeDigital >= 5) presenceScore += 1;

  status.presenceScore = Math.min(10, presenceScore);

  return status;
}

module.exports = { analyzeMarketingStatus };
