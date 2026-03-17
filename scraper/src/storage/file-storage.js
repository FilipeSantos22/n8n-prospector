const fs = require('fs');
const path = require('path');

class FileStorage {
  constructor(options = {}) {
    this.baseDir = options.baseDir || process.env.EXPORTS_DIR || '/home/node/exports';
  }

  _tenantDir(tenantId = 'default') {
    const dir = tenantId === 'default'
      ? this.baseDir
      : path.join(this.baseDir, 'tenants', tenantId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  _filePath(tenantId, filename) {
    return path.join(this._tenantDir(tenantId), filename);
  }

  _readJSON(filePath, fallback = null) {
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      }
    } catch (err) {
      console.error(`[Storage] Erro lendo ${filePath}:`, err.message);
    }
    return fallback;
  }

  _writeJSON(filePath, data) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  }

  // ═══ PIPELINE RUNS ═══

  savePipelineRun(run, tenantId = 'default') {
    // Salvar run individual
    const runFile = this._filePath(tenantId, `runs/run-${run.id}.json`);
    this._writeJSON(runFile, run);

    // Append ao índice de runs
    const indexFile = this._filePath(tenantId, 'runs/index.json');
    const index = this._readJSON(indexFile, []);
    const existing = index.findIndex(r => r.id === run.id);
    const summary = {
      id: run.id,
      segmentId: run.segmentId,
      cities: run.cities,
      status: run.status,
      totalLeads: run.totalLeads || 0,
      createdAt: run.createdAt,
      updatedAt: new Date().toISOString(),
    };
    if (existing >= 0) {
      index[existing] = summary;
    } else {
      index.push(summary);
    }
    this._writeJSON(indexFile, index);

    return run;
  }

  getPipelineRun(runId, tenantId = 'default') {
    return this._readJSON(this._filePath(tenantId, `runs/run-${runId}.json`));
  }

  listPipelineRuns(tenantId = 'default') {
    return this._readJSON(this._filePath(tenantId, 'runs/index.json'), []);
  }

  updatePipelineRunStatus(runId, status, extra = {}, tenantId = 'default') {
    const run = this.getPipelineRun(runId, tenantId);
    if (run) {
      run.status = status;
      run.updatedAt = new Date().toISOString();
      Object.assign(run, extra);
      this.savePipelineRun(run, tenantId);
    }
    return run;
  }

  // ═══ LEADS ═══

  saveLeads(runId, leads, meta = {}, tenantId = 'default') {
    const data = { leads, meta: { ...meta, runId, savedAt: new Date().toISOString() }, total: leads.length };
    this._writeJSON(this._filePath(tenantId, `leads-${runId}.json`), data);

    // Também salvar como "latest" para o dashboard
    this._writeJSON(this._filePath(tenantId, 'leads-data.json'), data);

    return data;
  }

  getLeads(runId, tenantId = 'default') {
    return this._readJSON(this._filePath(tenantId, `leads-${runId}.json`), { leads: [], total: 0 });
  }

  getLatestLeads(tenantId = 'default') {
    return this._readJSON(this._filePath(tenantId, 'leads-data.json'), { leads: [], resumo: {}, meta: {} });
  }

  // ═══ DEDUP HISTORY (leads já vistos) ═══

  _dedupFile(tenantId) {
    return this._filePath(tenantId, 'dedup-history.json');
  }

  loadDedupHistory(tenantId = 'default') {
    return this._readJSON(this._dedupFile(tenantId), {});
  }

  saveDedupHistory(history, tenantId = 'default') {
    this._writeJSON(this._dedupFile(tenantId), history);
  }

  markSeen(identifiers, tenantId = 'default') {
    const history = this.loadDedupHistory(tenantId);
    let added = 0;
    for (const id of identifiers) {
      if (id && !history[id]) {
        history[id] = new Date().toISOString();
        added++;
      }
    }
    if (added > 0) {
      this.saveDedupHistory(history, tenantId);
    }
    return added;
  }

  isKnown(identifier, tenantId = 'default') {
    if (!identifier) return false;
    const history = this.loadDedupHistory(tenantId);
    return !!history[identifier];
  }

  // ═══ TEMP FILES (progresso de enrichment, etc.) ═══

  saveTempData(name, data, tenantId = 'default') {
    this._writeJSON(this._filePath(tenantId, `temp/${name}.json`), data);
  }

  getTempData(name, tenantId = 'default') {
    return this._readJSON(this._filePath(tenantId, `temp/${name}.json`));
  }
}

module.exports = { FileStorage };
