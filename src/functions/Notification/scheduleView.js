const {
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    ContainerBuilder,
    MessageFlags,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    SectionBuilder,
    ChannelSelectMenuBuilder,
    ChannelType
} = require('discord.js');
const { getUserInfo, assertUserMatches, handleError, hasPermission, updateComponentsV2AfterSeparator } = require('../utility/commonFunctions');
const { getEmojiMapForUser, getComponentEmoji, getGlobalEmojiMap } = require('../utility/emojis');
const { checkFeatureAccess } = require('../utility/checkAccess');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { getFilteredNotifications } = require('./editNotification');
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../Pagination/universalPagination');
const { showNotificationEditPanel } = require('./editNotification');
const { notificationQueries, scheduleBoardQueries } = require('../utility/database');

const ITEMS_PER_PAGE = 3;

/**
 * Creates the Schedule View button for the notification main page
 * @param {string} userId
 * @param {Object} lang
 * @returns {ButtonBuilder}
 */
function createScheduleViewButton(userId, lang) {
    return new ButtonBuilder()
        .setCustomId(`schedule_view_${userId}`)
        .setLabel(lang.notification.mainPage.buttons.scheduleView)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(userId), '1025'));
}

/**
 * Handles the Schedule View button — shows server/private type selection
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleScheduleViewButton(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        const expectedUserId = interaction.customId.split('_')[2];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const hasServerPermission = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.NOTIFICATIONS_MANAGEMENT);
        const hasPrivateFeature = checkFeatureAccess('privateNotifications', interaction);
        const sv = lang.notification.scheduleView;

        const serverButton = new ButtonBuilder()
            .setCustomId(`schedule_type_server_${interaction.user.id}`)
            .setLabel(sv.buttons.serverNotifications)
            .setStyle(ButtonStyle.Primary)
            .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1022'))
            .setDisabled(!hasServerPermission);

        const privateButton = new ButtonBuilder()
            .setCustomId(`schedule_type_private_${interaction.user.id}`)
            .setLabel(sv.buttons.privateNotifications)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1029'))
            .setDisabled(!hasPrivateFeature);

        const buttonRow = new ActionRowBuilder().addComponents(serverButton, privateButton);

        const container = [
            new ContainerBuilder()
                .setAccentColor(2417109)
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${sv.content.typeSelection}\n${sv.content.typeDescription}`
                    )
                )
                .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
                .addActionRowComponents(buttonRow)
        ];

        const content = updateComponentsV2AfterSeparator(interaction, container);

        await interaction.update({
            components: content,
            flags: MessageFlags.IsComponentsV2
        });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleScheduleViewButton');
    }
}

/**
 * Formats a repeat frequency into a human-readable string
 * @param {Object} notification
 * @param {Object} lang
 * @returns {string}
 */
function formatRepeatString(notification, lang) {
    const rf = lang.notification.editNotification.content.repeatField;
    const sv = lang.notification.scheduleView.details;

    if (!notification.repeat_status || notification.repeat_status === 0) {
        return sv.repeatNone;
    }

    const freq = notification.repeat_frequency;

    if (typeof freq === 'string' && freq.startsWith('weekly:')) {
        const dayNums = freq.split(':')[1].split(',').map(Number);
        const dayNames = rf.weeklyDays || ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const dayList = dayNums.map(d => dayNames[d]).join(', ');
        return sv.repeatWeekly.replace('{days}', dayList);
    }

    const numFreq = Math.floor(freq);
    const days = Math.floor(numFreq / 86400);
    const hours = Math.floor((numFreq % 86400) / 3600);
    const minutes = Math.floor((numFreq % 3600) / 60);
    const seconds = numFreq % 60;

    const parts = [];
    if (days > 0) parts.push(rf.days.replace('{count}', days));
    if (hours > 0) parts.push(rf.hours.replace('{count}', hours));
    if (minutes > 0) parts.push(rf.minutes.replace('{count}', minutes));
    if (seconds > 0) parts.push(rf.seconds.replace('{count}', seconds));

    return sv.repeatEvery.replace('{parts}', parts.join(' '));
}

/**
 * Groups notifications into time-range buckets
 * @param {Array} notifications - Active notifications with next_trigger
 * @returns {Object} { today, next7, next14, beyond }
 */
function groupByTimeRange(notifications) {
    const now = new Date();
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const endOfToday = new Date(startOfDay.getTime() + 86400000);
    const end7Days = new Date(startOfDay.getTime() + 7 * 86400000);
    const end14Days = new Date(startOfDay.getTime() + 14 * 86400000);

    const todayTs = Math.floor(endOfToday.getTime() / 1000);
    const day7Ts = Math.floor(end7Days.getTime() / 1000);
    const day14Ts = Math.floor(end14Days.getTime() / 1000);

    const groups = { today: [], next7: [], next14: [], beyond: [] };

    for (const n of notifications) {
        const trigger = n.next_trigger;
        if (!trigger) continue;

        if (trigger < todayTs) {
            groups.today.push(n);
        } else if (trigger < day7Ts) {
            groups.next7.push(n);
        } else if (trigger < day14Ts) {
            groups.next14.push(n);
        } else {
            groups.beyond.push(n);
        }
    }

    return groups;
}

/**
 * Builds the schedule view container for a given page
 * @param {Array} notifications - Sorted active notifications
 * @param {string} type - 'server' or 'private'
 * @param {number} page - 0-indexed page number
 * @param {string} userId
 * @param {Object} lang
 * @returns {ContainerBuilder}
 */
function buildScheduleContainer(notifications, type, page, userId, lang) {
    const sv = lang.notification.scheduleView;
    const totalPages = Math.max(1, Math.ceil(notifications.length / ITEMS_PER_PAGE));
    const pageItems = notifications.slice(page * ITEMS_PER_PAGE, (page + 1) * ITEMS_PER_PAGE);

    const titleText = `${sv.content.title}\n` +
        `${lang.pagination.text.pageInfo
            .replace('{current}', (page + 1).toString())
            .replace('{total}', totalPages.toString())}`;

    const container = new ContainerBuilder()
        .setAccentColor(2417109);

    // For server type, make the title a section with a Send button accessory
    if (type === 'server') {
        const sendButton = new ButtonBuilder()
            .setCustomId(`schedule_board_send_${page}_${userId}`)
            .setLabel(sv.buttons.send)
            .setStyle(ButtonStyle.Success)
            .setEmoji(getComponentEmoji(getEmojiMapForUser(userId), '1022'));

        container.addSectionComponents(
            new SectionBuilder()
                .setButtonAccessory(sendButton)
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(titleText)
                )
        );
    } else {
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(titleText)
        );
    }

    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));

    if (pageItems.length === 0) {
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(sv.content.noNotifications)
        );
    } else {
        // Group the page items by time range for section headers
        const groups = groupByTimeRange(pageItems);

        const sections = [
            { key: 'today', label: sv.content.today, items: groups.today },
            { key: 'next7', label: sv.content.next7Days, items: groups.next7 },
            { key: 'next14', label: sv.content.next14Days, items: groups.next14 },
            { key: 'beyond', label: sv.content.beyond14Days, items: groups.beyond }
        ];

        let addedSection = false;

        for (const section of sections) {
            if (section.items.length === 0) continue;

            // Add section header
            if (addedSection) {
                container.addSeparatorComponents(
                    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
                );
            }

            container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(section.label)
            );

            for (let i = 0; i < section.items.length; i++) {
                const n = section.items[i];
                const triggerDate = new Date(n.next_trigger * 1000);
                const timeStr = `${String(triggerDate.getUTCHours()).padStart(2, '0')}:${String(triggerDate.getUTCMinutes()).padStart(2, '0')}`;

                let details = `- ${n.name} ${sv.details.triggerTime.replace('{time}', timeStr)}\n`;
                details += `  - ${sv.details.nextTrigger.replace('{timestamp}', Math.floor(n.next_trigger))}\n`;
                details += `  - ${formatRepeatString(n, lang)}`;

                if (type === 'server' && n.channel_id) {
                    details += `\n  - ${sv.details.channel.replace('{channelId}', n.channel_id)}`;
                }

                const editButton = new ButtonBuilder()
                    .setCustomId(`schedule_edit_${n.id}_${type}_${page}_${userId}`)
                    .setLabel(sv.buttons.edit)
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji(getComponentEmoji(getEmojiMapForUser(userId), '1008'));

                const sectionComponent = new SectionBuilder()
                    .setButtonAccessory(editButton)
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(details)
                    );

                container.addSectionComponents(sectionComponent);

                if (i < section.items.length - 1) {
                    container.addSeparatorComponents(
                        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
                    );
                }
            }

            addedSection = true;
        }
    }

    // Pagination
    container.addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    );

    const paginationRow = createUniversalPaginationButtons({
        feature: 'schedule_view',
        userId,
        currentPage: page,
        totalPages,
        lang,
        contextData: [type]
    });

    if (paginationRow) {
        container.addActionRowComponents(paginationRow);
    }

    return container;
}

/**
 * Handles server/private type selection for schedule view
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleScheduleTypeSelection(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        const parts = interaction.customId.split('_');
        // schedule_type_{server|private}_{userId}
        const type = parts[2];
        const expectedUserId = parts[3];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Re-check permissions
        const hasServerPermission = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.NOTIFICATIONS_MANAGEMENT);
        const hasPrivateFeature = checkFeatureAccess('privateNotifications', interaction);

        if (type === 'server' && !hasServerPermission) {
            return await interaction.reply({ content: lang.common.noPermission, ephemeral: true });
        }
        if (type === 'private' && !hasPrivateFeature) {
            return await interaction.reply({ content: lang.common.noPermission, ephemeral: true });
        }

        // Get active notifications filtered by type and permissions
        const notifications = getFilteredNotifications(type, interaction.user.id, adminData, interaction.guild?.id)
            .filter(n => n.is_active && n.next_trigger)
            .sort((a, b) => a.next_trigger - b.next_trigger);

        const container = buildScheduleContainer(notifications, type, 0, interaction.user.id, lang);

        const content = updateComponentsV2AfterSeparator(interaction, [container]);

        await interaction.update({
            components: content,
            flags: MessageFlags.IsComponentsV2
        });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleScheduleTypeSelection');
    }
}

/**
 * Handles pagination for schedule view
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleScheduleViewPagination(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        const parsed = parsePaginationCustomId(interaction.customId, 1);
        if (!(await assertUserMatches(interaction, parsed.userId, lang))) return;

        const type = parsed.contextData[0];
        const newPage = parsed.newPage;

        const notifications = getFilteredNotifications(type, interaction.user.id, adminData, interaction.guild?.id)
            .filter(n => n.is_active && n.next_trigger)
            .sort((a, b) => a.next_trigger - b.next_trigger);

        const container = buildScheduleContainer(notifications, type, newPage, interaction.user.id, lang);

        const content = updateComponentsV2AfterSeparator(interaction, [container]);

        await interaction.update({
            components: content,
            flags: MessageFlags.IsComponentsV2
        });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleScheduleViewPagination');
    }
}

/**
 * Handles the edit button click on a notification in the schedule view
 * Opens the notification editor panel
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleScheduleEditButton(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        const parts = interaction.customId.split('_');
        // schedule_edit_{notificationId}_{type}_{page}_{userId}
        const notificationId = parseInt(parts[2]);
        const type = parts[3];
        const expectedUserId = parts[5];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Re-check permissions
        const hasServerPermission = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.NOTIFICATIONS_MANAGEMENT);
        const hasPrivateFeature = checkFeatureAccess('privateNotifications', interaction);

        if (type === 'server' && !hasServerPermission) {
            return await interaction.reply({ content: lang.common.noPermission, ephemeral: true });
        }
        if (type === 'private' && !hasPrivateFeature) {
            return await interaction.reply({ content: lang.common.noPermission, ephemeral: true });
        }

        const notification = notificationQueries.getNotificationById(notificationId);
        if (!notification) {
            return await interaction.reply({
                content: lang.notification.editNotification.errors.notificationNotFound,
                ephemeral: true
            });
        }

        await interaction.deferUpdate();
        await showNotificationEditPanel(interaction, notification, lang);
    } catch (error) {
        await handleError(interaction, lang, error, 'handleScheduleEditButton');
    }
}

/**
 * Handles the Send button on the schedule view — shows scope selection
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleScheduleBoardSend(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        const parts = interaction.customId.split('_');
        // schedule_board_send_{page}_{userId}
        const expectedUserId = parts[4];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const hasServerPermission = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.NOTIFICATIONS_MANAGEMENT);
        if (!hasServerPermission) {
            return await interaction.reply({ content: lang.common.noPermission, ephemeral: true });
        }

        const sv = lang.notification.scheduleView;

        const serverWideButton = new ButtonBuilder()
            .setCustomId(`schedule_board_scope_server_wide_${interaction.user.id}`)
            .setLabel(sv.buttons.serverWide)
            .setStyle(ButtonStyle.Primary)
            .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1022'));

        const perChannelButton = new ButtonBuilder()
            .setCustomId(`schedule_board_scope_per_channel_${interaction.user.id}`)
            .setLabel(sv.buttons.perChannel)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1029'));

        const row = new ActionRowBuilder().addComponents(serverWideButton, perChannelButton);

        const container = [
            new ContainerBuilder()
                .setAccentColor(2417109)
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${sv.content.boardScopeTitle}\n` +
                        `${sv.content.boardScopeDescription}\n\n` +
                        `${sv.content.boardServerWideDescription}\n` +
                        `${sv.content.boardPerChannelDescription}`
                    )
                )
                .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
                .addActionRowComponents(row)
        ];

        const content = updateComponentsV2AfterSeparator(interaction, container);

        await interaction.update({
            components: content,
            flags: MessageFlags.IsComponentsV2
        });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleScheduleBoardSend');
    }
}

/**
 * Handles scope selection (server_wide or per_channel)
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleBoardScopeSelection(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        const parts = interaction.customId.split('_');
        // schedule_board_scope_{server_wide|per_channel}_{userId}
        // server_wide splits as: schedule,board,scope,server,wide,userId
        // per_channel splits as: schedule,board,scope,per,channel,userId
        const scopeRaw = parts[3];
        const scope = scopeRaw === 'server' ? 'server_wide' : 'per_channel';
        const expectedUserId = parts[5];

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const hasServerPermission = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.NOTIFICATIONS_MANAGEMENT);
        if (!hasServerPermission) {
            return await interaction.reply({ content: lang.common.noPermission, ephemeral: true });
        }

        const sv = lang.notification.scheduleView;

        if (scope === 'per_channel') {
            // Show channel select to pick which channel's notifications to filter
            const channelSelect = new ChannelSelectMenuBuilder()
                .setCustomId(`schedule_board_filter_${interaction.user.id}`)
                .setPlaceholder(sv.content.boardFilterChannelDescription)
                .setChannelTypes([ChannelType.GuildText])
                .setMinValues(1)
                .setMaxValues(1);

            const row = new ActionRowBuilder().addComponents(channelSelect);

            const container = [
                new ContainerBuilder()
                    .setAccentColor(2417109)
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            `${sv.content.boardFilterChannelTitle}\n${sv.content.boardFilterChannelDescription}`
                        )
                    )
                    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
                    .addActionRowComponents(row)
            ];

            const content = updateComponentsV2AfterSeparator(interaction, container);

            await interaction.update({
                components: content,
                flags: MessageFlags.IsComponentsV2
            });
        } else {
            // Server-wide: go directly to target channel selection
            await showTargetChannelSelect(interaction, 'server_wide', null, lang);
        }
    } catch (error) {
        await handleError(interaction, lang, error, 'handleBoardScopeSelection');
    }
}

/**
 * Handles filter channel selection for per-channel boards
 * @param {import('discord.js').ChannelSelectMenuInteraction} interaction
 */
async function handleBoardFilterChannel(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        const parts = interaction.customId.split('_');
        // schedule_board_filter_{userId}
        const expectedUserId = parts[3];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const hasServerPermission = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.NOTIFICATIONS_MANAGEMENT);
        if (!hasServerPermission) {
            return await interaction.reply({ content: lang.common.noPermission, ephemeral: true });
        }

        const filterChannelId = interaction.values[0];
        await showTargetChannelSelect(interaction, 'per_channel', filterChannelId, lang);
    } catch (error) {
        await handleError(interaction, lang, error, 'handleBoardFilterChannel');
    }
}

/**
 * Shows the target channel select menu
 * @param {import('discord.js').Interaction} interaction
 * @param {string} scope - 'server_wide' or 'per_channel'
 * @param {string|null} filterChannelId - Channel to filter notifications from (for per_channel)
 * @param {Object} lang
 */
async function showTargetChannelSelect(interaction, scope, filterChannelId, lang) {
    const sv = lang.notification.scheduleView;

    const filterPart = filterChannelId || 'none';
    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId(`schedule_board_target_${scope}_${filterPart}_${interaction.user.id}`)
        .setPlaceholder(sv.content.boardTargetChannelDescription)
        .setChannelTypes([ChannelType.GuildText])
        .setMinValues(1)
        .setMaxValues(1);

    const row = new ActionRowBuilder().addComponents(channelSelect);

    const container = [
        new ContainerBuilder()
            .setAccentColor(2417109)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${sv.content.boardTargetChannelTitle}\n${sv.content.boardTargetChannelDescription}`
                )
            )
            .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
            .addActionRowComponents(row)
    ];

    const content = updateComponentsV2AfterSeparator(interaction, container);

    await interaction.update({
        components: content,
        flags: MessageFlags.IsComponentsV2
    });
}

const BOARD_PAGE_SIZE = 10;

/**
 * Builds the schedule board container (Components V2) to be sent to a channel
 * @param {Array} notifications - Active notifications sorted by next_trigger
 * @param {Object} lang
 * @param {Object} [boardMeta] - Optional metadata for pagination button
 * @param {string} boardMeta.scope - 'server_wide' or 'per_channel'
 * @param {string|null} boardMeta.filterChannelId
 * @param {string} boardMeta.guildId
 * @returns {ContainerBuilder}
 */
function buildScheduleBoardContainer(notifications, lang, boardMeta) {
    const sv = lang.notification.scheduleView;

    const container = new ContainerBuilder()
        .setAccentColor(0x2391E5)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(sv.content.boardTitle)
        )
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));

    // Show first page
    const displayNotifications = notifications.slice(0, BOARD_PAGE_SIZE);

    if (displayNotifications.length === 0) {
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(sv.content.noNotifications)
        );
        return container;
    }

    appendBoardNotifications(container, displayNotifications, sv);

    // Add "More Events" button if there are more notifications
    if (notifications.length > BOARD_PAGE_SIZE && boardMeta) {
        const filterPart = boardMeta.filterChannelId || 'none';
        const nextButton = new ButtonBuilder()
            .setCustomId(`schedule_board_page_1_${boardMeta.scope}_${filterPart}_${boardMeta.guildId}`)
            .setLabel(sv.buttons.nextPage)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(getComponentEmoji(getGlobalEmojiMap(), '1034'));

        container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
        container.addActionRowComponents(new ActionRowBuilder().addComponents(nextButton));
    }

    return container;
}

/**
 * Appends notification lines grouped by time range to a container
 * @param {ContainerBuilder} container
 * @param {Array} notifications
 * @param {Object} sv - scheduleView lang object
 */
function appendBoardNotifications(container, notifications, sv) {
    const groups = groupByTimeRange(notifications);

    const sections = [
        { label: sv.content.today, items: groups.today },
        { label: sv.content.next7Days, items: groups.next7 },
        { label: sv.content.next14Days, items: groups.next14 },
        { label: sv.content.beyond14Days, items: groups.beyond }
    ];

    let addedSection = false;

    for (const section of sections) {
        if (section.items.length === 0) continue;

        if (addedSection) {
            container.addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            );
        }

        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(section.label)
        );

        const lines = section.items.map(n => {
            const triggerDate = new Date(n.next_trigger * 1000);
            const timeStr = `${String(triggerDate.getUTCHours()).padStart(2, '0')}:${String(triggerDate.getUTCMinutes()).padStart(2, '0')}`;
            const triggerTime = sv.details.triggerTime.replace('{time}', timeStr);
            const startTime = sv.details.nextTrigger.replace('{timestamp}', Math.floor(n.next_trigger));
            return `- ${triggerTime} ${n.name} ${startTime}`;
        });

        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(lines.join('\n'))
        );

        addedSection = true;
    }
}

/**
 * Handles the target channel selection — sends the board and saves to DB
 * @param {import('discord.js').ChannelSelectMenuInteraction} interaction
 */
async function handleBoardTargetChannel(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        const parts = interaction.customId.split('_');
        // schedule_board_target_{scope}_{filterChannelId|none}_{userId}
        // server_wide: schedule,board,target,server,wide,none,userId → scope parts[3]+parts[4], filter=parts[5], user=parts[6]
        // per_channel: schedule,board,target,per,channel,channelId,userId → scope parts[3]+parts[4], filter=parts[5], user=parts[6]
        const scopeRaw = parts[3];
        const scope = scopeRaw === 'server' ? 'server_wide' : 'per_channel';
        const filterChannelId = parts[5] === 'none' ? null : parts[5];
        const expectedUserId = parts[6];

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const hasServerPermission = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.NOTIFICATIONS_MANAGEMENT);
        if (!hasServerPermission) {
            return await interaction.reply({ content: lang.common.noPermission, ephemeral: true });
        }

        const targetChannelId = interaction.values[0];
        const targetChannel = interaction.guild.channels.cache.get(targetChannelId);

        if (!targetChannel) {
            return await interaction.reply({
                content: lang.notification.notificationSettings.errors.invalidChannel,
                ephemeral: true
            });
        }

        // Get notifications based on scope
        let notifications = getFilteredNotifications('server', interaction.user.id, adminData, interaction.guild.id)
            .filter(n => n.is_active && n.next_trigger);

        if (scope === 'per_channel' && filterChannelId) {
            notifications = notifications.filter(n => n.channel_id === filterChannelId);
        }

        notifications.sort((a, b) => a.next_trigger - b.next_trigger);

        // Build and send the board as Components V2
        const boardMeta = { scope, filterChannelId, guildId: interaction.guild.id };
        const boardContainer = buildScheduleBoardContainer(notifications, lang, boardMeta);
        const sv = lang.notification.scheduleView;

        const boardMessage = await targetChannel.send({
            components: [boardContainer],
            flags: MessageFlags.IsComponentsV2
        });

        // Save to database
        scheduleBoardQueries.addBoard(
            interaction.guild.id,
            targetChannelId,
            boardMessage.id,
            scope,
            filterChannelId,
            interaction.user.id
        );

        const confirmContainer = [
            new ContainerBuilder()
                .setAccentColor(0x57F287)
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        sv.content.boardSent.replace('{channelId}', targetChannelId)
                    )
                )
        ];

        const content = updateComponentsV2AfterSeparator(interaction, confirmContainer);

        await interaction.update({
            components: content,
            flags: MessageFlags.IsComponentsV2
        });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleBoardTargetChannel');
    }
}

/**
 * Updates all schedule boards for a guild after notification changes
 * @param {string} guildId - The guild to update boards for
 * @param {import('discord.js').Client} client - Discord client
 */
async function updateBoardsForGuild(guildId, client) {
    if (!guildId || !client) return;

    const boards = scheduleBoardQueries.getBoardsByGuild(guildId);
    if (!boards || boards.length === 0) return;

    for (const board of boards) {
        try {
            const { lang } = getUserInfo(board.created_by);

            let notifications = notificationQueries.getNotificationsByGuild(guildId)
                .filter(n => n.is_active && n.next_trigger);

            if (board.scope === 'per_channel' && board.filter_channel_id) {
                notifications = notifications.filter(n => n.channel_id === board.filter_channel_id);
            }

            notifications.sort((a, b) => a.next_trigger - b.next_trigger);

            const boardMeta = { scope: board.scope, filterChannelId: board.filter_channel_id, guildId };
            const container = buildScheduleBoardContainer(notifications, lang, boardMeta);

            const guild = await client.guilds.fetch(guildId);
            const channel = await guild.channels.fetch(board.target_channel_id);
            const message = await channel.messages.fetch(board.message_id);

            await message.edit({
                components: [container],
                flags: MessageFlags.IsComponentsV2
            });
        } catch (error) {
            if (error.code === 10008 || error.code === 10003) {
                // Unknown Message or Unknown Channel — remove stale board
                scheduleBoardQueries.deleteBoard(board.id);
            }
        }
    }
}

/**
 * Handles the "More Events" button on the public board — sends an ephemeral paginated view.
 * Also handles prev/next navigation within that ephemeral view.
 * CustomId: schedule_board_page_{page}_{scope}_{filterChannelId|none}_{guildId}
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleBoardPageButton(interaction) {
    const { lang } = getUserInfo(interaction.user.id);

    try {
        const parts = interaction.customId.split('_');
        // schedule_board_page_{page}_{scope}_{filterChannelId|none}_{guildId}
        // schedule,board,page,1,server,wide,none,guildId  OR  schedule,board,page,1,per,channel,channelId,guildId
        const page = parseInt(parts[3]);
        const scopeRaw = parts[4];
        const scope = scopeRaw === 'server' ? 'server_wide' : 'per_channel';
        const filterChannelId = parts[6] === 'none' ? null : parts[6];
        const guildId = parts[7];

        // Fetch notifications
        let notifications = notificationQueries.getNotificationsByGuild(guildId)
            .filter(n => n.is_active && n.next_trigger);

        if (scope === 'per_channel' && filterChannelId) {
            notifications = notifications.filter(n => n.channel_id === filterChannelId);
        }

        notifications.sort((a, b) => a.next_trigger - b.next_trigger);

        const totalPages = Math.ceil(notifications.length / BOARD_PAGE_SIZE);
        const pageNotifications = notifications.slice(page * BOARD_PAGE_SIZE, (page + 1) * BOARD_PAGE_SIZE);
        const sv = lang.notification.scheduleView;

        // Build ephemeral container
        const container = new ContainerBuilder()
            .setAccentColor(0x2391E5)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(sv.content.boardTitle)
            )
            .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));

        if (pageNotifications.length > 0) {
            appendBoardNotifications(container, pageNotifications, sv);
        } else {
            container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(sv.content.noNotifications)
            );
        }

        // Add navigation buttons
        const scopePart = scope === 'server_wide' ? 'server_wide' : 'per_channel';
        const filterPart = filterChannelId || 'none';
        const navRow = new ActionRowBuilder();

        if (page > 0) {
            navRow.addComponents(
                new ButtonBuilder()
                    .setCustomId(`schedule_board_page_${page - 1}_${scopePart}_${filterPart}_${guildId}`)
                    .setEmoji(getComponentEmoji(getGlobalEmojiMap(), '1019'))
                    .setStyle(ButtonStyle.Secondary)
            );
        }

        navRow.addComponents(
            new ButtonBuilder()
                .setCustomId(`schedule_board_pageinfo_${page}`)
                .setLabel(`${page + 1}/${totalPages}`)
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true)
        );

        if (page + 1 < totalPages) {
            navRow.addComponents(
                new ButtonBuilder()
                    .setCustomId(`schedule_board_page_${page + 1}_${scopePart}_${filterPart}_${guildId}`)
                    .setEmoji(getComponentEmoji(getGlobalEmojiMap(), '1034'))
                    .setStyle(ButtonStyle.Secondary)
            );
        }

        container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
        container.addActionRowComponents(navRow);

        // If this came from the public board (first click), reply ephemeral; otherwise update the ephemeral message
        if (interaction.replied || interaction.deferred) {
            await interaction.editReply({
                components: [container],
                flags: MessageFlags.IsComponentsV2
            });
        } else {
            // Check if this is a component on the ephemeral message (user already has an ephemeral) or the public board
            // If the message has MessageFlags.Ephemeral, it's a navigation click on the ephemeral message → update
            if (interaction.message.flags.has(MessageFlags.Ephemeral)) {
                await interaction.update({
                    components: [container],
                    flags: MessageFlags.IsComponentsV2
                });
            } else {
                // First click on the public board → send ephemeral reply
                await interaction.reply({
                    components: [container],
                    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
                });
            }
        }
    } catch (error) {
        await handleError(interaction, lang, error, 'handleBoardPageButton');
    }
}

module.exports = {
    createScheduleViewButton,
    handleScheduleViewButton,
    handleScheduleTypeSelection,
    handleScheduleViewPagination,
    handleScheduleEditButton,
    handleScheduleBoardSend,
    handleBoardScopeSelection,
    handleBoardFilterChannel,
    handleBoardTargetChannel,
    handleBoardPageButton,
    buildScheduleBoardContainer,
    updateBoardsForGuild
};
