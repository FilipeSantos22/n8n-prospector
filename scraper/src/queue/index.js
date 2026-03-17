const { InlineQueue } = require('./inline-queue');

let instance = null;

function createQueue(options = {}) {
  const backend = process.env.QUEUE_BACKEND || 'inline';

  switch (backend) {
    case 'inline':
      return new InlineQueue(options);
    // case 'bullmq':
    //   return new BullMQQueue(options);
    default:
      return new InlineQueue(options);
  }
}

function getQueue() {
  if (!instance) {
    instance = createQueue();
  }
  return instance;
}

module.exports = { createQueue, getQueue };
