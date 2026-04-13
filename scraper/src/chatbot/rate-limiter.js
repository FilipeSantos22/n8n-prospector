const fs = require('fs');
const path = require('path');

const EXPORTS_DIR = process.env.EXPORTS_DIR || '/home/node/exports';
const RATE_FILE = path.join(EXPORTS_DIR, 'conversations', 'rate-limits.json');
const DAILY_LIMIT = parseInt(process.env.DAILY_SEND_LIMIT || '50');
const WORKING_HOURS_START = parseInt(process.env.WORKING_HOURS_START || '9');
const WORKING_HOURS_END = parseInt(process.env.WORKING_HOURS_END || '18');
const MIN_DELAY = parseInt(process.env.MIN_DELAY_MS || '45000');
const MAX_DELAY = parseInt(process.env.MAX_DELAY_MS || '90000');

// Data de início do warm-up (persistido no primeiro uso)
const WARMUP_FILE = path.join(EXPORTS_DIR, 'conversations', 'warmup-start.json');

function loadJSON(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (_) {}
  return fallback;
}

function saveJSON(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function todayKey() {
  return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
}

function getWarmupDay() {
  let warmup = loadJSON(WARMUP_FILE, null);
  if (!warmup) {
    warmup = { startDate: todayKey() };
    saveJSON(WARMUP_FILE, warmup);
  }
  const startMs = new Date(warmup.startDate).getTime();
  const nowMs = Date.now();
  return Math.floor((nowMs - startMs) / (24 * 60 * 60 * 1000)) + 1;
}

function getDailyLimit() {
  const day = getWarmupDay();
  if (day <= 7) return Math.min(5, DAILY_LIMIT);   // Semana 1: max 5/dia (warm-up)
  if (day <= 14) return Math.min(8, DAILY_LIMIT);   // Semana 2: max 8/dia
  return DAILY_LIMIT;                                // Depois: config (default 10)
}

function getTodaySent() {
  const data = loadJSON(RATE_FILE, {});
  return data[todayKey()]?.sent || 0;
}

function incrementSent() {
  const data = loadJSON(RATE_FILE, {});
  const key = todayKey();
  if (!data[key]) data[key] = { sent: 0, limit: getDailyLimit() };
  data[key].sent++;
  saveJSON(RATE_FILE, data);
  return data[key];
}

function canSendNow() {
  // Verificar horário de trabalho (timezone do sistema — São Paulo)
  const now = new Date();
  const hour = now.getHours();
  const dayOfWeek = now.getDay(); // 0=domingo

  if (dayOfWeek === 0) {
    return { allowed: false, reason: 'Domingo — sem envios' };
  }
  if (dayOfWeek === 6 && hour >= 13) {
    return { allowed: false, reason: 'Sábado após 13h — sem envios' };
  }
  if (hour < WORKING_HOURS_START || hour >= WORKING_HOURS_END) {
    return { allowed: false, reason: `Fora do horário (${WORKING_HOURS_START}h-${WORKING_HOURS_END}h)` };
  }

  // Verificar limite diário
  const sent = getTodaySent();
  const limit = getDailyLimit();
  if (sent >= limit) {
    return { allowed: false, reason: `Limite diário atingido (${sent}/${limit})`, sent, limit };
  }

  return {
    allowed: true,
    sent,
    limit,
    remaining: limit - sent,
    warmupDay: getWarmupDay(),
  };
}

function getRandomDelay() {
  return MIN_DELAY + Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY));
}

function getStats() {
  const data = loadJSON(RATE_FILE, {});
  const key = todayKey();
  return {
    today: data[key] || { sent: 0, limit: getDailyLimit() },
    warmupDay: getWarmupDay(),
    dailyLimit: getDailyLimit(),
    workingHours: `${WORKING_HOURS_START}h-${WORKING_HOURS_END}h`,
    delayRange: `${MIN_DELAY}-${MAX_DELAY}ms`,
    history: Object.entries(data)
      .sort(([a], [b]) => b.localeCompare(a))
      .slice(0, 7)
      .map(([date, v]) => ({ date, ...v })),
  };
}

module.exports = {
  canSendNow,
  incrementSent,
  getRandomDelay,
  getDailyLimit,
  getWarmupDay,
  getStats,
};
