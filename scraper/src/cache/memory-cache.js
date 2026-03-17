const fs = require('fs');
const path = require('path');

const DEFAULT_TTLS = {
  'place-details': 7 * 24 * 60 * 60,   // 7 dias
  'website-analysis': 3 * 24 * 60 * 60, // 3 dias
  'instagram-profile': 1 * 24 * 60 * 60, // 1 dia
  'cnpj': 30 * 24 * 60 * 60,            // 30 dias
};

class MemoryCache {
  constructor(options = {}) {
    this.store = new Map();
    this.persistDir = options.persistDir || process.env.CACHE_DIR || null;
    this.ttls = { ...DEFAULT_TTLS, ...options.ttls };

    // Carregar cache persistido do disco
    if (this.persistDir) {
      this._loadFromDisk();
    }

    // Sweep periódico para liberar memória (a cada 5 min)
    this._sweepInterval = setInterval(() => this._sweep(), 5 * 60 * 1000);
    this._sweepInterval.unref();
  }

  _key(namespace, key) {
    return `${namespace}:${key}`;
  }

  get(namespace, key) {
    const entry = this.store.get(this._key(namespace, key));
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(this._key(namespace, key));
      return null;
    }
    return entry.value;
  }

  set(namespace, key, value, ttlSeconds = null) {
    const ttl = ttlSeconds || this.ttls[namespace] || 3600;
    this.store.set(this._key(namespace, key), {
      value,
      expiresAt: Date.now() + ttl * 1000,
      namespace,
    });
  }

  has(namespace, key) {
    return this.get(namespace, key) !== null;
  }

  del(namespace, key) {
    this.store.delete(this._key(namespace, key));
  }

  clear(namespace = null) {
    if (!namespace) {
      this.store.clear();
      return;
    }
    for (const [k, v] of this.store) {
      if (v.namespace === namespace) this.store.delete(k);
    }
  }

  stats() {
    const byNamespace = {};
    for (const [, v] of this.store) {
      const ns = v.namespace || 'unknown';
      byNamespace[ns] = (byNamespace[ns] || 0) + 1;
    }
    return { total: this.store.size, byNamespace };
  }

  _sweep() {
    const now = Date.now();
    let removed = 0;
    for (const [k, v] of this.store) {
      if (v.expiresAt && now > v.expiresAt) {
        this.store.delete(k);
        removed++;
      }
    }
    if (removed > 0) {
      console.log(`[Cache] Sweep: ${removed} entradas expiradas removidas`);
    }
  }

  /**
   * Persiste cache no disco (chamado no shutdown graceful)
   */
  persistToDisk() {
    if (!this.persistDir) return;
    try {
      if (!fs.existsSync(this.persistDir)) {
        fs.mkdirSync(this.persistDir, { recursive: true });
      }

      // Agrupar por namespace
      const namespaces = {};
      for (const [k, v] of this.store) {
        if (v.expiresAt && Date.now() > v.expiresAt) continue;
        const ns = v.namespace || 'default';
        if (!namespaces[ns]) namespaces[ns] = {};
        namespaces[ns][k] = v;
      }

      for (const [ns, entries] of Object.entries(namespaces)) {
        const filePath = path.join(this.persistDir, `${ns}.json`);
        fs.writeFileSync(filePath, JSON.stringify(entries));
      }

      console.log(`[Cache] Persistido no disco: ${this.store.size} entradas`);
    } catch (err) {
      console.error('[Cache] Erro ao persistir:', err.message);
    }
  }

  _loadFromDisk() {
    if (!this.persistDir || !fs.existsSync(this.persistDir)) return;
    try {
      const files = fs.readdirSync(this.persistDir).filter(f => f.endsWith('.json'));
      let loaded = 0;
      const now = Date.now();

      for (const file of files) {
        const filePath = path.join(this.persistDir, file);
        const entries = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        for (const [k, v] of Object.entries(entries)) {
          if (v.expiresAt && now > v.expiresAt) continue;
          this.store.set(k, v);
          loaded++;
        }
      }

      if (loaded > 0) {
        console.log(`[Cache] Carregado do disco: ${loaded} entradas`);
      }
    } catch (err) {
      console.error('[Cache] Erro ao carregar cache do disco:', err.message);
    }
  }

  destroy() {
    clearInterval(this._sweepInterval);
    this.persistToDisk();
  }
}

module.exports = { MemoryCache };
