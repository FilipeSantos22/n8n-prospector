const crypto = require('crypto');

/**
 * Fila inline — executa jobs síncronamente (sem Redis/BullMQ)
 * Mesma interface que uma fila real, mas roda tudo em processo
 */
class InlineQueue {
  constructor() {
    this.handlers = new Map();
    this.jobs = new Map();
  }

  /**
   * Registra handler para um tipo de job
   */
  onJob(jobName, handler) {
    this.handlers.set(jobName, handler);
  }

  /**
   * Enfileira e executa imediatamente
   */
  async enqueue(jobName, payload, options = {}) {
    const jobId = crypto.randomUUID();
    const handler = this.handlers.get(jobName);

    if (!handler) {
      throw new Error(`Handler não registrado para job "${jobName}"`);
    }

    const job = {
      id: jobId,
      name: jobName,
      state: 'active',
      progress: 0,
      result: null,
      error: null,
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(jobId, job);

    const { retries = 0, retryDelay = 2000 } = options;
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const progressFn = (pct) => { job.progress = pct; };
        job.result = await handler(payload, progressFn);
        job.state = 'completed';
        job.completedAt = new Date().toISOString();
        return jobId;
      } catch (err) {
        lastError = err;
        if (attempt < retries) {
          console.warn(`[Queue] Job ${jobName} falhou (tentativa ${attempt + 1}/${retries + 1}), retrying...`);
          await sleep(retryDelay);
        }
      }
    }

    job.state = 'failed';
    job.error = lastError?.message || 'Unknown error';
    job.failedAt = new Date().toISOString();
    throw lastError;
  }

  getJobStatus(jobId) {
    return this.jobs.get(jobId) || null;
  }

  listJobs(state = null) {
    const all = [...this.jobs.values()];
    return state ? all.filter(j => j.state === state) : all;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { InlineQueue };
