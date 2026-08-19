const { getStorage } = require('../storage');
const { normalizePhone } = require('../utils/phone');

/**
 * Status de abordagem por lead — Estágio 5 do spec de prospecção.
 *
 * Diferente do seen-registry (que só responde "já vi este lead alguma vez?"),
 * este store guarda o ESTADO COMERCIAL de cada lead e é o que impede
 * recontato indevido.
 *
 * Estados: novo | abordado | respondeu | nao_perturbe | cliente
 *
 * `nao_perturbe` é DEFINITIVO: quem entra nunca mais pode ser selecionado por
 * nenhuma execução futura. Por isso o filtro roda no INÍCIO do pre-filter, não
 * no fim do pipeline.
 */

const STATUSES = ['novo', 'abordado', 'respondeu', 'nao_perturbe', 'cliente'];
const TERMINAL = ['nao_perturbe', 'cliente'];

class LeadStatusStore {
  constructor() {
    this.storage = getStorage();
    this._cache = new Map();
  }

  _all(tenantId = 'default') {
    if (!this._cache.has(tenantId)) {
      this._cache.set(tenantId, this.storage.loadLeadStatus(tenantId));
    }
    return this._cache.get(tenantId);
  }

  _persist(tenantId = 'default') {
    this.storage.saveLeadStatus(this._all(tenantId), tenantId);
  }

  /**
   * Chaves de identificação de um lead. Um mesmo lead pode ter várias — todas
   * apontam para o mesmo registro, para que o status encontre o lead
   * independente de por qual fonte ele reapareceu.
   *
   * Espelha o critério do spec: place_id + telefone normalizado.
   */
  _keysFor(lead) {
    const keys = [];
    if (lead.place_id) keys.push(`pid:${lead.place_id}`);

    for (const raw of [lead.whatsapp, lead.telefone, lead.telefone2]) {
      const norm = normalizePhone(raw);
      if (norm) keys.push(`tel:${norm}`);
    }

    if (lead.cnpj) keys.push(`cnpj:${String(lead.cnpj).replace(/\D/g, '')}`);

    if (lead.nome && (lead.cidade || lead.city)) {
      const slug = `${lead.nome}:${lead.cidade || lead.city}`
        .toLowerCase()
        .normalize('NFD').replace(new RegExp('[\u0300-\u036f]', 'g'), '')
        .replace(/[^a-z0-9:]/g, '');
      keys.push(`name:${slug}`);
    }

    return [...new Set(keys)];
  }

  /** Registro de status do lead, ou null se nunca visto. */
  get(lead, tenantId = 'default') {
    const all = this._all(tenantId);
    for (const key of this._keysFor(lead)) {
      if (all[key]) return all[key];
    }
    return null;
  }

  /**
   * Grava/atualiza o status. Escreve em TODAS as chaves do lead, para que uma
   * reaparição por outra fonte encontre o mesmo estado.
   */
  set(lead, status, extra = {}, tenantId = 'default') {
    if (!STATUSES.includes(status)) {
      throw new Error(`Status inválido: "${status}". Válidos: ${STATUSES.join(', ')}`);
    }

    const all = this._all(tenantId);
    const keys = this._keysFor(lead);
    if (keys.length === 0) return null;

    const anterior = this.get(lead, tenantId);
    const registro = {
      ...(anterior || {}),
      chave: keys[0],
      nome: lead.nome || anterior?.nome || '',
      cidade: lead.cidade || lead.city || anterior?.cidade || '',
      telefone: lead.telefone || anterior?.telefone || '',
      whatsapp: lead.whatsapp || anterior?.whatsapp || '',
      score: lead.qualification?.score ?? anterior?.score ?? null,
      status,
      dataColeta: anterior?.dataColeta || new Date().toISOString(),
      atualizadoEm: new Date().toISOString(),
      ...extra,
    };
    if (status === 'abordado' && !registro.dataAbordagem) {
      registro.dataAbordagem = new Date().toISOString();
    }

    for (const key of keys) all[key] = registro;
    this._persist(tenantId);
    return registro;
  }

  /** Atalho para o opt-out — o caminho mais importante deste módulo. */
  naoPerturbe(lead, motivo = 'pedido do contato', tenantId = 'default') {
    return this.set(lead, 'nao_perturbe', { motivoNaoPerturbe: motivo }, tenantId);
  }

  isNaoPerturbe(lead, tenantId = 'default') {
    return this.get(lead, tenantId)?.status === 'nao_perturbe';
  }

  /** Lead em estado terminal (nao_perturbe ou cliente) não volta para a fila. */
  isTerminal(lead, tenantId = 'default') {
    const st = this.get(lead, tenantId)?.status;
    return !!st && TERMINAL.includes(st);
  }

  /**
   * Remove da lista quem está em estado terminal.
   * @returns {{ leads: Array, removidos: number, porStatus: Object }}
   */
  filtrarTerminais(leads, tenantId = 'default') {
    const porStatus = {};
    const mantidos = [];
    for (const lead of leads) {
      const st = this.get(lead, tenantId)?.status;
      if (st && TERMINAL.includes(st)) {
        porStatus[st] = (porStatus[st] || 0) + 1;
        continue;
      }
      mantidos.push(lead);
    }
    return { leads: mantidos, removidos: leads.length - mantidos.length, porStatus };
  }

  /** Marca como `novo` quem ainda não tem registro. Não sobrescreve estado existente. */
  registrarNovos(leads, tenantId = 'default') {
    let criados = 0;
    for (const lead of leads) {
      if (!this.get(lead, tenantId)) {
        this.set(lead, 'novo', {}, tenantId);
        criados++;
      }
    }
    return criados;
  }

  /** Registros únicos (deduplicados por chave primária). */
  listar(status = null, tenantId = 'default') {
    const all = this._all(tenantId);
    const vistos = new Set();
    const out = [];
    for (const reg of Object.values(all)) {
      if (vistos.has(reg.chave)) continue;
      vistos.add(reg.chave);
      if (!status || reg.status === status) out.push(reg);
    }
    return out;
  }

  stats(tenantId = 'default') {
    const porStatus = {};
    for (const reg of this.listar(null, tenantId)) {
      porStatus[reg.status] = (porStatus[reg.status] || 0) + 1;
    }
    return { total: this.listar(null, tenantId).length, porStatus };
  }

  clearCache() {
    this._cache.clear();
  }
}

let instance = null;
function getLeadStatus() {
  if (!instance) instance = new LeadStatusStore();
  return instance;
}

module.exports = { LeadStatusStore, getLeadStatus, STATUSES, TERMINAL };
