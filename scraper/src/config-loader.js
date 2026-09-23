const fs = require('fs');
const path = require('path');
const { validateConfig } = require('./configs/schema');

const CONFIGS_DIR = path.join(__dirname, 'configs');
const configCache = new Map();

/**
 * Carrega e compila um config de segmento
 * Converte strings regex para objetos RegExp
 */
function loadConfig(id) {
  if (configCache.has(id)) return configCache.get(id);

  const filePath = path.join(CONFIGS_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Config de segmento nao encontrada: "${id}" (esperado: ${filePath})`);
  }

  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  validateConfig(raw);

  // Compilar regex strings para objetos RegExp
  const compiled = { ...raw };

  // analise.painKeywords: string -> RegExp
  compiled.analise = { ...raw.analise };
  compiled.analise.painKeywords = {};
  for (const [key, pattern] of Object.entries(raw.analise.painKeywords)) {
    compiled.analise.painKeywords[key] = new RegExp(pattern, 'i');
  }

  // analise.positiveKeywords: string -> RegExp
  compiled.analise.positiveKeywords = new RegExp(raw.analise.positiveKeywords, 'i');

  // analise.competitors: string -> RegExp
  compiled.analise.competitors = {};
  for (const [key, pattern] of Object.entries(raw.analise.competitors)) {
    compiled.analise.competitors[key] = new RegExp(pattern, 'i');
  }

  // analise.excluirNomes (OPCIONAL): string -> RegExp
  // Nomes de rede/franquia a descartar no pre-filter. Ausente = nada a excluir.
  compiled.analise.excluirNomes = raw.analise.excluirNomes
    ? new RegExp(raw.analise.excluirNomes, 'i')
    : null;

  // analise.sinaisAgendamentoOnline (OPCIONAL): string -> RegExp
  // O que conta como "já resolve online" muda por nicho: para barbearia é agenda,
  // para locadora é reserva, para revenda é catálogo de estoque. Ausente = heurística
  // padrão do website-analyzer ("agend" + "horário"/"disponív").
  compiled.analise.sinaisAgendamentoOnline = raw.analise.sinaisAgendamentoOnline
    ? new RegExp(raw.analise.sinaisAgendamentoOnline, 'i')
    : null;

  configCache.set(id, compiled);
  return compiled;
}

/**
 * Retorna o config do segmento atual (via env SEGMENT_ID ou default)
 */
function getConfig(segmentId) {
  const id = segmentId || process.env.SEGMENT_ID || 'barbearias';
  return loadConfig(id);
}

/**
 * Retorna config por ID especifico
 */
function getConfigById(id) {
  return loadConfig(id);
}

/**
 * Lista todos os segmentos disponiveis
 */
function listSegments() {
  const files = fs.readdirSync(CONFIGS_DIR).filter(f => f.endsWith('.json'));
  return files.map(f => {
    const id = f.replace('.json', '');
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(CONFIGS_DIR, f), 'utf-8'));
      return { id, nome: raw.nome, produto: raw.produto?.nome };
    } catch {
      return { id, nome: id, produto: '?' };
    }
  });
}

/**
 * Interpola variaveis em uma string template
 * Suporta: {nome}, {produto}, {segmento}, {nomeSimples}, {avaliacoes}, {trial}, {concorrentes}
 */
function interpolate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    return vars[key] !== undefined ? vars[key] : match;
  });
}

module.exports = { getConfig, getConfigById, listSegments, interpolate };
