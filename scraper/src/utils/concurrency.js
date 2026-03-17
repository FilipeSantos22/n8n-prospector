/**
 * Executa fn para cada item com concorrência limitada
 * @param {Array} items - Itens para processar
 * @param {Function} fn - Função async (item, index) => result
 * @param {number} concurrency - Máximo de execuções simultâneas
 * @returns {Array} Resultados na mesma ordem dos items
 */
async function pMap(items, fn, concurrency = 3) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index], index);
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}

module.exports = { pMap };
