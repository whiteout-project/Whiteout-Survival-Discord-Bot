const {
    getProcessById,
    resolveProcessGameType,
    updateProcessStatus,
    setProcessPreemption,
    clearProcessPreemption,
    getActiveProcesses,
    getProcessesByStatus,
    getProcessesByActionAndTarget,
    PROCESS_STATUS
} = require('./createProcesses');
const { systemLogQueries, allianceQueries } = require('../utility/database');

// Import process executor (avoid circular dependency by lazy loading)
let processExecutor = null;
const getProcessExecutor = () => {
    if (!processExecutor) {
        processExecutor = require('./executeProcesses').processExecutor;
    }
    return processExecutor;
};

// Import process recovery (avoid circular dependency by lazy loading)
let processRecovery = null;
const getProcessRecovery = () => {
    if (!processRecovery) {
        processRecovery = require('./processRecovery').processRecovery;
    }
    return processRecovery;
};

/**
 * SQLite-based priority queue management for process execution
 */
class QueueManager {
    constructor() {
        this._startingNext = false;
        this.supportedGames = ['wos', 'ks'];
    }

    async startProcess(process, paused = null) {
        const executor = getProcessExecutor();
        if (executor.activeProcesses.has(process.id)) return false;

        await updateProcessStatus(process.id, PROCESS_STATUS.ACTIVE);

        if (process.preempted_by) {
            await clearProcessPreemption(process.id);
        }

        const executionPayload = {
            process_id: process.id,
            status: 'active',
            paused
        };

        executor.executeProcess(executionPayload).catch(error => {
            systemLogQueries.addLog('error', `Unhandled execution error for process ${process.id}`,
                JSON.stringify({ process_id: process.id, error: error.message, function: 'startProcess' }));
        });
        return true;
    }

    /**
     * Manages process queue and priority handling
     * @param {Object} processInfo - Process information from createProcess
     * @param {number} processInfo.process_id - Process ID
     * @param {string} processInfo.status - Current status
     * @param {number} processInfo.priority - Process priority
     * @param {string} processInfo.action - Process action type
     * @returns {Promise<Object>} Queue management result
     */
    async manageQueue(processInfo) {
        try {
            const { process_id, priority } = processInfo;
            const process = await getProcessById(process_id);
            if (!process) {
                throw new Error(`Process ${process_id} not found during queue management`);
            }

            const processGameType = resolveProcessGameType(process);

            // Check for active processes
            const activeProcesses = await getActiveProcesses();
            const sameGameActive = activeProcesses.filter(activeProcess =>
                resolveProcessGameType(activeProcess) === processGameType
            );

            if (sameGameActive.length === 0) {
                await this.startNextProcess();
                const updatedProcess = await getProcessById(process_id);

                if (updatedProcess?.status === PROCESS_STATUS.ACTIVE) {
                    return {
                        process_id,
                        status: 'active',
                        paused: null,
                        message: 'Task started.',
                        messageType: 'success',
                        queue_position: 0
                    };
                }

                return {
                    process_id,
                    status: 'queue',
                    paused: null,
                    message: 'Task queued and will start when older same-game tasks complete.',
                    messageType: 'info',
                    queue_position: await this.getQueuePosition(process_id, processGameType)
                };
            }

            // There are same-game active processes, check priorities within the game slot only.
            const highestPriorityActive = Math.min(...sameGameActive.map(p => p.priority));

            if (priority < highestPriorityActive) {
                // This process has higher priority, preempt the same-game active ones.
                const preemptedProcesses = [];
                // Pause same-game active processes with lower priority.
                for (const activeProcess of sameGameActive) {
                    if (activeProcess.priority > priority) {
                        await setProcessPreemption(activeProcess.id, process_id);
                        preemptedProcesses.push(activeProcess.id);
                    }
                }

                await this.startProcess(process, preemptedProcesses[0] || null);

                return {
                    process_id,
                    status: 'active',
                    paused: preemptedProcesses[0] || null,
                    message: 'Higher priority task started, previous task paused.',
                    messageType: 'warning',
                    preempted_processes: preemptedProcesses
                };
            } else {
                // This process has lower or equal priority, queue it

                return {
                    process_id,
                    status: 'queue',
                    paused: null,
                    message: 'Task queued and will start when older same-game tasks complete.',
                    messageType: 'info',
                    queue_position: await this.getQueuePosition(process_id, processGameType)
                };
            }

        } catch (error) {
            console.error('Error managing queue:', error);
            systemLogQueries.addLog(
                'error',
                'Error managing queue',
                JSON.stringify({
                    processInfo,
                    error: error.message,
                    stack: error.stack,
                    function: 'manageQueue'
                })
            );
            throw error;
        }
    }

    /**
     * Gets the queue position for a process
     * @param {number} processId - Process ID
     * @returns {Promise<number>} Queue position (0-based)
     */
    async getQueuePosition(processId, gameType = null) {
        try {
            const process = await getProcessById(processId);
            if (!process) return -1;
            const processGameType = gameType || resolveProcessGameType(process);
            const queuedProcesses = await this.getQueuedProcesses();
            let position = 0;

            for (const queuedProcess of queuedProcesses) {
                if (queuedProcess.id === processId) break;
                if (resolveProcessGameType(queuedProcess) !== processGameType) continue;
                if (queuedProcess.priority < process.priority ||
                    (queuedProcess.priority === process.priority &&
                        new Date(queuedProcess.created_at) < new Date(process.created_at))) {
                    position++;
                }
            }

            return position;
        } catch (error) {
            return -1;
        }
    }

    /**
     * Starts the next process in queue based on priority
     * @returns {Promise<Object|null>} Next process info or null if queue is empty
     */
    async startNextProcess() {
        if (this._startingNext) return null;
        this._startingNext = true;
        try {
            return await this._startNextProcessInternal();
        } finally {
            this._startingNext = false;
        }
    }

    /**
     * Internal implementation of startNextProcess (protected by lock)
     * @returns {Promise<Object|null>} Next process info or null if queue is empty
     */
    async _startNextProcessInternal() {
        try {
            const activeProcesses = await getActiveProcesses();
            const recovery = getProcessRecovery();
            const occupiedGames = new Set(
                activeProcesses.map(process => resolveProcessGameType(process))
            );
            const queuedProcesses = await this.getQueuedProcesses();
            const startedProcesses = [];

            for (const queuedProcess of queuedProcesses) {
                if (occupiedGames.size >= this.supportedGames.length) {
                    break;
                }

                if (recovery.isAwaitingConfirmation(queuedProcess.id)) {
                    continue;
                }

                const gameType = resolveProcessGameType(queuedProcess);
                if (occupiedGames.has(gameType)) {
                    continue;
                }

                // A paused execution must finish saving progress before it can restart.
                if (getProcessExecutor().activeProcesses.has(queuedProcess.id)) {
                    occupiedGames.add(gameType);
                    continue;
                }

                await this.startProcess(queuedProcess);
                occupiedGames.add(gameType);
                startedProcesses.push(queuedProcess.id);
            }

            return startedProcesses;

        } catch (error) {
            console.error('Error starting next process:', error);
            systemLogQueries.addLog(
                'error',
                'Error starting next process',
                JSON.stringify({
                    error: error.message,
                    stack: error.stack,
                    function: 'startNextProcess'
                })
            );
            return null;
        }
    }

    /**
     * Completes a process and starts the next one in queue
     * @param {number} processId - Process ID to complete
     * @returns {Promise<null>} Always returns null
     */
    async completeProcess(processId) {
        try {
            // Get process data before marking as completed
            const processData = await getProcessById(processId);

            // Check if process still exists and is not already completed
            if (!processData || processData.status === PROCESS_STATUS.COMPLETED) {
                return null;
            }

            // Mark process as completed
            await updateProcessStatus(processId, PROCESS_STATUS.COMPLETED);

            // Start the next process in queue naturally
            // Preempted processes will be resumed when their turn comes
            await this.startNextProcess();

            // Always return null to prevent double execution
            return null;

        } catch (error) {
            console.error('Error completing process:', error);
            systemLogQueries.addLog(
                'error',
                'Error completing process',
                JSON.stringify({
                    processId,
                    error: error.message,
                    stack: error.stack,
                    function: 'completeProcess'
                })
            );
            return null;
        }
    }

    /**
     * Gets queue statistics
     * @returns {Promise<Object>} Queue statistics
     */
    async getQueueStats() {
        try {
            const queuedProcesses = await this.getQueuedProcesses();
            const activeProcesses = await getActiveProcesses();

            return {
                queued: queuedProcesses.length,
                active: activeProcesses.length,
                total: queuedProcesses.length + activeProcesses.length,
                queuedByGame: this.groupByGame(queuedProcesses),
                activeByGame: this.groupByGame(activeProcesses),
                queuedByPriority: this.groupByPriority(queuedProcesses),
                activeByPriority: this.groupByPriority(activeProcesses)
            };

        } catch (error) {
            systemLogQueries.addLog(
                'error',
                'Error getting queue stats',
                JSON.stringify({
                    error: error.message,
                    stack: error.stack,
                    function: 'getQueueStats'
                })
            );
            return {
                queued: 0,
                active: 0,
                total: 0,
                queuedByGame: {},
                activeByGame: {},
                queuedByPriority: {},
                activeByPriority: {}
            };
        }
    }

    /**
     * Groups processes by priority
     * @param {Array} processes - Array of processes
     * @returns {Object} Processes grouped by priority
     */
    groupByPriority(processes) {
        return processes.reduce((acc, process) => {
            const priority = process.priority;
            if (!acc[priority]) acc[priority] = 0;
            acc[priority]++;
            return acc;
        }, {});
    }

    groupByGame(processes) {
        return processes.reduce((acc, process) => {
            const gameType = resolveProcessGameType(process);
            if (!acc[gameType]) acc[gameType] = 0;
            acc[gameType]++;
            return acc;
        }, {});
    }

    /**
     * Gets all queued processes
     * @returns {Promise<Array>} Array of queued processes
     */
    async getQueuedProcesses() {
        try {
            return await getProcessesByStatus(PROCESS_STATUS.QUEUED);
        } catch (error) {
            systemLogQueries.addLog(
                'error',
                'Error getting queued processes',
                JSON.stringify({
                    error: error.message,
                    stack: error.stack,
                    function: 'getQueuedProcesses'
                })
            );
            return [];
        }
    }
}

// Create singleton instance
const queueManager = new QueueManager();

module.exports = {
    queueManager
};
