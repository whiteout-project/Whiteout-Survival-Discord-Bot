const { processExecutor } = require('./executeProcesses');
const { queueManager } = require('./queueManager');
const {
    getProcessesByStatus,
    updateProcessStatus,
    getProcessById,
    resetCrashedProcesses,
    PROCESS_STATUS
} = require('./createProcesses');
const { ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder } = require('discord.js');
const { adminQueries, allianceQueries, systemLogQueries } = require('../utility/database');
const { sendError, getAdminLang } = require('../utility/commonFunctions');

/**
 * SQLite-based process recovery system for handling bot restarts and crashes
 */
class ProcessRecovery {
    constructor() {
        this.recoveryInProgress = false;
        this.client = null;
        this.processesAwaitingConfirmation = new Set(); // Track processes waiting for admin confirmation
        this.autoResumeTimeouts = new Map(); // Track timeout IDs for auto-resume (processId -> timeoutId)
    }

    /**
     * Sends resume confirmation message to admin
     * @param {Object} processData - Process data
     * @param {Object} progress - Progress data
     * @returns {Promise<void>}
     */
    async sendResumeConfirmation(processData, progress) {
        try {
            const { id: process_id, created_by: admin_id } = processData;
            const { lang } = getAdminLang(admin_id);

            // Create confirmation buttons
            const resumeButton = new ButtonBuilder()
                .setCustomId(`resume_crash_${process_id}`)
                .setLabel(lang.processes.buttons.resumeProcess)
                .setStyle(ButtonStyle.Success)
                .setEmoji('✅');

            const cancelButton = new ButtonBuilder()
                .setCustomId(`cancel_crash_${process_id}`)
                .setLabel(lang.processes.buttons.cancelProcess)
                .setStyle(ButtonStyle.Danger)
                .setEmoji('❌');

            const row = new ActionRowBuilder().addComponents(resumeButton, cancelButton);

            // Create status embed
            const embed = new EmbedBuilder()
                .setTitle(lang.processes.content.title.processRecovery)
                .setDescription(lang.processes.content.description.processRecovery)
                .setColor(0xFFA500) // Orange
                .addFields([
                    {
                        name: lang.processes.content.processStatusField.name,
                        value: lang.processes.content.processStatusField.value
                            .replace('{processId}', process_id)
                            .replace('{action}', processData.action)
                            .replace('{priority}', processData.priority)
                            .replace('{createdBy}', admin_id),
                    },
                    {
                        name: lang.processes.content.autoResumeField.name,
                        value: lang.processes.content.autoResumeField.value,

                    }
                ])
                .setTimestamp();

            try {
                // Try to send DM to admin first
                const admin = await this.client.users.fetch(admin_id);
                await admin.send({ embeds: [embed], components: [row] });
                return;
            } catch (dmError) {
                // Log the notification attempt
                systemLogQueries.addLog(
                    'warning',
                    `Process ${process_id} needs manual intervention`,
                    JSON.stringify({
                        processId: process_id,
                        adminId: admin_id,
                        action: processData.action,
                        dmFailed: true,
                        function: 'sendResumeConfirmation'
                    })
                );
            }

        } catch (error) {
            await sendError(null, null, error, 'sendResumeConfirmation function', false);
        }
    }

    /**
     * Initializes the recovery system on bot startup
     * @param {import('discord.js').Client} client - Discord client instance
     * @returns {Promise<void>}
     */
    async initialize(client) {
        try {
            this.client = client; // Store client reference

            // Get statistics before recovery
            const beforeStats = await queueManager.getQueueStats();

            // Start recovery process
            await this.recoverProcesses();

            // Get statistics after recovery
            const afterStats = await queueManager.getQueueStats();

            // Log recovery completion
            systemLogQueries.addLog(
                'recovery',
                'Process recovery system initialized',
                JSON.stringify({
                    beforeStats,
                    afterStats,
                    function: 'initialize'
                })
            );

        } catch (error) {
            await sendError(null, null, error, 'initialize function', false);
            // Try to initialize again in 30 seconds
            setTimeout(() => this.initialize(client), 30000);
        }
    }

    /**
     * Recovers processes from database on startup
     * @returns {Promise<void>}
     */
    async recoverProcesses() {
        if (this.recoveryInProgress) {
            return;
        }

        this.recoveryInProgress = true;

        try {

            // First, get all processes that were active before reset
            const crashedActiveProcesses = await getProcessesByStatus(PROCESS_STATUS.ACTIVE);

            // Reset any processes that were active during crash to queued
            await resetCrashedProcesses();

            // Handle crashed active processes - these need admin confirmation (except auto_refresh)
            let processesNeedingConfirmation = 0;
            for (const process of crashedActiveProcesses) {
                const needsConfirmation = await this.handleCrashedProcess(process);
                if (needsConfirmation) {
                    processesNeedingConfirmation++;
                }
            }

            // Get all processes by status after reset
            const activeProcesses = await getProcessesByStatus(PROCESS_STATUS.ACTIVE);
            const pausedProcesses = await getProcessesByStatus(PROCESS_STATUS.PAUSED);


            // Handle any remaining active processes (shouldn't be any after reset)
            for (const process of activeProcesses) {
                await this.recoverActiveProcess(process);
            }

            // Handle paused processes
            for (const process of pausedProcesses) {
                await this.recoverPausedProcess(process);
            }

        } catch (error) {
            await sendError(null, null, error, 'recoverProcesses function', false);
        } finally {
            this.recoveryInProgress = false;
        }
    }

    /**
     * Handles a process that was active during crash
     * @param {Object} process - Process data
     * @returns {Promise<boolean>} True if admin confirmation was sent, false otherwise
     */
    async handleCrashedProcess(process) {
        try {
            // Special handling for auto-refresh processes (no confirmation needed)
            if (process.action === 'auto_refresh') {
                await this.handleCrashedAutoRefresh(process);
                return false; // No confirmation needed
            }

            // Check if process has pending work
            const progress = process.progress || {};
            const hasPendingWork = progress.pending && progress.pending.length > 0;
            const totalProcessed = (progress.done || []).length +
                (progress.failed || []).length +
                (progress.existing || []).length;
            const totalPlayers = totalProcessed + (progress.pending || []).length;

            if (hasPendingWork || totalPlayers === 0) {
                // Send confirmation to admin with 5-minute timeout
                await this.sendCrashRecoveryConfirmation(process, progress);
                return true; // Confirmation sent
            } else if (totalProcessed === totalPlayers && totalPlayers > 0) {
                // All players were processed, mark as completed
                await updateProcessStatus(process.id, PROCESS_STATUS.COMPLETED);
                return false; // No confirmation needed
            } else {
                // Process data is inconsistent, needs admin decision
                await this.sendCrashRecoveryConfirmation(process, progress);
                return true; // Confirmation sent
            }

        } catch (error) {
            await sendError(null, null, error, 'handleCrashedProcess function', false);
        } finally {
            return false; // Error, no confirmation sent
        }
    }

    /**
     * Handles crashed auto-refresh processes with special logic
     * @param {Object} process - Auto-refresh process data
     * @returns {Promise<void>}
     */
    async handleCrashedAutoRefresh(process) {
        try {
            // Check how long the process has been inactive
            const now = Date.now();
            const processStarted = new Date(process.created_at).getTime();
            const inactiveTime = now - processStarted;
            const oneDayMs = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

            if (inactiveTime > oneDayMs) {
                // Process has been inactive for more than 24 hours, mark as completed
                await updateProcessStatus(process.id, PROCESS_STATUS.COMPLETED);

                // Get the alliance and reschedule the refresh
                const alliance = allianceQueries.getAllianceById(process.target);
                if (alliance && alliance.interval > 0) {
                    const { autoRefreshManager } = require('../Alliance/refreshAlliance');
                    autoRefreshManager.scheduleNextRefresh(alliance);
                }

                systemLogQueries.addLog(
                    'recovery',
                    `Auto-refresh process ${process.id} expired after 24h, marked as completed and rescheduled`,
                    JSON.stringify({
                        processId: process.id,
                        inactiveHours: Math.round(inactiveTime / (60 * 60 * 1000)),
                        action: 'expired_and_rescheduled',
                        function: 'handleCrashedAutoRefresh'
                    })
                );
            } else {
                // Process is recent, check if it has pending work or was mostly done
                const progress = process.progress || {};
                const pending = progress.pending || [];
                const done = progress.done || [];
                const totalPlayers = pending.length + done.length;

                if (pending.length === 0 || (done.length / totalPlayers > 0.9)) {
                    // Process was nearly complete or fully complete, just mark as done and reschedule
                    await updateProcessStatus(process.id, PROCESS_STATUS.COMPLETED);

                    // Get the alliance and reschedule the refresh
                    const alliance = allianceQueries.getAllianceById(process.target);
                    if (alliance && alliance.interval > 0) {
                        const { autoRefreshManager } = require('../Alliance/refreshAlliance');
                        await autoRefreshManager.scheduleNextRefresh(alliance);
                    }
                } else {
                    // Process has significant pending work, resume it
                    await updateProcessStatus(process.id, PROCESS_STATUS.QUEUED);
                }

                systemLogQueries.addLog(
                    'recovery',
                    `Auto-refresh process ${process.id} handled after crash`,
                    JSON.stringify({
                        processId: process.id,
                        inactiveMinutes: Math.round(inactiveTime / (60 * 1000)),
                        pending: pending.length,
                        done: done.length,
                        action: pending.length === 0 || (done.length / totalPlayers > 0.9) ? 'completed_and_rescheduled' : 'queued',
                        function: 'handleCrashedAutoRefresh'
                    })
                );
            }

        } catch (error) {
            await sendError(null, null, error, 'handleCrashedAutoRefresh function', false);

            // On error, mark as completed to prevent blocking
            try {
                await updateProcessStatus(process.id, PROCESS_STATUS.COMPLETED);
            } catch (completionError) {
                // Error already logged
            }
        }
    }

    /**
     * Sends crash recovery confirmation message to admin with timeout
     * @param {Object} processData - Process data
     * @param {Object} progress - Progress data
     * @returns {Promise<void>}
     */
    async sendCrashRecoveryConfirmation(processData, progress) {
        const { id: process_id, created_by: admin_id } = processData;
        const { lang } = getAdminLang(admin_id);
        try {

            // Mark process as awaiting confirmation
            this.processesAwaitingConfirmation.add(process_id);

            // Create confirmation buttons
            const resumeButton = new ButtonBuilder()
                .setCustomId(`resume_crash_${process_id}`)
                .setLabel(lang.processes.buttons.resumeProcess)
                .setStyle(ButtonStyle.Success)
                .setEmoji('✅');

            const cancelButton = new ButtonBuilder()
                .setCustomId(`cancel_crash_${process_id}`)
                .setLabel(lang.processes.buttons.cancelProcess)
                .setStyle(ButtonStyle.Danger)
                .setEmoji('❌');

            const row = new ActionRowBuilder().addComponents(resumeButton, cancelButton);

            // Create status embed
            const embed = new EmbedBuilder()
                .setTitle(lang.processes.content.title.processRecovery)
                .setDescription(lang.processes.content.description.processRecovery)
                .setColor(0xFFA500) // Orange
                .addFields([
                    {
                        name: lang.processes.content.processStatusField.name,
                        value: lang.processes.content.processStatusField.value
                            .replace('{processId}', process_id)
                            .replace('{action}', processData.action)
                            .replace('{priority}', processData.priority)
                            .replace('{createdBy}', admin_id),
                    },
                    {
                        name: lang.processes.content.autoResumeField.name,
                        value: lang.processes.content.autoResumeField.value,

                    }
                ])
                .setTimestamp();

            // Check if this is a system-created process (API, auto-redeem, etc.)
            const isSystemProcess = admin_id.startsWith('SYSTEM_') ||
                admin_id.startsWith('API_') ||
                admin_id === 'system';

            if (isSystemProcess) {
                // Send to owner and full access admins instead
                const allAdmins = adminQueries.getAllAdmins();
                const { PERMISSIONS } = require('../Settings/admin/permissions');

                // Filter for owner admins or full access admins
                const notifyAdmins = allAdmins.filter(admin =>
                    admin.is_owner === 1 || (admin.permissions & PERMISSIONS.FULL_ACCESS)
                );

                if (notifyAdmins.length === 0) {
                    systemLogQueries.addLog(
                        'crash_recovery',
                        `System process ${process_id} crashed, no admins to notify`,
                        JSON.stringify({
                            processId: process_id,
                            createdBy: admin_id,
                            action: processData.action,
                            noAdminsFound: true,
                            autoResumeScheduled: true,
                            function: 'sendCrashRecoveryConfirmation'
                        })
                    );

                    // Set up auto-resume since there's no one to notify
                    this.setupAutoResumeTimeout(process_id, admin_id, null);
                    return;
                }

                let notificationsSent = 0;

                for (const admin of notifyAdmins) {
                    try {
                        const user = await this.client.users.fetch(admin.user_id);
                        const dmMessage = await user.send({ embeds: [embed], components: [row] });
                        notificationsSent++;

                        // Only set up auto-resume once for the first successful notification
                        if (notificationsSent === 1) {
                            this.setupAutoResumeTimeout(process_id, admin_id, dmMessage);
                        }
                    } catch (dmError) {
                        // DM failed, continue to next admin
                    }
                }

                if (notificationsSent === 0) {
                    systemLogQueries.addLog(
                        'crash_recovery',
                        `System process ${process_id} crashed, all admin notifications failed`,
                        JSON.stringify({
                            processId: process_id,
                            createdBy: admin_id,
                            action: processData.action,
                            attemptedAdmins: notifyAdmins.length,
                            allFailed: true,
                            autoResumeScheduled: true,
                            function: 'sendCrashRecoveryConfirmation'
                        })
                    );

                    // Set up auto-resume since we couldn't reach anyone
                    this.setupAutoResumeTimeout(process_id, admin_id, null);
                }

                return;
            }

            // Regular user process - send to the original admin
            try {
                // Try to send DM to admin first
                const admin = await this.client.users.fetch(admin_id);
                const dmMessage = await admin.send({ embeds: [embed], components: [row] });

                // Set up 5-minute timeout for auto-resume
                this.setupAutoResumeTimeout(process_id, admin_id, dmMessage);

                return;
            } catch (dmError) {
                await sendError(null, null, dmError, 'sendCrashRecoveryConfirmation DM attempt', false);

                // Set up auto-resume since we can't reach the admin
                this.setupAutoResumeTimeout(process_id, admin_id, null);
            }

        } catch (error) {
            await sendError(null, null, error, 'sendCrashRecoveryConfirmation function', false);
        }
    }

    /**
     * Sets up auto-resume timeout for crashed processes
     * @param {number} processId - Process ID
     * @param {string} adminId - Admin user ID
     * @param {Message|null} dmMessage - DM message to update (if exists)
     * @returns {void}
     */
    setupAutoResumeTimeout(processId, adminId, dmMessage) {
        const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
        const { lang } = getAdminLang(adminId);

        const timeoutId = setTimeout(async () => {
            try {
                // Remove timeout from tracking map
                this.autoResumeTimeouts.delete(processId);

                // Check if process still exists and is in queued status
                const processData = await getProcessById(processId);
                if (!processData || processData.status !== PROCESS_STATUS.QUEUED) {
                    return;
                }

                // Check if still awaiting confirmation (shouldn't be if timeout reached naturally)
                if (!this.processesAwaitingConfirmation.has(processId)) {
                    return;
                }

                // Remove from awaiting confirmation set
                this.processesAwaitingConfirmation.delete(processId);

                // Use queue manager's manageQueue to properly handle priority and preemption
                // This ensures that if the resumed process has higher priority than active processes,
                // it will preempt them instead of just waiting in queue
                await queueManager.manageQueue({
                    process_id: processId,
                    status: PROCESS_STATUS.QUEUED,
                    priority: processData.priority,
                    action: processData.action
                });

                // Update DM message if it exists
                if (dmMessage) {
                    try {
                        const updatedEmbed = new EmbedBuilder()
                            .setTitle(lang.processes.content.title.autoResume)
                            .setDescription(lang.processes.content.description.autoResume.replace('{processId}', processId))
                            .setColor(0x00FF00)
                            .setTimestamp();

                        await dmMessage.edit({ embeds: [updatedEmbed], components: [] });
                    } catch (updateError) {
                        // Error updating DM, not critical
                    }
                }

                // Log the auto-resume
                systemLogQueries.addLog(
                    'auto_resume',
                    `Process ${processId} auto-resumed after timeout`,
                    JSON.stringify({
                        processId,
                        adminId,
                        timeoutMs: TIMEOUT_MS,
                        function: 'setupAutoResumeTimeout'
                    })
                );

            } catch (error) {
                await sendError(null, null, error, 'auto-resume timeout function', false);
            }
        }, TIMEOUT_MS);

        // Store the timeout ID so we can cancel it later
        this.autoResumeTimeouts.set(processId, timeoutId);
    }

    /**
     * Recovers an active process (should not happen after crash reset)
     * @param {Object} process - Process data
     * @returns {Promise<void>}
     */
    async recoverActiveProcess(process) {
        try {
            // Check if process has pending work
            const progress = process.progress || {};
            const hasPendingWork = progress.pending && progress.pending.length > 0;
            const totalProcessed = (progress.done || []).length +
                (progress.failed || []).length +
                (progress.existing || []).length;
            const totalPlayers = totalProcessed + (progress.pending || []).length;

            if (hasPendingWork) {
                // Send confirmation to admin for manual intervention
                await this.sendResumeConfirmation(process, progress);

                // Move to paused status to await manual intervention
                await updateProcessStatus(process.id, PROCESS_STATUS.PAUSED);
            } else if (totalProcessed === totalPlayers && totalPlayers > 0) {
                // All players were processed, mark as completed
                await updateProcessStatus(process.id, PROCESS_STATUS.COMPLETED);
            } else {
                // Process data is inconsistent, reset to queued
                await updateProcessStatus(process.id, PROCESS_STATUS.QUEUED);
            }

        } catch (error) {
            await sendError(null, null, error, 'recoverActiveProcess function', false);
        }
    }

    /**
     * Recovers a paused process
     * @param {Object} process - Process data
     * @returns {Promise<void>}
     */
    async recoverPausedProcess(process) {
        try {
            const resumeAfter = process.resume_after ? parseInt(process.resume_after) : null;
            const currentTime = Date.now();

            // Check if process was preempted
            if (process.preempted_by) {
                const preemptingProcess = await getProcessById(process.preempted_by);

                if (preemptingProcess &&
                    ![PROCESS_STATUS.COMPLETED, PROCESS_STATUS.FAILED].includes(preemptingProcess.status)) {
                    return; // Still preempted, leave as-is
                }
            }

            // Check if process is ready to resume based on time
            if (resumeAfter && currentTime < resumeAfter) {
                const remainingTime = resumeAfter - currentTime;

                // Set up timer to check again later
                setTimeout(async () => {
                    try {
                        await this.recoverPausedProcess(process);
                    } catch (error) {
                        // Error in delayed recovery
                    }
                }, remainingTime);

                return;
            }

        } catch (error) {
            await sendError(null, null, error, 'recoverPausedProcess function', false);
        }
    }

    /**
     * Manually triggers process recovery (for admin commands)
     * @returns {Promise<Object>} Recovery statistics
     */
    async triggerManualRecovery() {
        try {
            const beforeStats = await queueManager.getQueueStats();

            await this.recoverProcesses();

            const afterStats = await queueManager.getQueueStats();

            systemLogQueries.addLog(
                'manual_recovery',
                'Manual process recovery triggered',
                JSON.stringify({
                    beforeStats,
                    afterStats,
                    function: 'triggerManualRecovery'
                })
            );

            return {
                before: beforeStats,
                after: afterStats,
                recovered: true
            };

        } catch (error) {
            systemLogQueries.addLog(
                'error',
                'Error in manual recovery',
                JSON.stringify({
                    error: error.message,
                    stack: error.stack,
                    function: 'triggerManualRecovery'
                })
            );
            return {
                before: null,
                after: null,
                recovered: false,
                error: error.message
            };
        }
    }

    /**
     * Gets recovery system status
     * @returns {Promise<Object>} Recovery system status
     */
    async getRecoveryStatus() {
        try {
            const queueStats = await queueManager.getQueueStats();
            const executionStats = processExecutor.getExecutionStats();

            return {
                recoveryInProgress: this.recoveryInProgress,
                databaseConnected: true, // SQLite is always connected if the app is running
                queueStats,
                executionStats,
                lastRecovery: new Date().toISOString(),
                systemType: 'SQLite'
            };

        } catch (error) {
            await sendError(null, null, error, 'getRecoveryStatus function', false);
            return {
                recoveryInProgress: this.recoveryInProgress,
                databaseConnected: false,
                queueStats: null,
                executionStats: null,
                error: error.message,
                systemType: 'SQLite'
            };
        }
    }

    /**
     * Handles process resume button click (both regular and crash recovery)
     * @param {import('discord.js').ButtonInteraction} interaction 
     */
    async handleProcessResume(interaction) {
        const { lang, adminData } = getAdminLang(interaction.user.id);
        try {
            const customId = interaction.customId;
            let processId;
            let isCrashRecovery = false;

            if (customId.startsWith('resume_crash_')) {
                processId = parseInt(customId.split('_')[2]);
                isCrashRecovery = true;
            } else if (customId.startsWith('resume_process_')) {
                processId = parseInt(customId.split('_')[2]);
            } else {
                return await interaction.reply({
                    content: lang.processes.errors.invalidButton,
                    ephemeral: true
                });
            }

            if (!processId) {
                return await interaction.reply({
                    content: lang.processes.errors.invalidProcessId,
                    ephemeral: true
                });
            }

            // Get process data from database
            const processData = await getProcessById(processId);

            if (!processData) {
                return await interaction.reply({
                    content: lang.processes.errors.processNotFound,
                    ephemeral: true
                });
            }

            // Verify admin permissions
            if (!adminData || (interaction.user.id !== processData.created_by && !adminData.is_owner)) {
                return await interaction.reply({
                    content: lang.processes.errors.noPermission,
                    ephemeral: true
                });
            }

            // Get the message to update
            const message = interaction.message;

            // Acknowledge the interaction first
            await interaction.deferUpdate();

            // Update the message to show resuming status
            await message.edit({
                content: lang.processes.content.resumingProcess,
                components: []
            });

            // Remove from awaiting confirmation set and cancel timeout if it was there
            if (isCrashRecovery) {
                this.clearConfirmationStatus(processId);
            }

            // Reset process status back to queued
            await updateProcessStatus(processId, PROCESS_STATUS.QUEUED);

            // Use queue manager's manageQueue to properly handle priority and preemption
            // This ensures that if the resumed process has higher priority than active processes,
            // it will preempt them instead of just waiting in queue
            await queueManager.manageQueue({
                process_id: processId,
                status: PROCESS_STATUS.QUEUED,
                priority: processData.priority,
                action: processData.action
            });

            // Update the message with success status
            await message.edit({
                content: lang.processes.content.resumedProcess,
                components: []
            });

            // Log the manual resume
            systemLogQueries.addLog(
                isCrashRecovery ? 'crash_manual_resume' : 'manual_resume',
                `Process ${processId} manually resumed by user`,
                JSON.stringify({
                    processId,
                    resumedBy: interaction.user.id,
                    processAction: processData.action,
                    isCrashRecovery,
                    function: 'handleProcessResume'
                })
            );

        } catch (error) {
            await sendError(interaction, lang, error, 'handleProcessResume function');
        }
    }

    /**
     * Handles process cancel button click (both regular and crash recovery)
     * @param {import('discord.js').ButtonInteraction} interaction 
     */
    async handleProcessCancel(interaction) {
        const { lang, adminData } = getAdminLang(interaction.user.id);
        try {
            const customId = interaction.customId;
            let processId;
            let isCrashRecovery = false;

            if (customId.startsWith('cancel_crash_')) {
                processId = parseInt(customId.split('_')[2]);
                isCrashRecovery = true;
            } else if (customId.startsWith('cancel_process_')) {
                processId = parseInt(customId.split('_')[2]);
            } else {
                return await interaction.reply({
                    content: lang.processes.errors.invalidButtonId,
                    ephemeral: true
                });
            }

            if (!processId) {
                return await interaction.reply({
                    content: lang.processes.errors.invalidProcessId,
                    ephemeral: true
                });
            }

            // Get process data from database
            const processData = await getProcessById(processId);

            if (!processData) {
                return await interaction.reply({
                    content: lang.processes.errors.processNotFound,
                    ephemeral: true
                });
            }

            // Verify admin permissions
            if (!adminData || (interaction.user.id !== processData.created_by && !adminData.is_owner)) {
                return await interaction.reply({
                    content: lang.processes.errors.noPermission,
                    ephemeral: true
                });
            }

            // Get the message to update
            const message = interaction.message;

            // Acknowledge the interaction first
            await interaction.deferUpdate();

            // Update the message to show cancelling status
            await message.edit({
                content: lang.processes.content.cancellingProcess,
                components: [] // Remove buttons
            });

            // Remove from awaiting confirmation set and cancel timeout if it was there
            if (isCrashRecovery) {
                this.clearConfirmationStatus(processId);
            }

            // Mark process as failed
            await updateProcessStatus(processId, PROCESS_STATUS.FAILED);

            // Update the message with final status
            await message.edit({
                content: lang.processes.content.canceledProcess,
                components: []
            });

            // Log the cancellation
            systemLogQueries.addLog(
                isCrashRecovery ? 'crash_manual_cancel' : 'manual_cancel',
                `Process ${processId} cancelled by user`,
                JSON.stringify({
                    processId,
                    cancelledBy: interaction.user.id,
                    processAction: processData.action,
                    isCrashRecovery,
                    function: 'handleProcessCancel'
                })
            );

        } catch (error) {
            await sendError(interaction, lang, error, 'handleProcessCancel function');
        }
    }

    /**
     * Check if a process is awaiting crash recovery confirmation
     * @param {number} processId - Process ID to check
     * @returns {boolean} True if process is awaiting confirmation
     */
    isAwaitingConfirmation(processId) {
        return this.processesAwaitingConfirmation.has(processId);
    }

    /**
     * Mark process as no longer awaiting confirmation and cancel auto-resume timeout
     * @param {number} processId - Process ID
     */
    clearConfirmationStatus(processId) {
        this.processesAwaitingConfirmation.delete(processId);

        // Cancel the auto-resume timeout if it exists
        const timeoutId = this.autoResumeTimeouts.get(processId);
        if (timeoutId) {
            clearTimeout(timeoutId);
            this.autoResumeTimeouts.delete(processId);
        }
    }
}

// Create singleton instance
const processRecovery = new ProcessRecovery();

module.exports = {
    processRecovery
};
