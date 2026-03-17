const { FileStorage } = require('./file-storage');

let instance = null;

function createStorage(options = {}) {
  const backend = process.env.STORAGE_BACKEND || 'file';

  switch (backend) {
    case 'file':
      return new FileStorage(options);
    // case 'postgres':
    //   return new PostgresStorage(options);
    // case 'mongo':
    //   return new MongoStorage(options);
    default:
      return new FileStorage(options);
  }
}

function getStorage() {
  if (!instance) {
    instance = createStorage();
  }
  return instance;
}

module.exports = { createStorage, getStorage };
