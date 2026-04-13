const { getConfig } = require('../config-loader');
const { interpolate } = require('../config-loader');

// ════════════════════════════════════════════════════
// DETECÇÃO DE INTENÇÃO
// ════════════════════════════════════════════════════

const STOP_WORDS = /\b(par[eao]r?|sair|não\s*quero|remove|stop|cancelar|não\s*tenho\s*interesse|me\s*tir[ea]|para\s*de|spam|desist[io]|chega)\b/i;
const HUMAN_WORDS = /\b(humano|atendente|pessoa|falar\s*com|vendedor|gerente|responsável|alguém\s*real|suporte)\b/i;
const INTEREST_WORDS = /\b(sim|quero|pode|manda|interessado|gostei|bora|vamos|show|massa|legal|mande|envia|por\s*favor|claro|fechado|topo|aceito|vamo)\b/i;
const GREETING_WORDS = /\b(oi|olá|ola|eai|eae|bom\s*dia|boa\s*tarde|boa\s*noite|hey|hello)\b/i;
const PRICE_WORDS = /\b(preço|preco|valor|custa|quanto|plano|mensalidade|pagar|investimento|custo)\b/i;
const DOUBT_WORDS = /\b(como\s*funciona|o\s*que\s*é|explica|dúvida|duvida|entender|detalhe|mais\s*info|funcionalidade|diferencial)\b/i;

function detectIntent(text) {
  const t = text.trim();
  if (STOP_WORDS.test(t)) return 'opt_out';
  if (HUMAN_WORDS.test(t)) return 'human';
  if (INTEREST_WORDS.test(t)) return 'interest';
  if (PRICE_WORDS.test(t)) return 'price_objection';
  if (DOUBT_WORDS.test(t)) return 'doubt';
  if (GREETING_WORDS.test(t)) return 'greeting';
  return 'unknown';
}

// ════════════════════════════════════════════════════
// MÁQUINA DE ESTADOS
// ════════════════════════════════════════════════════

/**
 * Processa mensagem recebida e retorna resposta + novo estágio
 * @param {string} phone
 * @param {string} text - mensagem do lead
 * @param {Object} convo - conversa atual (do conversation-store)
 * @param {string} pushName - nome do contato no WhatsApp
 * @returns {{ response: string|null, newStage: string, actions: string[] }}
 */
function process(phone, text, convo, pushName = '') {
  const stage = convo?.stage || 'novo';
  const intent = detectIntent(text);
  const config = loadSegmentConfig(convo?.segment);
  const respostas = config?.respostas || {};

  // Variáveis para interpolação
  const vars = buildVars(convo, config, pushName);

  // ── Opt-out SEMPRE tem prioridade ──
  if (intent === 'opt_out') {
    return {
      response: interpolateSimple(respostas.opted_out || 'Entendido! Desculpe o incômodo. Se precisar no futuro, estou à disposição.', vars),
      newStage: 'opted_out',
      actions: ['blocklist'],
    };
  }

  // ── Pedido de humano SEMPRE tem prioridade (exceto opt-out) ──
  if (intent === 'human') {
    return {
      response: interpolateSimple(respostas.human || 'Perfeito! Vou conectar você com um dos nossos especialistas. Em instantes alguém do time vai entrar em contato!', vars),
      newStage: 'human',
      actions: ['notify_human'],
    };
  }

  // ── Transições por estágio ──
  // Funil: contacted → engaged → interested → site_sent → human
  switch (stage) {
    case 'contacted':
      // Lead respondeu pela primeira vez — engajar
      return {
        response: interpolateSimple(respostas.engaged || 'Opa {nomeSimples}, que bom! O {produto} e um sistema de agendamento online com lembretes automaticos por WhatsApp. Quer saber mais?', vars),
        newStage: 'engaged',
        actions: [],
      };

    case 'engaged':
      if (intent === 'interest' || intent === 'greeting') {
        // Demonstrou interesse → direcionar pro site
        return {
          response: interpolateSimple(respostas.interested || 'Massa! Da uma olhada no site bookou.com.br, la voce ve os planos e ja consegue criar sua conta. Qualquer duvida me chama aqui!', vars),
          newStage: 'interested',
          actions: ['notify_human'],
        };
      }
      if (intent === 'price_objection') {
        return {
          response: interpolateSimple(respostas.objection_price || 'O plano começa em {precoStart}/mes. Com 2-3 clientes extras por mes ja se paga. Quer saber mais?', vars),
          newStage: 'objection',
          actions: [],
        };
      }
      if (intent === 'doubt') {
        return {
          response: interpolateSimple(respostas.objection_doubt || 'Seus clientes acessam uma pagina da sua barbearia, escolhem barbeiro, servico e horario. O sistema manda lembrete por WhatsApp. Voce controla tudo pelo celular. Quer ver?', vars),
          newStage: 'objection',
          actions: [],
        };
      }
      return {
        response: interpolateSimple(respostas.fallback || 'Desculpa, nao entendi direito. Voce gostaria de conhecer o sistema de agendamento? Me responde SIM que te explico rapidinho', vars),
        newStage: 'engaged',
        actions: [],
      };

    case 'objection':
      if (intent === 'interest') {
        // Resolveu objeção → direcionar pro site
        return {
          response: interpolateSimple(respostas.interested || 'Massa! Da uma olhada no site bookou.com.br, la voce ve os planos e ja consegue criar sua conta. Qualquer duvida me chama aqui!', vars),
          newStage: 'interested',
          actions: ['notify_human'],
        };
      }
      // Segunda objeção — escalar para humano (você faz a venda)
      const rounds = (convo?.objectionRounds || 0) + 1;
      if (rounds >= 2) {
        return {
          response: interpolateSimple(respostas.escalate || 'Entendo! Vou passar pro nosso time que consegue te explicar melhor. Um momento!', vars),
          newStage: 'human',
          actions: ['notify_human', 'increment_objection'],
        };
      }
      return {
        response: interpolateSimple(respostas.objection_general || 'Tranquilo! Posso pedir pro time te mostrar rapidinho como funciona, sem compromisso. O que acha?', vars),
        newStage: 'objection',
        actions: ['increment_objection'],
      };

    case 'interested':
      // Lead já recebeu link do site — se volta a falar, pode ter dúvida ou precisa de ajuda humana
      if (intent === 'interest') {
        return {
          response: interpolateSimple(respostas.interested_confirm || 'Isso ai! Acessa la o bookou.com.br e qualquer duvida me chama aqui. Valeu!', vars),
          newStage: 'interested',
          actions: [],
        };
      }
      // Qualquer outra coisa (dúvida, preço, etc) → escalar pra você fechar a venda
      return {
        response: interpolateSimple(respostas.escalate || 'Boa pergunta! Vou passar pra alguem do time que pode te ajudar melhor com isso. Um momento!', vars),
        newStage: 'human',
        actions: ['notify_human'],
      };

    case 'human':
      // Bot não responde — você está cuidando
      return { response: null, newStage: 'human', actions: [] };

    case 'opted_out':
      return { response: null, newStage: 'opted_out', actions: [] };

    case 'won':
    case 'lost':
      return { response: null, newStage: stage, actions: [] };

    default:
      return {
        response: interpolateSimple(respostas.engaged || 'Oi {nomeSimples}! Tudo bem? Posso te ajudar com algo?', vars),
        newStage: 'engaged',
        actions: [],
      };
  }
}

// ════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════

function loadSegmentConfig(segment) {
  try {
    return getConfig(segment || process.env.SEGMENT_ID || 'barbearias');
  } catch (_) {
    return null;
  }
}

function buildVars(convo, config, pushName) {
  const q = convo?.qualificationData || {};
  return {
    leadName: convo?.leadName || pushName || 'amigo',
    nome: q.nome || convo?.leadName || pushName || '',
    nomeSimples: (convo?.leadName || pushName || '').split(' ')[0] || 'amigo',
    produto: config?.produto?.nome || 'Bookou',
    segmento: config?.segmento?.nome || 'seu negócio',
    precoStart: config?.produto?.precoStart || 'R$80',
    precoProfissional: config?.produto?.precoProfissional || 'R$115',
    trial: config?.produto?.trial || '14 dias grátis',
    argumento: q.argumento_principal || '',
  };
}

function interpolateSimple(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] || '');
}

module.exports = { process, detectIntent };
