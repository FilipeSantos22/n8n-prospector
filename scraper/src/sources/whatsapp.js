const axios = require('axios');

const EVOLUTION_URL = process.env.EVOLUTION_API_URL || 'http://evolution:8080';
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY || '';
const INSTANCE_NAME = process.env.EVOLUTION_INSTANCE || 'bookou';

const api = axios.create({
  baseURL: EVOLUTION_URL,
  headers: {
    'apikey': EVOLUTION_KEY,
    'Content-Type': 'application/json',
  },
  timeout: 15000,
});

/**
 * Retorna status da conexão WhatsApp
 */
async function getWhatsAppStatus() {
  try {
    const { data } = await api.get(`/instance/connectionState/${INSTANCE_NAME}`);
    const connected = data?.instance?.state === 'open';
    return { connected, state: data?.instance?.state || 'unknown', instance: INSTANCE_NAME };
  } catch (err) {
    // Instância ainda não existe
    if (err.response?.status === 404) {
      return { connected: false, state: 'not_created', instance: INSTANCE_NAME };
    }
    throw new Error(`Evolution API indisponível: ${err.message}`);
  }
}

/**
 * Cria instância e retorna QR code para conexão
 */
async function connectWhatsApp() {
  try {
    // Tentar criar instância (ignora se já existe)
    await api.post('/instance/create', {
      instanceName: INSTANCE_NAME,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
    }).catch(() => {}); // ignora erro de "já existe"

    // Configurar webhook para receber mensagens
    await configureWebhook().catch(err =>
      console.warn('[WhatsApp] Webhook config falhou (não-crítico):', err.message)
    );

    // Buscar QR code
    const { data } = await api.get(`/instance/connect/${INSTANCE_NAME}`);

    if (data?.base64) {
      return {
        qrcode: data.base64,
        instructions: 'Abra o WhatsApp → Aparelhos conectados → Conectar um aparelho → Escaneie este QR code',
      };
    }

    // Se já está conectado
    const status = await getWhatsAppStatus();
    if (status.connected) {
      return { connected: true, message: 'WhatsApp já está conectado!' };
    }

    return { error: 'QR code não disponível', data };
  } catch (err) {
    throw new Error(`Erro ao conectar WhatsApp: ${err.response?.data?.message || err.message}`);
  }
}

/**
 * Envia mensagem de texto para um número
 * @param {string} number - Número no formato 5511999998888
 * @param {string} message - Texto da mensagem
 */
async function sendWhatsApp(number, message) {
  try {
    const { data } = await api.post(`/message/sendText/${INSTANCE_NAME}`, {
      number: number.toString().replace(/\D/g, ''),
      text: message,
    });

    return {
      success: true,
      messageId: data?.key?.id || null,
      number,
    };
  } catch (err) {
    const detail = err.response?.data?.message || err.message;
    throw new Error(`Falha ao enviar para ${number}: ${detail}`);
  }
}

/**
 * Configura webhook na Evolution API para receber mensagens
 */
async function configureWebhook() {
  const webhookUrl = `http://scraper:${process.env.PORT || 3099}/api/whatsapp/webhook`;
  await api.post(`/webhook/set/${INSTANCE_NAME}`, {
    enabled: true,
    url: webhookUrl,
    webhookByEvents: false,
    events: ['MESSAGES_UPSERT'],
  });
  console.log(`[WhatsApp] Webhook configurado: ${webhookUrl}`);
}

module.exports = { sendWhatsApp, getWhatsAppStatus, connectWhatsApp, configureWebhook };
