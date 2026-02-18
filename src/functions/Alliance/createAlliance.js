const {
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    ChannelSelectMenuBuilder,
    ChannelType,
    LabelBuilder,
    ContainerBuilder,
    MessageFlags,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize
} = require('discord.js');
const { adminQueries, allianceQueries, adminLogQueries } = require('../utility/database');
const { LOG_CODES } = require('../utility/AdminLogs');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { restartAutoRefresh } = require('./refreshAlliance');
const { getAdminLang, assertUserMatches, sendError, hasPermission, updateComponentsV2AfterSeparator, parseRefreshInterval, formatRefreshInterval } = require('../utility/commonFunctions');
const { getEmojiMapForAdmin, getComponentEmoji } = require('./../utility/emojis');


/**
 * Creates a create alliance button
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} The create alliance button
 */
function createCreateAllianceButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`create_alliance_${userId}`)
        .setLabel(lang.alliance.mainPage.buttons.createAlliance)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1000'));
}

/**
 * Handles create alliance button interaction and shows modal form
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleCreateAllianceButton(interaction) {
    // Get admin language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[2]; // create_alliance_userId

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check permissions: must be owner or have FULL_ACCESS or ALLIANCE_MANAGEMENT
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.ALLIANCE_MANAGEMENT);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        const modal = new ModalBuilder()
            .setCustomId(`create_alliance_modal_${interaction.user.id}`)
            .setTitle(lang.alliance.createAlliance.modal.title);

        // Alliance name input
        const allianceNameInput = new TextInputBuilder()
            .setCustomId('alliance_name')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(lang.alliance.createAlliance.modal.allianceField.placeholder)
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(50);

        // Wrap it in a label
        const allianceNameLabel = new LabelBuilder()
            .setLabel(lang.alliance.createAlliance.modal.allianceField.label)
            .setTextInputComponent(allianceNameInput);

        // Refresh rate input
        const refreshRateInput = new TextInputBuilder()
            .setCustomId('refresh_rate')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(lang.alliance.createAlliance.modal.refreshRateField.placeholder)
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(6);

        const refreshRateLabel = new LabelBuilder()
            .setLabel(lang.alliance.createAlliance.modal.refreshRateField.label)
            .setDescription(lang.alliance.createAlliance.modal.refreshRateField.description)
            .setTextInputComponent(refreshRateInput);

        // Add the label components to the modal
        modal.addLabelComponents(allianceNameLabel, refreshRateLabel);

        await interaction.showModal(modal)

    } catch (error) {
        await sendError(interaction, lang, error, 'handleCreateAllianceButton');
    }
}

/**
 * Handles create alliance modal submission
 * @param {import('discord.js').ModalSubmitInteraction} interaction 
 */
async function handleCreateAllianceModal(interaction) {
    // Get admin language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Check permissions again
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.ALLIANCE_MANAGEMENT);

        if (!hasAccess) {
            return await interaction.reply({ content: lang.common.noPermission, ephemeral: true });
        }

        // Get form values
        const allianceName = interaction.fields.getTextInputValue('alliance_name').trim();
        const refreshRateInput = interaction.fields.getTextInputValue('refresh_rate').trim();

        // Validate refresh rate (supports both minutes and @HH:MM format)
        const parseResult = parseRefreshInterval(refreshRateInput, lang);
        if (!parseResult.isValid) {
            return await interaction.reply({
                content: parseResult.error || lang.alliance.createAlliance.errors.invalidRefreshRate,
                ephemeral: true
            });
        }
        const refreshRate = parseResult.value;
        // Get all existing alliances to determine the next priority
        const existingAlliances = allianceQueries.getAllAlliances();
        const nextPriority = existingAlliances.length + 1;

        // Get admin's internal ID for the created_by field
        const adminId = adminData.id;

        // Create the alliance in database (without channel_id for now)
        const result = allianceQueries.addAlliance(
            nextPriority,      // priority
            allianceName,      // name
            null,              // guide_id (null for now)
            null,              // channel_id (will be set after channel selection)
            refreshRate,       // interval
            1,                 // auto_redeem (True by default)
            adminId            // created_by
        );

        // Get the newly created alliance ID
        const newAllianceId = result.lastInsertRowid;

        // Create channel selection dropdown
        const channelSelect = new ChannelSelectMenuBuilder()
            .setCustomId(`alliance_channel_select_${newAllianceId}_${interaction.user.id}`)
            .setPlaceholder(lang.alliance.createAlliance.selectMenu.channelSelect.placeholder)
            .setChannelTypes([ChannelType.GuildText])
            .setMinValues(1)
            .setMaxValues(1);

        const channelRow = new ActionRowBuilder().addComponents(channelSelect);
        const refreshRateText = formatRefreshInterval(refreshRate, lang);

        const container = [
            new ContainerBuilder()
                .setAccentColor(5763719) // green
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.alliance.createAlliance.content.title}\n` +
                        `${lang.alliance.createAlliance.content.description.replace('{allianceName}', allianceName)}\n` +
                        `${lang.alliance.createAlliance.content.allianceDetailsField.name}\n` +
                        `${lang.alliance.createAlliance.content.allianceDetailsField.value.step1
                            .replace('{allianceName}', allianceName)
                            .replace('{priority}', nextPriority)
                            .replace('{refreshRate}', refreshRateText)}`
                    )
                )
        ];

        // Add warning if refresh rate is less than 30 minutes (only for minute-based intervals)
        if (typeof refreshRate === 'number' && refreshRate > 0 && refreshRate < 30) {
            container[0].addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.alliance.createAlliance.content.warningField.name}\n` +
                    `${lang.alliance.createAlliance.content.warningField.value}`
                ),
            );
        }

        container[0].addSeparatorComponents(
            new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
        ).addActionRowComponents(
            channelRow
        );

        const content = updateComponentsV2AfterSeparator(interaction, container);

        await interaction.update({
            components: content,
            flags: MessageFlags.IsComponentsV2
        });

        // Log initial alliance creation (before channel selection)
        adminLogQueries.addLog(
            interaction.user.id,
            LOG_CODES.ALLIANCE.CREATED_PENDING,
            JSON.stringify({
                allianceName: allianceName,
                allianceId: newAllianceId,
                refreshRate: refreshRate,
                priority: nextPriority
            })
        );

    } catch (error) {
        await sendError(interaction, lang, error, 'handleCreateAllianceModal');
    }
}

/**
 * Handles alliance channel selection
 * @param {import('discord.js').ChannelSelectMenuInteraction} interaction 
 */
async function handleAllianceChannelSelection(interaction) {
    // Get admin language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);

    try {
        // Extract alliance ID and user ID from custom ID
        const customIdParts = interaction.customId.split('_'); // alliance_channel_select_allianceId_userId
        const allianceId = parseInt(customIdParts[3]);
        const expectedUserId = customIdParts[4];

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check permissions
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.ALLIANCE_MANAGEMENT);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Get selected channel
        const selectedChannelId = interaction.values[0];
        const selectedChannel = interaction.guild.channels.cache.get(selectedChannelId);

        if (!selectedChannel) {
            return await interaction.reply({
                content: lang.alliance.createAlliance.errors.invalidSelection,
                ephemeral: true
            });
        }

        try {
            // Get the alliance data
            const alliance = allianceQueries.getAllAlliances().find(a => a.id === allianceId);
            if (!alliance) {
                return await interaction.reply({
                    content: lang.alliance.createAlliance.errors.allianceNotFound,
                    ephemeral: true
                });
            }

            // Update the alliance with the selected channel and guild ID
            allianceQueries.updateAlliance(
                alliance.priority,          // priority 
                alliance.name,              // name
                selectedChannel.guild.id,   // guide_id (guild ID of the selected channel)
                selectedChannelId,          // channel_id
                alliance.interval,          // interval
                alliance.auto_redeem,       // auto_redeem
                allianceId                  // id
            );

            // Update alliance field for relevant admins (now that alliance is complete)
            await updateAdminAlliances(allianceId, adminData);

            // Log channel selection completion
            adminLogQueries.addLog(
                interaction.user.id,
                LOG_CODES.ALLIANCE.SETUP_COMPLETED,
                JSON.stringify({
                    allianceName: alliance.name,
                    allianceId: allianceId,
                    channelName: selectedChannel.name,
                    channelId: selectedChannelId,
                    guildName: selectedChannel.guild.name,
                    guildId: selectedChannel.guild.id
                })
            );

            // Create refresh rate text
            const refreshRateText = formatRefreshInterval(alliance.interval, lang);

            const container = [
                new ContainerBuilder()
                    .setAccentColor(5763719) // green
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            `${lang.alliance.createAlliance.content.title}\n` +
                            `${lang.alliance.createAlliance.content.description.replace('{allianceName}', alliance.name)}\n` +
                            `${lang.alliance.createAlliance.content.allianceDetailsField.name}\n` +
                            `${lang.alliance.createAlliance.content.allianceDetailsField.value.step2
                                .replace('{allianceName}', alliance.name)
                                .replace('{priority}', alliance.priority)
                                .replace('{refreshRate}', refreshRateText)
                                .replace('{channel}', `<#${selectedChannelId}>`)}`
                        )
                    )
            ];

            // Add warning if refresh rate is less than 30 minutes (only for minute-based)
            if (typeof alliance.interval === 'number' && alliance.interval > 0 && alliance.interval < 30) {
                container[0].addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(lang.alliance.createAlliance.content.warningField.name),
                    new TextDisplayBuilder().setContent(lang.alliance.createAlliance.content.warningField.value)
                );
            }

            const content = updateComponentsV2AfterSeparator(interaction, container);


            await interaction.update({
                components: content,
                flags: MessageFlags.IsComponentsV2
            });


            // Start auto-refresh if interval is configured (either number > 0 or time-based string)
            const shouldAutoRefresh = alliance.interval &&
                (typeof alliance.interval === 'string' && alliance.interval.startsWith('@')) ||
                (typeof alliance.interval === 'number' && alliance.interval > 0);

            if (shouldAutoRefresh) {
                try {
                    await restartAutoRefresh(allianceId);
                } catch (autoRefreshError) {
                    await sendError(interaction, lang, autoRefreshError, 'handleAllianceChannelSelection_autoRefresh', false);
                }
            }

        } catch (dbError) {
            await sendError(interaction, lang, dbError, 'handleAllianceChannelSelection_databaseError');
        }
    } catch (error) {
        await sendError(interaction, lang, error, 'handleAllianceChannelSelection');
    }
}

/**
 * Updates alliance field for admins who should have access to the new alliance
 * @param {number} allianceId - The newly created alliance ID
 * @param {Object} creatorAdminData - Admin data of the alliance creator
 */
async function updateAdminAlliances(allianceId, creatorAdminData) {
    try {
        // Get all admins
        const allAdmins = adminQueries.getAllAdmins();

        for (const admin of allAdmins) {
            let shouldHaveAccess = false;
            let currentAlliances = [];

            // Parse existing alliances (handle both string and null cases)
            try {
                if (admin.alliances && admin.alliances !== 'null' && admin.alliances !== '') {
                    currentAlliances = JSON.parse(admin.alliances);
                    if (!Array.isArray(currentAlliances)) {
                        currentAlliances = [];
                    }
                }
            } catch (parseError) {
                console.error(`Error parsing alliances for admin ${admin.user_id}:`, parseError);
                currentAlliances = [];
            }

            // Determine if admin should have access to this alliance
            if (admin.user_id === creatorAdminData.user_id) {
                // Currently, only the creator has access to their created alliance (expand logic here if access rules change)
                shouldHaveAccess = true;
            }

            // Add alliance ID if admin should have access and doesn't already have it
            if (shouldHaveAccess && !currentAlliances.includes(allianceId)) {
                currentAlliances.push(allianceId);
                adminQueries.updateAdminAlliances(JSON.stringify(currentAlliances), admin.user_id);
            }
        }

    } catch (error) {
        error.message = `${error.message} | context: allianceId=${allianceId}, adminUserId=${creatorAdminData?.user_id}`;
        await sendError(null, null, error, 'updateAdminAlliances', false);
    }
}

module.exports = {
    createCreateAllianceButton,
    handleCreateAllianceButton,
    handleCreateAllianceModal,
    handleAllianceChannelSelection
};