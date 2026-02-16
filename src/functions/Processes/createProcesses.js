const { processQueries, systemLogQueries, allianceQueries } = require('../utility/database');

/**
 * Priority levels for different process types
 * Lower numbers = higher priority
 * 
 * Priority Calculation Formula:
 * - For redeem_giftcode: Base Priority (200000) + Alliance Priority (1-99999)
 * - For other actions: Flat priority (no alliance modifier)
 * 
 * Priority Range Explanation:
 * - 6-digit base priorities (100000, 200000, etc.) allow for up to 99,999 alliances
 * - Redeem priority: 200000 + alliance_priority = 200001 to 299999
 * - This ensures alliance priority 1 always executes before alliance priority 99999
 * 
 * Examples:
 * - Add Player: 100000 (flat, highest priority for API operations)
 * - Redeem (Alliance priority 1): 200000 + 1 = 200001 (starts first)
 * - Redeem (Alliance priority 50): 200000 + 50 = 200050
 * - Redeem (Alliance priority 99999): 200000 + 99999 = 299999
 * - Refresh: 300000 (flat, no alliance priority modifier)
 * - Auto-refresh: 400000 (flat, lowest priority)
 * 
 * Note: Notifications don't use processes - they're direct messages
 */
const PROCESS_PRIORITIES = {
    ADD_PLAYER: 100000,
    REDEEM_GIFTCODE: 200000,
    REFRESH: 300000,
    AUTO_REFRESH: 400000
};

/**
 * Process status constants
 * 
 * Status Flow:
 * - QUEUED: Waiting to start (initial state, or returned from preemption)
 * - ACTIVE: Currently executing (rate limiting is handled internally within process execution)
 * - COMPLETED: Successfully finished
 * - FAILED: Encountered unrecoverable error
 * 
 * Note: Rate limiting is handled within the process execution scripts with internal delays.
 */
const PROCESS_STATUS = {
    QUEUED: 'queued',
    ACTIVE: 'active',
    COMPLETED: 'completed',
    FAILED: 'failed'
};

/**
 * Creates a new process and stores it in the database
 * @param {Object} processData - Process data object
 * @param {string} processData.admin_id - ID of the admin who initiated the process
 * @param {string} processData.alliance_id - ID of the target alliance
 * @param {string} processData.player_ids - Raw string of player IDs
 * @param {string} processData.action - Type of action (addplayer, refresh, etc.)
 * @returns {Promise<Object>} Process creation result
 */
async function createProcess(processData) {
    try {
        const { admin_id, alliance_id, player_ids, action } = processData;

        // Check if all required fields are present
        if (!admin_id || alliance_id === undefined || alliance_id === null || !player_ids || !action) {
            throw new Error('Missing required fields for process creation');
        }

        // Ensure alliance_id is an integer (not float or string)
        // Note: 0 is allowed for system validation processes (no real alliance)
        const allianceIdInt = parseInt(alliance_id, 10);
        if (isNaN(allianceIdInt) || allianceIdInt < 0) {
            throw new Error(`Invalid alliance_id: ${alliance_id} (must be a non-negative integer)`);
        }

        // Get priority based on action type
        let basePriority;
        switch (action.toLowerCase()) {
            case 'addplayer':
                basePriority = PROCESS_PRIORITIES.ADD_PLAYER;
                break;
            case 'redeem_giftcode':
                basePriority = PROCESS_PRIORITIES.REDEEM_GIFTCODE;
                break;
            case 'refresh':
                basePriority = PROCESS_PRIORITIES.REFRESH;
                break;
            case 'autorefresh':
            case 'auto_refresh':
                basePriority = PROCESS_PRIORITIES.AUTO_REFRESH;
                break;
            default:
                basePriority = PROCESS_PRIORITIES.AUTO_REFRESH; // Default to lowest priority
        }

        // For redeem_giftcode action, add alliance priority to base priority
        // This ensures higher-priority alliances redeem codes first
        let priority = basePriority;
        if (action.toLowerCase() === 'redeem_giftcode') {
            try {
                const alliance = allianceQueries.getAllianceById(allianceIdInt);
                if (alliance && alliance.priority) {
                    priority = basePriority + alliance.priority;
                    // to-do: implement debug mode to turn on this log
                    // console.log(`Redeem process priority: ${basePriority} (base) + ${alliance.priority} (alliance) = ${priority}`);
                }
            } catch (allianceError) {
                // Could not get alliance priority, using base priority
            }
        }

        // Prepare progress tracking
        const playerIdArray = player_ids.split(',').map(id => id.trim()).filter(id => id);
        const progress = {
            pending: playerIdArray,
            done: [],
            failed: [],
            existing: []
        };

        // Add extra fields for auto-refresh processes
        if (action.toLowerCase() === 'auto_refresh') {
            progress.changed = [];
            progress.unchanged = [];
        }

        // Prepare data object with player_ids and any extra metadata
        const dataObject = { player_ids };

        // Include ID channel metadata if present
        if (processData.id_channel_message_id) {
            dataObject.id_channel_message_id = processData.id_channel_message_id;
        }
        if (processData.id_channel_channel_id) {
            dataObject.id_channel_channel_id = processData.id_channel_channel_id;
        }

        // Create process in database
        const result = processQueries.addProcess(
            action,
            allianceIdInt,  // Use integer version
            PROCESS_STATUS.QUEUED,
            priority,
            JSON.stringify(dataObject),
            JSON.stringify(progress),
            admin_id
        );

        const processId = result.lastInsertRowid;

        // Log process creation
        systemLogQueries.addLog(
            'process',
            `Process created: ${action} for alliance ${allianceIdInt}`,
            JSON.stringify({
                process_id: processId,
                action,
                alliance_id: allianceIdInt,
                priority,
                player_count: playerIdArray.length,
                created_by: admin_id,
                function: 'createProcess'
            })
        );

        return {
            process_id: processId,
            status: PROCESS_STATUS.QUEUED,
            priority,
            action
        };

    } catch (error) {
        systemLogQueries.addLog(
            'error',
            'Error creating process',
            JSON.stringify({
                processData,
                error: error.message,
                stack: error.stack,
                function: 'createProcess'
            })
        );
        throw error;
    }
}

/**
 * Gets process information by ID
 * @param {number} processId - Process ID to retrieve
 * @returns {Promise<Object|null>} Process data or null if not found
 */
async function getProcessById(processId) {
    try {
        const process = processQueries.getProcessById(processId);
        if (process) {
            // Parse JSON fields
            process.details = JSON.parse(process.details);
            process.progress = JSON.parse(process.progress);
        }
        return process;
    } catch (error) {
        systemLogQueries.addLog(
            'error',
            `Error getting process ${processId}`,
            JSON.stringify({
                processId,
                error: error.message,
                stack: error.stack,
                function: 'getProcessById'
            })
        );
        return null;
    }
}

/**
 * Updates process status
 * @param {number} processId - Process ID to update
 * @param {string} status - New status (queued, active, paused, completed, failed)
 * @returns {Promise<boolean>} Success status
 */
async function updateProcessStatus(processId, status) {
    try {
        if (status === PROCESS_STATUS.COMPLETED) {
            processQueries.completeProcess(processId);
        } else if (status === PROCESS_STATUS.FAILED) {
            processQueries.failProcess(processId);
        } else {
            processQueries.updateProcessStatus(processId, status);
        }

        return true;
    } catch (error) {
        systemLogQueries.addLog(
            'error',
            `Error updating process status for ${processId}`,
            JSON.stringify({
                processId,
                status,
                error: error.message,
                stack: error.stack,
                function: 'updateProcessStatus'
            })
        );
        return false;
    }
}

/**
 * Updates process progress
 * @param {number} processId - Process ID to update
 * @param {Object} progress - Progress object with pending, done, failed arrays
 * @returns {Promise<boolean>} Success status
 */
async function updateProcessProgress(processId, progress) {
    try {
        processQueries.updateProcessProgress(processId, JSON.stringify(progress));
        return true;
    } catch (error) {
        systemLogQueries.addLog(
            'error',
            `Error updating process progress for ${processId}`,
            JSON.stringify({
                processId,
                progress,
                error: error.message,
                stack: error.stack,
                function: 'updateProcessProgress'
            })
        );
        return false;
    }
}

/**
 * Deletes a process from the database
 * @param {number} processId - Process ID to delete
 * @returns {Promise<boolean>} Success status
 */
async function deleteProcess(processId) {
    try {
        processQueries.deleteProcess(processId);
        return true;
    } catch (error) {
        systemLogQueries.addLog(
            'error',
            `Error deleting process ${processId}`,
            JSON.stringify({
                processId,
                error: error.message,
                stack: error.stack,
                function: 'deleteProcess'
            })
        );
        return false;
    }
}

/**
 * Gets all processes by status
 * @param {string} status - Status to filter by
 * @returns {Promise<Array>} Array of processes
 */
async function getProcessesByStatus(status) {
    try {
        const processes = processQueries.getProcessesByStatus(status);
        return processes.map(process => {
            // Parse JSON fields
            process.details = JSON.parse(process.details);
            process.progress = JSON.parse(process.progress);
            return process;
        });
    } catch (error) {
        systemLogQueries.addLog(
            'error',
            `Error getting processes by status for ${status}`,
            JSON.stringify({
                status,
                error: error.message,
                stack: error.stack,
                function: 'getProcessesByStatus'
            })
        );
        return [];
    }
}

/**
 * Sets process resume timestamp for rate limit handling
 * @param {number} processId - Process ID to update
 * @param {number} resumeAfter - Timestamp when process should resume
 * @returns {Promise<boolean>} Success status
 */
async function setProcessResumeTime(processId, resumeAfter) {
    try {
        processQueries.setProcessResumeTime(processId, resumeAfter);
        return true;
    } catch (error) {
        systemLogQueries.addLog(
            'error',
            `Error setting process resume time for ${processId}`,
            JSON.stringify({
                processId,
                resumeAfter,
                error: error.message,
                stack: error.stack,
                function: 'setProcessResumeTime'
            })
        );
        return false;
    }
}

/**
 * Sets process preemption by a higher priority process
 * @param {number} processId - Process ID to preempt
 * @param {number} preemptedBy - ID of the preempting process
 * @returns {Promise<boolean>} Success status
 */
async function setProcessPreemption(processId, preemptedBy) {
    try {
        processQueries.setProcessPreemption(processId, preemptedBy);
        return true;
    } catch (error) {
        systemLogQueries.addLog(
            'error',
            `Error setting process preemption for ${processId}`,
            JSON.stringify({
                processId,
                preemptedBy,
                error: error.message,
                stack: error.stack,
                function: 'setProcessPreemption'
            })
        );
        return false;
    }
}

/**
 * Gets the next queued process by priority
 * @returns {Promise<Object|null>} Next process or null if queue is empty
 */
async function getNextQueuedProcess() {
    try {
        const process = processQueries.getNextQueuedProcess();
        if (process) {
            process.details = JSON.parse(process.details);
            process.progress = JSON.parse(process.progress);
        }
        return process;
    } catch (error) {
        systemLogQueries.addLog(
            'error',
            'Error getting next queued process',
            JSON.stringify({
                error: error.message,
                stack: error.stack,
                function: 'getNextQueuedProcess'
            })
        );
        return null;
    }
}

/**
 * Gets all active processes
 * @returns {Promise<Array>} Array of active processes
 */
async function getActiveProcesses() {
    try {
        const processes = processQueries.getActiveProcesses();
        return processes.map(process => {
            process.details = JSON.parse(process.details);
            process.progress = JSON.parse(process.progress);
            return process;
        });
    } catch (error) {
        systemLogQueries.addLog(
            'error',
            'Error getting active processes',
            JSON.stringify({
                error: error.message,
                stack: error.stack,
                function: 'getActiveProcesses'
            })
        );
        return [];
    }
}

/**
 * Gets paused processes ready to resume
 * @returns {Promise<Array>} Array of processes ready to resume
 */
async function getPausedProcessesReadyToResume() {
    try {
        const processes = processQueries.getPausedProcessesReadyToResume();
        return processes.map(process => {
            process.details = JSON.parse(process.details);
            process.progress = JSON.parse(process.progress);
            return process;
        });
    } catch (error) {
        systemLogQueries.addLog(
            'error',
            'Error getting paused processes ready to resume',
            JSON.stringify({
                error: error.message,
                stack: error.stack,
                function: 'getPausedProcessesReadyToResume'
            })
        );
        return [];
    }
}

/**
 * Checks if there are higher priority queued processes
 * @param {number} currentPriority - Current process priority
 * @returns {Promise<boolean>} True if higher priority processes exist
 */
async function hasHigherPriorityQueued(currentPriority) {
    try {
        return processQueries.hasHigherPriorityQueued(currentPriority);
    } catch (error) {
        return false;
    }
}

/**
 * Cleans up old completed/failed processes
 * @param {number} maxAgeMs - Maximum age in milliseconds
 * @returns {Promise<boolean>} Success status
 */
async function cleanupOldProcesses(maxAgeMs = 24 * 60 * 60 * 1000) { // Default 24 hours
    try {
        const cutoffDate = new Date(Date.now() - maxAgeMs).toISOString();
        const result = processQueries.cleanupOldProcesses(cutoffDate);

        systemLogQueries.addLog(
            'maintenance',
            `Cleaned up ${result.changes} old processes`,
            JSON.stringify({
                cutoffDate,
                deletedCount: result.changes,
                function: 'cleanupOldProcesses'
            })
        );

        return true;
    } catch (error) {
        systemLogQueries.addLog(
            'error',
            'Error cleaning up old processes',
            JSON.stringify({
                error: error.message,
                stack: error.stack,
                function: 'cleanupOldProcesses'
            })
        );
        return false;
    }
}

/**
 * Resets processes that were active during a crash back to queued status
 * @returns {Promise<number>} Number of processes reset
 */
async function resetCrashedProcesses() {
    try {
        const result = processQueries.resetCrashedProcesses();

        if (result.changes > 0) {
            systemLogQueries.addLog(
                'recovery',
                `Reset ${result.changes} crashed processes`,
                JSON.stringify({
                    resetCount: result.changes,
                    function: 'resetCrashedProcesses'
                })
            );
        }

        return result.changes;

    } catch (error) {
        systemLogQueries.addLog(
            'error',
            'Error resetting crashed processes',
            JSON.stringify({
                error: error.message,
                stack: error.stack,
                function: 'resetCrashedProcesses'
            })
        );
        return 0;
    }
}

module.exports = {
    createProcess,
    getProcessById,
    updateProcessStatus,
    updateProcessProgress,
    deleteProcess,
    getProcessesByStatus,
    setProcessResumeTime,
    setProcessPreemption,
    getNextQueuedProcess,
    getActiveProcesses,
    getPausedProcessesReadyToResume,
    hasHigherPriorityQueued,
    cleanupOldProcesses,
    resetCrashedProcesses,
    PROCESS_PRIORITIES,
    PROCESS_STATUS
};
