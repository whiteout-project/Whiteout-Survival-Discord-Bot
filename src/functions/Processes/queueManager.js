const {
    getProcessById,
    updateProcessStatus,
    setProcessPreemption,
    clearProcessPreemption,
    getNextQueuedProcess,
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

// Import auto-refresh manager (lazy loading)
let autoRefreshManager = null;
const getAutoRefreshManager = () => {
    if (!autoRefreshManager) {
        autoRefreshManager = require('../Alliance/refreshAlliance').autoRefreshManager;
    }
    return autoRefreshManager;
};

/**
 * SQLite-based priority queue management for process execution
 */
class QueueManager {
    constructor() {}

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

            // Check for active processes
            const activeProcesses = await getActiveProcesses();

            if (activeProcesses.length === 0) {
                // No active processes, start this one immediately
                await updateProcessStatus(process_id, PROCESS_STATUS.ACTIVE);

                // Execute the process
                const executor = getProcessExecutor();
                const processInfo = {
                    process_id,
                    status: 'active',
                    paused: null
                };

                // Execute process asynchronously (don't await to avoid blocking)
                executor.executeProcess(processInfo).catch(() => { });

                return {
                    process_id,
                    status: 'active',
                    paused: null,
                    message: 'Task started.',
                    messageType: 'success',
                    queue_position: 0
                };
            }

            // There are active processes, check priorities
            const highestPriorityActive = Math.min(...activeProcesses.map(p => p.priority));

            if (priority < highestPriorityActive) {
                // This process has higher priority, preempt the active ones
                const preemptedProcesses = [];
                const executor = getProcessExecutor();

                // Pause all active processes with lower priority
                for (const activeProcess of activeProcesses) {
                    if (activeProcess.priority > priority) {
                        await setProcessPreemption(activeProcess.id, process_id);
                        executor.activeProcesses.delete(activeProcess.id);
                        preemptedProcesses.push(activeProcess.id);
                    }
                }

                // Start this process
                await updateProcessStatus(process_id, PROCESS_STATUS.ACTIVE);

                // Execute the process
                const processInfo = {
                    process_id,
                    status: 'active',
                    paused: preemptedProcesses[0] || null
                };

                // Execute process asynchronously (don't await to avoid blocking)
                executor.executeProcess(processInfo).catch(() => { });

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
                    message: 'Task queued and will start when older tasks complete.',
                    messageType: 'info',
                    queue_position: await this.getQueuePosition(process_id)
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
    async getQueuePosition(processId) {
        try {
            const process = await getProcessById(processId);
            if (!process) return -1;

            // Count processes with higher priority or same priority but created earlier
            const queuedProcesses = await this.getQueuedProcesses();
            let position = 0;

            for (const queuedProcess of queuedProcesses) {
                if (queuedProcess.id === processId) break;
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
        try {
            // Check if there are any active processes
            const activeProcesses = await getActiveProcesses();
            if (activeProcesses.length > 0) {
                return null;
            }

            // Get next process from queue by priority
            const nextProcess = await getNextQueuedProcess();
            if (!nextProcess) {
                return null;
            }

            // Check if this process is awaiting crash recovery confirmation
            const recovery = getProcessRecovery();
            if (recovery.isAwaitingConfirmation(nextProcess.id)) {
                return null;
            }

            // Start the process
            await updateProcessStatus(nextProcess.id, PROCESS_STATUS.ACTIVE);

            // Clear stale preempted_by if this process was previously preempted
            if (nextProcess.preempted_by) {
                await clearProcessPreemption(nextProcess.id);
            }

            // Execute the process
            const executor = getProcessExecutor();
            const processInfo = {
                process_id: nextProcess.id,
                status: 'active',
                paused: null
            };

            // Execute process asynchronously (don't await to avoid blocking)
            executor.executeProcess(processInfo).catch(() => { });

            return null;

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

            // Check if this was an addplayer process - enable auto-refresh if needed
            if (processData && processData.action === 'addplayer') {
                const allianceId = parseInt(processData.target, 10); // Parse to integer for comparison
                try {
                    const refreshManager = getAutoRefreshManager();

                    // Check if there's already an auto-refresh for this alliance (queued or active)
                    const existingProcesses = await getProcessesByActionAndTarget('auto_refresh', processData.target);
                    const existingAutoRefresh = existingProcesses.length > 0;

                    if (!existingAutoRefresh && !refreshManager.scheduledRefreshes.has(allianceId)) {
                        // Schedule auto-refresh (only schedules, doesn't create process immediately)
                        await refreshManager.enableAutoRefreshAfterAddingPlayers(allianceId);
                    }
                } catch (autoRefreshError) {
                    systemLogQueries.addLog(
                        'error',
                        'Error enabling auto-refresh after adding players',
                        JSON.stringify({
                            allianceId,
                            error: autoRefreshError.message,
                            stack: autoRefreshError.stack,
                            function: 'completeProcess'
                        })
                    );
                }
            }

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
