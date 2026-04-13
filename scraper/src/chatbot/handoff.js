const axios = require('axios');
const { sendWhatsApp } = require('../sources/whatsapp');

const HANDOFF_PHONE = process.env.HANDOFF_PHONE || '';
const HANDOFF_WEBHOOK_URL = process.env.HANDOFF_WEBHOOK_URL || '';

/**
 * Notifica humano sobre lead quente / pedido de atendimento
 */
async function notifyHumanHandoff(phone, convo) {
  const leadName = convo?.leadName || 'Lead';
  const stage = convo?.stage || '?';
  const q = convo?.qualificationData || {};
  const lastMsgs = (convo?.messages || []).slice(-5).map(m => `${m.direction === 'in' ? '←' : '→'} ${m.text}`).join('\n');

  const summary = [
    `🔥 Lead quente para atendimento!`,
    ``,
    `Nome: ${leadName}`,
    `WhatsApp: ${phone}`,
    `Estágio: ${stage}`,
    q.classificacao ? `Score: ${q.score || '?'} (${q.classificacao})` : '',
    q.dores_provaveis?.length ? `Dores: ${q.dores_provaveis.join(', ')}` : '',
    q.argumento_principal ? `Argumento: ${q.argumento_principal}` : '',
    ``,
    `Últimas mensagens:`,
    lastMsgs || '(sem histórico)',
    ``,
    `👉 Entrar em contato AGORA`,
  ].filter(Boolean).join('\n');

  const results = { whatsapp: false, webhook: false };

  // Notificar via WhatsApp para o dono/vendedor
  if (HANDOFF_PHONE) {
    try {
      await sendWhatsApp(HANDOFF_PHONE, summary);
      results.whatsapp = true;
      console.log(`[Handoff] Notificação WhatsApp enviada para ${HANDOFF_PHONE}`);
    } catch (err) {
      console.error(`[Handoff] Erro WhatsApp:`, err.message);
    }
  }

  // Notificar via webhook (n8n, Slack, etc.)
  if (HANDOFF_WEBHOOK_URL) {
    try {
      await axios.post(HANDOFF_WEBHOOK_URL, {
        event: 'handoff',
        phone,
        leadName,
        stage,
        qualification: q,
        lastMessages: (convo?.messages || []).slice(-10),
        timestamp: new Date().toISOString(),
      }, { timeout: 10000 });
      results.webhook = true;
      console.log(`[Handoff] Webhook enviado para ${HANDOFF_WEBHOOK_URL}`);
    } catch (err) {
      console.error(`[Handoff] Erro webhook:`, err.message);
    }
  }

  if (!HANDOFF_PHONE && !HANDOFF_WEBHOOK_URL) {
    console.warn(`[Handoff] Nenhum destino configurado (HANDOFF_PHONE ou HANDOFF_WEBHOOK_URL). Lead ${phone} precisa de atendimento!`);
  }

  return results;
}

module.exports = { notifyHumanHandoff };
