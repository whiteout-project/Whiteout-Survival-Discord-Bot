const { EmbedBuilder } = require('discord.js');
const { notificationQueries, systemLogQueries } = require('../utility/database');
const { handleError } = require('../utility/commonFunctions');

/**
 * Parse existing mentions from notification
 * @param {string} mentionJson - JSON string of mentions
 * @returns {object} Parsed mention object
 */
function parseMentions(mentionJson) {
    try {
        return mentionJson ? JSON.parse(mentionJson) : {};
    } catch (error) {
        console.error('Error parsing mentions:', error);
        return {};
    }
}

/**
 * Convert raw @tag placeholders to their configured Discord mention format
 * @param {string} text - The text containing @tag placeholders
 * @param {object} mentions - Parsed mention object from notification.mention
 * @param {string} component - Component type ('message', 'description', or field identifier like 'field_0')
 * @returns {string} Text with configured tags converted to Discord mention format
 */
function convertTagsToMentions(text, mentions, component) {
    if (!text || !mentions || !mentions[component]) return text;

    let result = text;
    const componentMentions = mentions[component];

    // Replace each configured tag with its Discord mention format
    Object.entries(componentMentions).forEach(([tag, value]) => {
        const [type, id] = value.split(':');
        let mentionString = '';

        if (type === 'everyone') {
            mentionString = '@everyone';
        } else if (type === 'here') {
            mentionString = '@here';
        } else if (type === 'user') {
            mentionString = `<@${id}>`;
        } else if (type === 'role') {
            mentionString = `<@&${id}>`;
        }

        // Replace all occurrences of @tag with the mention string using word boundary
        const tagRegex = new RegExp(`@${tag}\\b`, 'g');
        result = result.replace(tagRegex, mentionString);
    });

    return result;
}

class NotificationScheduler {
    constructor() {
        this.client = null;
        this.scheduledNotifications = new Map(); // Track scheduled timeouts per notification (stores timeout IDs)
        this.scheduleGenerations = new Map(); // Track generation ID per notification (to cancel in-flight preparations)
    }

    /**
     * Initialize the notification scheduler with Discord client
     * @param {import('discord.js').Client} client - The Discord client
     */
    async initialize(client) {
        if (!client) {
            throw new Error('Discord client is required for notification scheduler');
        }

        // Always update client reference (important for hot reloads)
        this.client = client;

        // Clear existing scheduled notifications before re-scheduling (arrays or single IDs)
        for (const [, timeouts] of this.scheduledNotifications) {
            if (Array.isArray(timeouts)) {
                timeouts.forEach(id => clearTimeout(id));
            } else {
                clearTimeout(timeouts);
            }
        }
        this.scheduledNotifications.clear();

        try {
            // Get all active notifications
            const activeNotifications = notificationQueries.getActiveNotifications();

            if (!activeNotifications || activeNotifications.length === 0) {
                // console.log('ℹ️ No active notifications found');
            } else {

                const currentTime = Math.floor(Date.now() / 1000);

                // Process each active notification
                for (const notification of activeNotifications) {
                    // Check if next_trigger is in the past
                    if (notification.next_trigger && notification.next_trigger < currentTime) {

                        // If no repeat, deactivate the notification
                        if (!notification.repeat_status || notification.repeat_status === 0) {
                            notificationQueries.updateNotificationActiveStatus(notification.id, false);

                            systemLogQueries.addLog(
                                'info',
                                `Deactivated past one-time notification: ${notification.name}`,
                                JSON.stringify({
                                    notification_id: notification.id,
                                    notification_name: notification.name,
                                    past_trigger: notification.next_trigger,
                                    current_time: currentTime,
                                    function: 'NotificationScheduler.initialize'
                                })
                            );

                            // Mark notification as inactive in the object so it won't be scheduled
                            notification.is_active = false;
                            continue; // Skip to next notification
                        } else {
                            // Has repeat - recalculate next_trigger to future
                            let nextTrigger;

                            if (this.isWeeklyRepeat(notification.repeat_frequency)) {
                                // Weekly repeat - find next matching day
                                nextTrigger = this.calculateNextWeeklyTrigger(
                                    notification.hour,
                                    notification.minute,
                                    this.parseWeeklyDays(notification.repeat_frequency),
                                    currentTime
                                );
                            } else {
                                // Seconds-based repeat - use math (not loop)
                                const currentTrigger = Math.floor(notification.next_trigger);
                                const frequency = Math.floor(notification.repeat_frequency);
                                const timePassed = currentTime - currentTrigger;
                                const missedOccurrences = Math.floor(timePassed / frequency);
                                nextTrigger = currentTrigger + (frequency * (missedOccurrences + 1));
                            }


                            // Update notification with new next_trigger
                            notificationQueries.updateNotification(
                                notification.id,
                                notification.name,
                                notification.guild_id,
                                notification.channel_id,
                                notification.hour,
                                notification.minute,
                                notification.message_content,
                                notification.title,
                                notification.description,
                                notification.color,
                                notification.image_url,
                                notification.thumbnail_url,
                                notification.footer,
                                notification.author,
                                notification.fields,
                                notification.pattern,
                                notification.mention,
                                notification.repeat_status,
                                notification.repeat_frequency,
                                notification.embed_toggle,
                                notification.is_active,
                                notification.last_trigger,
                                nextTrigger
                            );

                            systemLogQueries.addLog(
                                'info',
                                `Recalculated next trigger for repeating notification: ${notification.name}`,
                                JSON.stringify({
                                    notification_id: notification.id,
                                    notification_name: notification.name,
                                    old_trigger: notification.next_trigger,
                                    new_trigger: nextTrigger,
                                    frequency: frequency,
                                    function: 'NotificationScheduler.initialize'
                                })
                            );

                            // Update the notification object with new trigger
                            notification.next_trigger = nextTrigger;
                        }
                    }

                    // Schedule notification if still active
                    if (notification.is_active) {
                        this.scheduleNotification(notification);
                    }
                }
            }

        } catch (error) {
            await handleError(null, null, error, 'NotificationScheduler.initialize');
        }
    }

    /**
     * Schedule a notification with setTimeout for exact trigger time
     * Handles patterns to send notifications before the scheduled time
     * @param {Object} notification - The notification to schedule
     */
    scheduleNotification(notification) {
        const notificationId = notification.id;

        // Increment generation ID to cancel any in-flight preparations
        const generationId = (this.scheduleGenerations.get(notificationId) || 0) + 1;
        this.scheduleGenerations.set(notificationId, generationId);

        // Clear any existing schedules for this notification
        if (this.scheduledNotifications.has(notificationId)) {
            const existingTimeouts = this.scheduledNotifications.get(notificationId);
            if (Array.isArray(existingTimeouts)) {
                existingTimeouts.forEach(timeoutId => clearTimeout(timeoutId));
            } else {
                clearTimeout(existingTimeouts);
            }
            this.scheduledNotifications.delete(notificationId);
        }

        if (!notification.next_trigger) {
            return;
        }

        const currentTime = Math.floor(Date.now() / 1000);
        const scheduledTime = Math.floor(notification.next_trigger); // The actual scheduled time (always stays the same)

        // Parse pattern to determine when to send notifications
        // Pattern can be: "5m", "5m,10m,time", "time", etc.
        const pattern = notification.pattern || 'time';
        const sendTimes = this.calculateSendTimes(scheduledTime, pattern);


        const timeoutIds = [];
        let hasValidSchedule = false;

        // Schedule a timeout for each send time in the pattern
        for (const sendTime of sendTimes) {
            const delayMs = (sendTime - currentTime) * 1000;

            if (delayMs <= 0) {
                // This send time has passed, skip it
                continue;
            }

            hasValidSchedule = true;

            const timeoutId = setTimeout(async () => {
                try {
                    // Check if this schedule has been cancelled (new schedule created)
                    if (this.scheduleGenerations.get(notificationId) !== generationId) {
                        return; // Cancelled - don't send
                    }

                    const isLastSend = sendTime === scheduledTime;
                    await this.sendNotification(notification, sendTime, scheduledTime, isLastSend);
                } catch (error) {
                    await handleError(null, null, error, `NotificationScheduler.setTimeout - notification ${notification.id}`);
                }
            }, delayMs);

            timeoutIds.push(timeoutId);
        }

        if (!hasValidSchedule) {
            // All send times have passed
            if (notification.repeat_status === 1 && notification.repeat_frequency) {
                // Has repeat - will be handled on next cycle
            } else {
                // No repeat - deactivate the notification
                notificationQueries.updateNotification(
                    notification.id,
                    notification.name,
                    notification.guild_id,
                    notification.channel_id,
                    notification.hour,
                    notification.minute,
                    notification.message_content,
                    notification.title,
                    notification.description,
                    notification.color,
                    notification.image_url,
                    notification.thumbnail_url,
                    notification.footer,
                    notification.author,
                    notification.fields,
                    notification.pattern,
                    notification.mention,
                    notification.repeat_status,
                    notification.repeat_frequency,
                    notification.embed_toggle,
                    false, // is_active = false
                    Math.floor(Date.now() / 1000), // last_trigger
                    null // next_trigger
                );
            }
            return;
        }

        // Store all timeout IDs
        this.scheduledNotifications.set(notificationId, timeoutIds);
    }

    /**
     * Calculate all send times based on pattern
     * @param {number} scheduledTime - The scheduled time (Unix timestamp)
     * @param {string} pattern - Pattern string (e.g., "5", "5,10,time", "time")
     * @returns {Array<number>} Array of Unix timestamps when to send
     */
    calculateSendTimes(scheduledTime, pattern) {
        const sendTimes = [];

        if (!pattern || pattern === 'time') {
            // Only send at scheduled time
            sendTimes.push(scheduledTime);
            return sendTimes;
        }

        // Split pattern by comma
        const parts = pattern.split(',');

        for (const part of parts) {
            const trimmed = part.trim();

            if (trimmed === 'time') {
                // Send at scheduled time
                sendTimes.push(scheduledTime);
            } else {
                const minutes = parseInt(trimmed);
                if (!isNaN(minutes) && minutes > 0) {
                    const sendTime = scheduledTime - (minutes * 60);
                    sendTimes.push(sendTime);
                }
            }
        }

        // Sort send times in chronological order (earliest first)
        sendTimes.sort((a, b) => a - b);

        return sendTimes;
    }

    /**
     * Build and send a notification in one step
     * @param {Object} notification - The notification to send
     * @param {number} sendTime - The time this send is happening
     * @param {number} scheduledTime - The original scheduled time
     * @param {boolean} isLastSend - Whether this is the final send at scheduled time
     */
    async sendNotification(notification, sendTime, scheduledTime, isLastSend) {
        try {
            // Check if client is available and ready
            if (!this.client || !this.client.isReady()) {
                console.error(`Discord client not available for notification ${notification.id}`);
                return;
            }

            // Fetch fresh notification data from database (in case it was updated)
            const currentNotification = notificationQueries.getNotificationById(notification.id);
            if (!currentNotification || !currentNotification.is_active) {
                return;
            }

            // Build message content with mentions
            const mentions = parseMentions(currentNotification.mention);
            const rawMessageContent = currentNotification.message_content;
            const messageContent = convertTagsToMentions(rawMessageContent, mentions, 'message');
            let embed = null;

            // Create embed if enabled
            if (currentNotification.embed_toggle) {
                const rawDescription = currentNotification.description;
                const embedDescription = convertTagsToMentions(rawDescription, mentions, 'description');

                embed = new EmbedBuilder()
                    .setColor(currentNotification.color || '#0099ff')
                    .setTitle(currentNotification.title)
                    .setDescription(embedDescription);

                if (currentNotification.image_url && currentNotification.image_url.trim()) {
                    embed.setImage(currentNotification.image_url);
                }
                if (currentNotification.thumbnail_url && currentNotification.thumbnail_url.trim()) {
                    embed.setThumbnail(currentNotification.thumbnail_url);
                }
                if (currentNotification.footer && currentNotification.footer.trim()) {
                    embed.setFooter({ text: currentNotification.footer });
                }
                if (currentNotification.author && currentNotification.author.trim()) {
                    embed.setAuthor({ name: currentNotification.author });
                }

                if (currentNotification.fields) {
                    try {
                        const fields = JSON.parse(currentNotification.fields);
                        if (Array.isArray(fields) && fields.length > 0) {
                            fields.forEach((field, index) => {
                                if (field.name && field.value) {
                                    const fieldComponent = `field_${index}`;
                                    const fieldValue = convertTagsToMentions(field.value, mentions, fieldComponent);
                                    embed.addFields({ name: field.name, value: fieldValue, inline: field.inline || false });
                                }
                            });
                        }
                    } catch (error) {
                        await handleError(null, null, error, 'NotificationScheduler.sendNotification - parsing fields');
                    }
                }
            }

            // Resolve target and send
            let target = null;

            if (currentNotification.guild_id && currentNotification.channel_id) {
                // Server notification
                const guild = await this.client.guilds.fetch(currentNotification.guild_id);
                if (!guild) {
                    throw new Error(`Guild ${currentNotification.guild_id} not found`);
                }
                target = await guild.channels.fetch(currentNotification.channel_id);
                if (!target) {
                    throw new Error(`Channel ${currentNotification.channel_id} not found`);
                }
            } else if (currentNotification.created_by) {
                // Private notification (DM)
                target = await this.client.users.fetch(currentNotification.created_by);
                if (!target) {
                    throw new Error(`User ${currentNotification.created_by} not found`);
                }
            } else {
                throw new Error(`No valid target for notification ${notification.id}`);
            }

            // Send the notification
            await target.send({
                content: messageContent,
                embeds: embed ? [embed] : []
            });

            // Only update database and reschedule on the LAST send (at scheduled time)
            if (isLastSend) {
                await this.handleNotificationCompletion(notification, scheduledTime);
            }

        } catch (error) {
            await handleError(null, null, error, `NotificationScheduler.sendNotification - notification ${notification.id}`);
        }
    }

    /**
     * Handle notification completion after all sends are done
     * Updates database and reschedules if repeating
     * @param {Object} notification - The notification that completed
     * @param {number} scheduledTime - The scheduled time that just completed
     */
    async handleNotificationCompletion(notification, scheduledTime) {
        try {
            const currentTime = Math.floor(Date.now() / 1000);

            // Calculate next trigger based on repeat settings
            let nextTrigger = null;
            let isActive = notification.is_active;


            if (notification.repeat_status === 1 && notification.repeat_frequency) {
                // Has repeat - calculate next trigger
                let nextTriggerCalc;

                if (this.isWeeklyRepeat(notification.repeat_frequency)) {
                    // Weekly repeat - find next matching day after current time
                    nextTriggerCalc = this.calculateNextWeeklyTrigger(
                        notification.hour,
                        notification.minute,
                        this.parseWeeklyDays(notification.repeat_frequency),
                        currentTime
                    );
                } else {
                    // Seconds-based repeat (ensure integer timestamps)
                    const frequency = Math.floor(notification.repeat_frequency);
                    nextTriggerCalc = scheduledTime + frequency;

                    // Make sure next trigger is in the future
                    if (nextTriggerCalc < currentTime) {
                        const timePassed = currentTime - scheduledTime;
                        const missedOccurrences = Math.floor(timePassed / frequency);
                        nextTriggerCalc = scheduledTime + (frequency * (missedOccurrences + 1));
                    }
                }

                nextTrigger = nextTriggerCalc;

                isActive = true; // Keep active
            } else {
                // No repeat - deactivate
                isActive = false;
            }

            // Update notification in database
            notificationQueries.updateNotification(
                notification.id,
                notification.name,
                notification.guild_id,
                notification.channel_id,
                notification.hour,
                notification.minute,
                notification.message_content,
                notification.title,
                notification.description,
                notification.color,
                notification.image_url,
                notification.thumbnail_url,
                notification.footer,
                notification.author,
                notification.fields,
                notification.pattern,
                notification.mention,
                notification.repeat_status,
                notification.repeat_frequency,
                notification.embed_toggle,
                isActive,            // Deactivate if no repeat
                currentTime,         // last_trigger
                nextTrigger          // next_trigger
            );

            // Log successful notification
            systemLogQueries.addLog(
                'info',
                `Notification sent: ${notification.name}`,
                JSON.stringify({
                    notification_id: notification.id,
                    notification_name: notification.name,
                    type: notification.guild_id ? 'server' : 'private',
                    repeat: notification.repeat_status === 1,
                    next_trigger: nextTrigger,
                    function: 'NotificationScheduler.handleNotificationCompletion'
                })
            );

            // Remove from scheduled map (will be re-added if repeating)
            this.scheduledNotifications.delete(notification.id);

            // If there's a next trigger, schedule it
            if (nextTrigger && isActive) {
                const updatedNotification = notificationQueries.getNotificationById(notification.id);
                this.scheduleNotification(updatedNotification);
            }

        } catch (error) {
            await handleError(null, null, error, 'NotificationScheduler.handleNotificationCompletion');
        }
    }

    /**
     * Add or update a notification in the scheduler
     * @param {number} notificationId - The notification ID
     */
    async addNotification(notificationId) {
        try {
            const notification = notificationQueries.getNotificationById(notificationId);

            if (!notification) {
                await handleError(null, null, new Error(`Notification ${notificationId} not found`), 'NotificationScheduler.addNotification');
                return;
            }

            if (!notification.is_active) {
                return;
            }

            this.scheduleNotification(notification);

        } catch (error) {
            await handleError(null, null, error, 'NotificationScheduler.addNotification');
        }
    }

    /**
     * Remove a notification from the scheduler
     * @param {number} notificationId - The notification ID
     */
    removeNotification(notificationId) {
        // Increment generation to cancel in-flight preparations
        const generationId = (this.scheduleGenerations.get(notificationId) || 0) + 1;
        this.scheduleGenerations.set(notificationId, generationId);

        if (this.scheduledNotifications.has(notificationId)) {
            const timeouts = this.scheduledNotifications.get(notificationId);
            if (Array.isArray(timeouts)) {
                timeouts.forEach(timeoutId => clearTimeout(timeoutId));
            } else {
                clearTimeout(timeouts);
            }
            this.scheduledNotifications.delete(notificationId);
        }
    }

    /**
     * Check if repeat_frequency is a weekly schedule
     * @param {*} repeatFrequency - The repeat_frequency value from database
     * @returns {boolean} True if weekly format
     */
    isWeeklyRepeat(repeatFrequency) {
        return typeof repeatFrequency === 'string' && repeatFrequency.startsWith('weekly:');
    }

    /**
     * Parse weekly days from repeat_frequency string
     * @param {string} repeatFrequency - Format: "weekly:0,1,3,5"
     * @returns {number[]} Array of day numbers (0=Sunday..6=Saturday)
     */
    parseWeeklyDays(repeatFrequency) {
        return repeatFrequency.split(':')[1].split(',').map(Number);
    }

    /**
     * Calculate the next trigger timestamp for a weekly schedule
     * @param {number} hour - UTC hour (0-23)
     * @param {number} minute - UTC minute (0-59)
     * @param {number[]} days - Array of day numbers (0=Sunday..6=Saturday)
     * @param {number} afterTimestamp - Unix timestamp after which to find the next trigger
     * @returns {number|null} Next trigger Unix timestamp, or null if no valid day
     */
    calculateNextWeeklyTrigger(hour, minute, days, afterTimestamp) {
        const after = new Date(afterTimestamp * 1000);

        // Try each of the next 8 days to ensure we wrap around the week
        for (let offset = 0; offset <= 7; offset++) {
            const candidate = new Date(after);
            candidate.setUTCDate(candidate.getUTCDate() + offset);
            candidate.setUTCHours(hour, minute, 0, 0);

            const candidateTimestamp = Math.floor(candidate.getTime() / 1000);

            // Skip if this candidate is not in the future
            if (candidateTimestamp <= afterTimestamp) continue;

            // Check if this day matches a selected day
            if (days.includes(candidate.getUTCDay())) {
                return candidateTimestamp;
            }
        }

        return null;
    }

    /**
     * Cleanup and stop the scheduler
     */
    cleanup() {
        // Clear all scheduled notifications
        for (const [notificationId, timeouts] of this.scheduledNotifications) {
            if (Array.isArray(timeouts)) {
                timeouts.forEach(timeoutId => clearTimeout(timeoutId));
            } else {
                clearTimeout(timeouts);
            }
        }
        this.scheduledNotifications.clear();
        this.scheduleGenerations.clear();
    }
}

// Create singleton instance
const notificationScheduler = new NotificationScheduler();

/**
 * Initialize the notification scheduler
 * @param {import('discord.js').Client} client - The Discord client
 */
async function initializeNotificationScheduler(client) {
    await notificationScheduler.initialize(client);
}

module.exports = {
    notificationScheduler,
    initializeNotificationScheduler
};