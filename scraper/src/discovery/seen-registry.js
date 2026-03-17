const { getStorage } = require('../storage');

/**
 * Registro de leads já vistos — evita re-prospectar leads conhecidos
 * Usa o storage layer (arquivo ou banco)
 */
class SeenRegistry {
  constructor() {
    this.storage = getStorage();
    this._cache = new Map(); // Cache em memória por tenant
  }

  /**
   * Carrega histórico de dedup para o tenant (com cache em memória)
   */
  _getHistory(tenantId = 'default') {
    if (!this._cache.has(tenantId)) {
      this._cache.set(tenantId, this.storage.loadDedupHistory(tenantId));
    }
    return this._cache.get(tenantId);
  }

  /**
   * Marca leads como vistos
   * @param {Array} leads - Array de leads processados
   * @param {string} tenantId
   * @returns {number} Quantidade de novos marcados
   */
  markSeen(leads, tenantId = 'default') {
    const history = this._getHistory(tenantId);
    let added = 0;
    const now = new Date().toISOString();

    for (const lead of leads) {
      const keys = this._extractKeys(lead);
      for (const key of keys) {
        if (!history[key]) {
          history[key] = now;
          added++;
        }
      }
    }

    if (added > 0) {
      this.storage.saveDedupHistory(history, tenantId);
    }

    return added;
  }

  /**
   * Filtra leads, retornando apenas os que NUNCA foram vistos
   * @param {Array} leads - Leads do discovery
   * @param {string} tenantId
   * @returns {Array} Apenas leads novos
   */
  filterNew(leads, tenantId = 'default') {
    const history = this._getHistory(tenantId);

    return leads.filter(lead => {
      const keys = this._extractKeys(lead);
      // Se qualquer chave do lead já foi vista, é conhecido
      return !keys.some(key => !!history[key]);
    });
  }

  /**
   * Verifica se um lead específico já foi visto
   */
  isKnown(lead, tenantId = 'default') {
    const history = this._getHistory(tenantId);
    const keys = this._extractKeys(lead);
    return keys.some(key => !!history[key]);
  }

  /**
   * Retorna estatísticas
   */
  stats(tenantId = 'default') {
    const history = this._getHistory(tenantId);
    return {
      totalSeen: Object.keys(history).length,
    };
  }

  /**
   * Extrai chaves únicas de identificação de um lead
   * Usa: place_id, cnpj, instagram handle
   */
  _extractKeys(lead) {
    const keys = [];
    if (lead.place_id) keys.push(`pid:${lead.place_id}`);
    if (lead.cnpj) keys.push(`cnpj:${lead.cnpj.replace(/\D/g, '')}`);
    if (lead.instagram?.handle) keys.push(`ig:${lead.instagram.handle}`);
    // Nome normalizado + cidade como fallback
    if (lead.nome && lead.cidade) {
      const nameKey = (lead.nome + ':' + lead.cidade)
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9:]/g, '');
      keys.push(`name:${nameKey}`);
    }
    return keys;
  }

  /**
   * Limpa cache em memória (forçar reload do disco)
   */
  clearCache() {
    this._cache.clear();
  }
}

let instance = null;

function getSeenRegistry() {
  if (!instance) {
    instance = new SeenRegistry();
  }
  return instance;
}

module.exports = { SeenRegistry, getSeenRegistry };
