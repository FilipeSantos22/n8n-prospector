const fs = require('fs');
const path = require('path');

const EXPORTS_DIR = process.env.EXPORTS_DIR || '/home/node/exports';
const CONVO_DIR = path.join(EXPORTS_DIR, 'conversations');
const INDEX_FILE = path.join(CONVO_DIR, 'index.json');
const BLOCKLIST_FILE = path.join(CONVO_DIR, 'blocklist.json');

function ensureDir() {
  if (!fs.existsSync(CONVO_DIR)) fs.mkdirSync(CONVO_DIR, { recursive: true });
}

function loadJSON(filePath, fallback = {}) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (_) {}
  return fallback;
}

function saveJSON(filePath, data) {
  ensureDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ════════════════════════════════════════════════════
// INDEX — resumo rápido de todas as conversas
// ════════════════════════════════════════════════════

function getIndex() {
  return loadJSON(INDEX_FILE, {});
}

function updateIndex(phone, summary) {
  const index = getIndex();
  index[phone] = { ...index[phone], ...summary, updatedAt: new Date().toISOString() };
  saveJSON(INDEX_FILE, index);
}

// ════════════════════════════════════════════════════
// CONVERSA — estado completo por telefone
// ════════════════════════════════════════════════════

function convoPath(phone) {
  return path.join(CONVO_DIR, `${phone}.json`);
}

function getConversation(phone) {
  return loadJSON(convoPath(phone), null);
}

function saveConversation(phone, data) {
  saveJSON(convoPath(phone), data);
  updateIndex(phone, {
    stage: data.stage,
    leadName: data.leadName,
    segment: data.segment,
    lastMessageAt: data.lastMessageAt,
    optedOut: data.optedOut || false,
    humanHandoff: data.humanHandoff || false,
  });
}

function createConversation(phone, { leadName, segment, leadId, qualificationData } = {}) {
  const now = new Date().toISOString();
  const convo = {
    phone,
    leadName: leadName || '',
    stage: 'contacted',
    segment: segment || process.env.SEGMENT_ID || 'barbearias',
    leadId: leadId || null,
    messages: [],
    optedOut: false,
    humanHandoff: false,
    followupsSent: 0,
    objectionRounds: 0,
    firstContactAt: now,
    lastMessageAt: now,
    lastInboundAt: null,
    qualificationData: qualificationData || {},
  };
  saveConversation(phone, convo);
  return convo;
}

function updateStage(phone, stage) {
  const convo = getConversation(phone);
  if (!convo) return null;
  convo.stage = stage;
  if (stage === 'opted_out') convo.optedOut = true;
  if (stage === 'human') convo.humanHandoff = true;
  saveConversation(phone, convo);
  return convo;
}

function addMessage(phone, msg) {
  const convo = getConversation(phone);
  if (!convo) return null;
  convo.messages.push(msg);
  convo.lastMessageAt = msg.timestamp;
  if (msg.direction === 'in') convo.lastInboundAt = msg.timestamp;
  saveConversation(phone, convo);
  return convo;
}

function incrementFollowups(phone) {
  const convo = getConversation(phone);
  if (!convo) return null;
  convo.followupsSent = (convo.followupsSent || 0) + 1;
  saveConversation(phone, convo);
  return convo;
}

// ════════════════════════════════════════════════════
// CONSULTAS
// ════════════════════════════════════════════════════

function getByStage(stage) {
  const index = getIndex();
  return Object.entries(index)
    .filter(([_, v]) => v.stage === stage)
    .map(([phone, v]) => ({ phone, ...v }));
}

function getStaleConversations(olderThanMs) {
  const cutoff = Date.now() - olderThanMs;
  const index = getIndex();
  return Object.entries(index)
    .filter(([_, v]) => {
      if (v.optedOut || v.humanHandoff) return false;
      return new Date(v.lastMessageAt).getTime() < cutoff;
    })
    .map(([phone, v]) => ({ phone, ...v }));
}

function getAllConversations(stageFilter = null) {
  const index = getIndex();
  const entries = Object.entries(index);
  if (stageFilter) return entries.filter(([_, v]) => v.stage === stageFilter).map(([phone, v]) => ({ phone, ...v }));
  return entries.map(([phone, v]) => ({ phone, ...v }));
}

// ════════════════════════════════════════════════════
// BLOCKLIST — opt-out permanente
// ════════════════════════════════════════════════════

function getBlocklist() {
  return loadJSON(BLOCKLIST_FILE, []);
}

function isBlocked(phone) {
  return getBlocklist().includes(phone);
}

function addToBlocklist(phone) {
  const list = getBlocklist();
  if (!list.includes(phone)) {
    list.push(phone);
    saveJSON(BLOCKLIST_FILE, list);
  }
  // Também atualizar conversa se existir
  const convo = getConversation(phone);
  if (convo) {
    convo.optedOut = true;
    convo.stage = 'opted_out';
    saveConversation(phone, convo);
  }
}

function removeFromBlocklist(phone) {
  const list = getBlocklist().filter(p => p !== phone);
  saveJSON(BLOCKLIST_FILE, list);
}

// ════════════════════════════════════════════════════
// STATS
// ════════════════════════════════════════════════════

function getStats() {
  const index = getIndex();
  const entries = Object.values(index);
  const stages = {};
  for (const e of entries) {
    stages[e.stage] = (stages[e.stage] || 0) + 1;
  }
  return {
    total: entries.length,
    stages,
    optedOut: entries.filter(e => e.optedOut).length,
    humanHandoff: entries.filter(e => e.humanHandoff).length,
    blocklist: getBlocklist().length,
  };
}

module.exports = {
  getConversation,
  saveConversation,
  createConversation,
  updateStage,
  addMessage,
  incrementFollowups,
  getByStage,
  getStaleConversations,
  getAllConversations,
  isBlocked,
  addToBlocklist,
  removeFromBlocklist,
  getBlocklist,
  getStats,
};
