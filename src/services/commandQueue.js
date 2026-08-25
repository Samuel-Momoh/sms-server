const { pushQueue, popQueue, getQueueItems, removeQueueItem, clearQueueKey } = require('../db/redis');
const { logCommand, updateCommandStatus } = require('../db/mysql');
const { logger } = require('../logger');
const { gpsEventEmitter } = require('../gpsEvents');

function getQueueKey(imei) {
  return `tracker:queue:${imei}`;
}

/**
 * Enqueue a command for an IMEI.
 * If the tracker is online, dispatches immediately.
 * If offline/asleep, saves to Redis and MySQL queue.
 *
 * @param {string} imei
 * @param {string} commandOrCmd
 * @param {Array<string|number>} [params=[]]
 * @param {Object} [options={}]
 * @param {Function} sendCommandFn  Function to send command if device is online
 * @param {Function} isOnlineFn     Function returning boolean if device is online
 * @returns {Promise<Object>}
 */
async function enqueueCommand(imei, commandOrCmd, params = [], options = {}, sendCommandFn, isOnlineFn) {
  if (!imei) {
    return { success: false, error: 'IMEI is required' };
  }

  const isOnline = typeof isOnlineFn === 'function' ? isOnlineFn(imei) : false;
  const commandId = `cmd_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  // 1. If device is currently online and connected, dispatch immediately
  if (isOnline && !options.forceQueue && typeof sendCommandFn === 'function') {
    const result = await sendCommandFn(imei, commandOrCmd, params);
    
    // Log to MySQL
    await logCommand({
      commandId,
      imei,
      cmdCode: typeof commandOrCmd === 'string' && commandOrCmd.startsWith('*') ? 'RAW' : commandOrCmd,
      commandString: result.command || commandOrCmd,
      status: result.success ? 'SENT' : 'FAILED',
      params,
    });

    return {
      ...result,
      commandId,
      queued: false,
    };
  }

  // 2. Device is offline / sleeping -> Queue the command in Redis & MySQL
  const queueItem = {
    commandId,
    imei,
    cmd: commandOrCmd,
    params,
    queuedAt: new Date().toISOString(),
  };

  const key = getQueueKey(imei);
  await pushQueue(key, queueItem);

  // Persist to MySQL command logs with QUEUED status
  await logCommand({
    commandId,
    imei,
    cmdCode: typeof commandOrCmd === 'string' && commandOrCmd.startsWith('*') ? 'RAW' : commandOrCmd,
    commandString: typeof commandOrCmd === 'string' && commandOrCmd.startsWith('*') ? commandOrCmd : `${commandOrCmd}(${params.join(',')})`,
    status: 'QUEUED',
    params,
  });

  logger.info('HQ_COMMAND_QUEUED', {
    commandId,
    imei,
    cmd: commandOrCmd,
    params,
    message: `Tracker ${imei} is offline/sleeping. Command queued and will execute automatically upon reconnection.`,
  });

  gpsEventEmitter.emit('gps:command_queued', {
    commandId,
    imei,
    cmd: commandOrCmd,
    params,
    queuedAt: queueItem.queuedAt,
  });

  return {
    success: true,
    queued: true,
    commandId,
    imei,
    cmd: commandOrCmd,
    params,
    queuedAt: queueItem.queuedAt,
    message: `Device ${imei} is currently sleeping or offline. Command has been queued in Redis/MySQL and will automatically execute when the device wakes up.`,
  };
}

/**
 * Flush all queued commands for an IMEI sequentially over an active TCP socket.
 *
 * @param {string} imei
 * @param {Function} sendCommandFn
 */
async function flushQueuedCommands(imei, sendCommandFn) {
  if (!imei || typeof sendCommandFn !== 'function') return;

  const key = getQueueKey(imei);
  const items = await getQueueItems(key);

  if (!items || items.length === 0) return;

  logger.info('HQ_QUEUE_FLUSH_START', {
    imei,
    pendingCount: items.length,
    message: `Flushing ${items.length} queued command(s) for freshly connected tracker ${imei}`,
  });

  let index = 0;
  for (const item of items) {
    // Delay each command by 500ms to allow tracker modem to process without congestion
    setTimeout(async () => {
      try {
        const res = await sendCommandFn(imei, item.cmd, item.params);
        await updateCommandStatus(item.commandId, res.success ? 'SENT' : 'FAILED', {
          error: res.error,
        });

        // Remove from Redis queue
        await removeQueueItem(key, item.commandId);

        logger.info('HQ_QUEUED_COMMAND_DISPATCHED', {
          commandId: item.commandId,
          imei,
          cmd: item.cmd,
          success: res.success,
          command: res.command,
        });

        gpsEventEmitter.emit('gps:command_dispatched', {
          commandId: item.commandId,
          imei,
          cmd: item.cmd,
          success: res.success,
          dispatchedAt: new Date().toISOString(),
        });
      } catch (err) {
        logger.error('HQ_QUEUED_COMMAND_DISPATCH_ERROR', {
          commandId: item.commandId,
          imei,
          error: err.message,
        });
      }
    }, index * 500);

    index++;
  }
}

/**
 * Get all queued commands for an IMEI.
 *
 * @param {string} imei
 * @returns {Promise<Array>}
 */
async function getQueuedCommands(imei) {
  if (!imei) return [];
  const key = getQueueKey(imei);
  return getQueueItems(key);
}

/**
 * Cancel a specific queued command.
 *
 * @param {string} imei
 * @param {string} commandId
 * @returns {Promise<boolean>}
 */
async function cancelQueuedCommand(imei, commandId) {
  if (!imei || !commandId) return false;
  const key = getQueueKey(imei);
  const removed = await removeQueueItem(key, commandId);
  if (removed) {
    await updateCommandStatus(commandId, 'CANCELLED');
    logger.info('HQ_COMMAND_CANCELLED', { imei, commandId });
    gpsEventEmitter.emit('gps:command_cancelled', { imei, commandId });
  }
  return removed;
}

/**
 * Clear all queued commands for an IMEI.
 *
 * @param {string} imei
 * @returns {Promise<boolean>}
 */
async function clearQueue(imei) {
  if (!imei) return false;
  const key = getQueueKey(imei);
  const items = await getQueueItems(key);
  for (const item of items) {
    if (item.commandId) {
      await updateCommandStatus(item.commandId, 'CANCELLED');
    }
  }
  await clearQueueKey(key);
  logger.info('HQ_QUEUE_CLEARED', { imei });
  gpsEventEmitter.emit('gps:queue_cleared', { imei });
  return true;
}

module.exports = {
  enqueueCommand,
  flushQueuedCommands,
  getQueuedCommands,
  cancelQueuedCommand,
  clearQueue,
  getQueueKey,
};
