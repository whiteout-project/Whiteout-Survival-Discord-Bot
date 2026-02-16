const { getProcessById, updateProcessStatus, PROCESS_STATUS } = require('./createProcesses');
const { queueManager } = require('./queueManager');
const { systemLogQueries } = require('../utility/database');
const { executeAutoRefresh: executeAutoRefreshFunction } = require('../Alliance/refreshAlliance');
const { sendError } = require('../utility/commonFunctions');

/**
 * SQLite-based process execution controller with priority management
 */
class ProcessExecutor {
    constructor() {
        this.isExecuting = false;
        this.activeProcesses = new Map(); // Track actively executing processes
    }

    /**
     * Executes a process based on its action type
     * @param {Object} processInfo - Process information
     * @param {number} processInfo.process_id - Process ID
     * @param {string} processInfo.status - Process status
     * @param {number|null} processInfo.paused - Paused process ID if any
     * @returns {Promise<boolean>} Execution success status
     */
    async executeProcess(processInfo) {
        try {
            const { process_id, status, paused } = processInfo;

            // Check if process is active or already executing
            if (status !== 'active' || this.activeProcesses.has(process_id)) {
                return false;
            }

            // Get full process data from SQLite
            const processData = await getProcessById(process_id);
            if (!processData) {
                systemLogQueries.addLog(
                    'error',
                    `Process ${process_id} not found in database`,
                    JSON.stringify({ processInfo, function: 'executeProcess' })
                );
                return false;
            }

            // Confirm status is still active (might have been preempted)
            if (processData.status !== PROCESS_STATUS.ACTIVE) {
                return false;
            }

            // Mark as actively executing
            this.activeProcesses.set(process_id, {
                startTime: Date.now(),
                action: processData.action,
                priority: processData.priority
            });

            try {
                // Execute based on action type
                await this.executeByAction(processData);

                // Remove from active processes BEFORE completing (so queue manager can start next process)
                this.activeProcesses.delete(process_id);

                // Check if process was preempted during execution
                // If preempted, it's already in 'queued' status - DON'T complete it
                const currentStatus = await getProcessById(process_id);
                if (currentStatus && currentStatus.status === 'queued') {
                    return true; // Process was paused, not completed
                }

                // Only complete if process is still active
                if (currentStatus && currentStatus.status === 'active') {
                    // Complete process and start next (handled internally by queueManager)
                    await queueManager.completeProcess(process_id);
                } else {
                    // console.log(`Process ${process_id} status is ${currentStatus?.status}, not completing`);
                }

                return true;

            } catch (error) {
                // Handle different error types
                if (error.message === 'RATE_LIMIT' || error.message.includes('PAUSED_FOR_RATE_LIMIT')) {
                    return true; // Rate limit is expected, not a failure
                } else {
                    await this.failProcess(process_id, error);
                    return false;
                }
            } finally {
                // Safety cleanup (in case not already removed)
                this.activeProcesses.delete(process_id);
            }

        } catch (error) {
            await sendError(null, null, error, 'executeProcess function', false);

            // Clean up
            this.activeProcesses.delete(processInfo.process_id);

            try {
                await this.failProcess(processInfo.process_id, error);
            } catch (statusError) {
                // Error already logged in failProcess
            }

            return false;
        }
    }

    /**
     * Executes process based on its action type
     * @param {Object} processData - Full process data
     * @returns {Promise<void>}
     */
    async executeByAction(processData) {
        const { id: processId, action } = processData;

        switch (action) {
            case 'addplayer':
                await this.executeAddPlayer(processId);
                break;

            case 'refresh':
                await this.executeRefresh(processId);
                break;

            case 'redeem_giftcode':
                await this.executeRedeemGiftcode(processId);
                break;

            case 'auto_refresh':
                await this.executeAutoRefresh(processId);
                break;

            default:
                systemLogQueries.addLog(
                    'error',
                    `Unknown action type: ${action}`,
                    JSON.stringify({ processId, action, function: 'executeByAction' })
                );
                throw new Error(`Unknown action type: ${action}`);
        }
    }

    /**
     * Fails a process
     * @param {number} processId - Process ID
     * @param {Error} error - Error that caused failure
     * @returns {Promise<void>}
     */
    async failProcess(processId, error) {
        try {
            await updateProcessStatus(processId, PROCESS_STATUS.FAILED);

            systemLogQueries.addLog(
                'error',
                `Process ${processId} failed`,
                JSON.stringify({
                    processId,
                    error: error.message,
                    stack: error.stack,
                    function: 'failProcess'
                })
            );

            // Start next process after failure
            const nextProcess = await queueManager.startNextProcess();
            if (nextProcess) {
                setImmediate(() => {
                    this.executeProcess({
                        process_id: nextProcess.process_id,
                        status: 'active',
                        paused: null
                    }).catch(() => { });
                });
            }

        } catch (failError) {
            systemLogQueries.addLog(
                'error',
                'Error failing process',
                JSON.stringify({
                    processId,
                    originalError: error.message,
                    failError: failError.message,
                    function: 'failProcess'
                })
            );
        }
    }

    /**
     * Checks if a process should be preempted
     * @param {number} processId - Process ID to check
     * @returns {Promise<{shouldStop: boolean, reason?: string}>} Execution status
     */
    async checkForPreemption(processId) {
        try {
            const processData = await getProcessById(processId);
            if (!processData) {
                return { shouldStop: true, reason: 'PROCESS_NOT_FOUND' };
            }

            // Check if process was preempted
            if (processData.status === PROCESS_STATUS.PAUSED && processData.preempted_by) {
                return { shouldStop: true, reason: 'PREEMPTED' };
            }

            // Check if process status changed
            if (processData.status !== PROCESS_STATUS.ACTIVE) {
                return { shouldStop: true, reason: 'STATUS_CHANGED' };
            }

            return { shouldStop: false };

        } catch (error) {
            return { shouldStop: true, reason: 'ERROR' };
        }
    }

    /**
     * Executes add player process
     * @param {number} processId - Process ID
     * @returns {Promise<void>}
     */
    async executeAddPlayer(processId) {
        try {
            // Check for preemption before starting
            const preemptionCheck = await this.checkForPreemption(processId);
            if (preemptionCheck.shouldStop) {
                return; // Exit cleanly without error
            }

            const { processPlayerData } = require('../Players/fetchPlayerData');
            await processPlayerData(processId);

        } catch (error) {
            if (error.message === 'RATE_LIMIT' ||
                error.message.includes('PAUSED_FOR_RATE_LIMIT')) {
                throw error; // Re-throw expected errors
            }

            systemLogQueries.addLog(
                'error',
                `Error executing add player process ${processId}`,
                JSON.stringify({
                    processId,
                    error: error.message,
                    stack: error.stack,
                    function: 'executeAddPlayer'
                })
            );
            throw error;
        }
    }

    /**
     * Executes refresh process (manual refresh uses the same logic as auto-refresh)
     * @param {number} processId - Process ID
     * @returns {Promise<void>}
     */
    async executeRefresh(processId) {
        try {
            // Check for preemption before starting
            const preemptionCheck = await this.checkForPreemption(processId);
            if (preemptionCheck.shouldStop) {
                return; // Exit cleanly without error
            }

            // Execute the same refresh logic as auto-refresh
            await executeAutoRefreshFunction(processId);

        } catch (error) {
            if (error.message === 'RATE_LIMIT' ||
                error.message.includes('PAUSED_FOR_RATE_LIMIT')) {
                throw error; // Re-throw expected errors
            }

            systemLogQueries.addLog(
                'error',
                `Error executing refresh process ${processId}`,
                JSON.stringify({
                    processId,
                    error: error.message,
                    stack: error.stack,
                    function: 'executeRefresh'
                })
            );
            throw error;
        }
    }

    /**
     * Executes auto refresh process
     * @param {number} processId - Process ID
     * @returns {Promise<void>}
     */
    async executeAutoRefresh(processId) {
        try {
            // Check for preemption before starting
            const preemptionCheck = await this.checkForPreemption(processId);
            if (preemptionCheck.shouldStop) {
                return; // Exit cleanly without error
            }

            // Execute the auto-refresh function from refreshAlliance.js
            await executeAutoRefreshFunction(processId);

        } catch (error) {
            if (error.message === 'RATE_LIMIT' ||
                error.message.includes('PAUSED_FOR_RATE_LIMIT')) {
                throw error; // Re-throw expected errors
            }

            systemLogQueries.addLog(
                'error',
                `Error executing auto refresh process ${processId}`,
                JSON.stringify({
                    processId,
                    error: error.message,
                    stack: error.stack,
                    function: 'executeAutoRefresh'
                })
            );
            throw error;
        }
    }

    /**
     * Executes redeem giftcode process
     * @param {number} processId - Process ID
     * @returns {Promise<void>}
     */
    async executeRedeemGiftcode(processId) {
        const { executeRedeemOperation } = require('../GiftCode/redeemFunction');
        try {
            // Check for preemption before starting
            const preemptionCheck = await this.checkForPreemption(processId);
            if (preemptionCheck.shouldStop) {
                return; // Exit cleanly without error
            }

            // Execute the redeem operation
            const result = await executeRedeemOperation(processId);

            // Check if the operation was preempted
            if (result.preempted) {
                return; // Exit cleanly without error
            }

        } catch (error) {
            if (error.message === 'RATE_LIMIT' ||
                error.message.includes('PAUSED_FOR_RATE_LIMIT')) {
                throw error; // Re-throw expected errors
            }

            systemLogQueries.addLog(
                'error',
                `Error executing redeem giftcode process ${processId}`,
                JSON.stringify({
                    processId,
                    error: error.message,
                    stack: error.stack,
                    function: 'executeRedeemGiftcode'
                })
            );
            throw error;
        }
    }

    /**
     * Gets statistics about actively executing processes
     * @returns {Object} Execution statistics
     */
    getExecutionStats() {
        const stats = {
            activeExecutions: this.activeProcesses.size,
            processes: []
        };

        for (const [processId, info] of this.activeProcesses) {
            stats.processes.push({
                processId,
                action: info.action,
                priority: info.priority,
                duration: Date.now() - info.startTime
            });
        }

        return stats;
    }
}

// Create singleton instance
const processExecutor = new ProcessExecutor();

module.exports = {
    processExecutor
};
