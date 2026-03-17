const { MemoryCache } = require('./memory-cache');

let instance = null;

function createCache(options = {}) {
  const backend = process.env.CACHE_BACKEND || 'memory';

  switch (backend) {
    case 'memory':
      return new MemoryCache(options);
    // case 'redis':
    //   return new RedisCache(options);
    default:
      return new MemoryCache(options);
  }
}

function getCache() {
  if (!instance) {
    instance = createCache();
  }
  return instance;
}

module.exports = { createCache, getCache };
