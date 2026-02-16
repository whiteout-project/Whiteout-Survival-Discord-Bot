const { ButtonBuilder, ButtonStyle, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, LabelBuilder, ContainerBuilder, MessageFlags, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize } = require('discord.js');
const { allianceQueries, systemLogQueries, playerQueries } = require('../utility/database');
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../Pagination/universalPagination');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { getAdminLang, assertUserMatches, sendError, hasPermission, updateComponentsV2AfterSeparator } = require('../utility/commonFunctions');
const { getEmojiMapForAdmin, getComponentEmoji, replaceEmojiPlaceholders } = require('./../utility/emojis');


/**
 * Creates an edit priority button
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} The edit priority button
 */
function createEditPriorityButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`edit_priority_${userId}`)
        .setLabel(lang.alliance.mainPage.buttons.editPriority)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1028'));
}

/**
 * Handles edit priority button interaction and shows alliance selection
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleEditPriorityButton(interaction) {
    // Get admin language preference
    const { adminData, lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[2];

        // Check if the interaction user matches the expected user
        if (!assertUserMatches(interaction, expectedUserId, lang)) return;


        // Check permissions: must be owner, have FULL_ACCESS, or have ALLIANCE_MANAGEMENT
        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);

        if (!hasFullAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Get all alliances ordered by priority
        const alliances = allianceQueries.getAllAlliances();

        if (!alliances || alliances.length === 0) {
            await interaction.reply({
                content: lang.alliance.editPriority.errors.noAlliances,
                ephemeral: true
            });
            return;
        }

        // Show first page
        await showPrioritySelectPage(interaction, alliances, 0, lang);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleEditPriorityButton');
    }
}

/**
 * Handles pagination for priority edit selection
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleEditPriorityPagination(interaction) {
    // Get admin language preference first
    const { lang } = getAdminLang(interaction.user.id);
    try {
        // Extract page from custom ID
        const { userId: expectedUserId, newPage } = parsePaginationCustomId(interaction.customId, 0);

        // Check if the interaction user matches the expected user
        if (interaction.user.id !== expectedUserId) {
            return await interaction.reply({
                content: lang.common.notForYou,
                ephemeral: true
            });
        }

        // Get all alliances ordered by priority
        const alliances = allianceQueries.getAllAlliances();

        if (!alliances || alliances.length === 0) {
            await interaction.reply({
                content: lang.alliance.editPriority.errors.noAlliances,
                ephemeral: true
            });
            return;
        }

        // Show requested page
        await showPrioritySelectPage(interaction, alliances, newPage, lang);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleEditPriorityPagination');
    }
}

/**
 * Shows a specific page of alliances for priority editing
 * @param {import('discord.js').ButtonInteraction} interaction 
 * @param {Array} alliances - Array of all alliances
 * @param {number} page - Current page (0-based)
 * @param {Object} lang - Language object
 * @param {boolean} isReply - Whether to reply or update
 */
async function showPrioritySelectPage(interaction, alliances, page, lang) {
    const itemsPerPage = 24;
    const totalPages = Math.ceil(alliances.length / itemsPerPage);

    // Ensure page is within bounds
    page = Math.max(0, Math.min(page, totalPages - 1));

    const start = page * itemsPerPage;
    const end = start + itemsPerPage;
    const currentAlliances = alliances.slice(start, end);
    const totalAlliances = alliances.length;

    // Only show context if more than 2 alliances exist
    if (totalAlliances < 2) {
        return interaction.reply({
            content: lang.alliance.editPriority.errors.notEnoughAlliances,
            ephemeral: true
        });
    }

    // Create select menu
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`select_alliance_priority_${interaction.user.id}_${page}`)
        .setPlaceholder(lang.alliance.editPriority.selectMenu.selectAlliance.placeholder);

    // Add alliance options
    for (const alliance of currentAlliances) {
        // Get player count for this alliance
        const playersInAlliance = playerQueries.getPlayersByAlliance(alliance.id);
        const playerCount = playersInAlliance.length;
        const option = new StringSelectMenuOptionBuilder()
            .setLabel(`${alliance.name}`)
            .setValue(alliance.id.toString())
            .setDescription(lang.alliance.editPriority.selectMenu.selectAlliance.description
                .replace('{priority}', alliance.priority)
                .replace('{playerCount}', playerCount));
        selectMenu.addOptions(option);
    }

    const component = [];

    // Add select menu
    const selectRow = new ActionRowBuilder().addComponents(selectMenu);

    // Add pagination buttons if more than 1 page (always show, disabled when needed)
    const paginationRow = createUniversalPaginationButtons({
        feature: 'edit_priority',
        userId: interaction.user.id,
        currentPage: page,
        totalPages: totalPages,
        lang: lang
    });

    component.push(selectRow);

    if (paginationRow) {
        component.push(paginationRow);
    }

    const container = [
        new ContainerBuilder()
            .setAccentColor(2417109) // blue
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.alliance.editPriority.content.title.base}\n` +
                    `${lang.alliance.editPriority.content.description.base}\n` +
                    `${lang.pagination.text.pageInfo
                        .replace('{current}', page + 1)
                        .replace('{total}', totalPages)}`

                )
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            )
            .addActionRowComponents(
                component
            ),
    ];

    const content = updateComponentsV2AfterSeparator(interaction, container);

    // Send or update the message
    interaction.update({
        components: content,
        messageFlags: MessageFlags.IsComponentsV2
    });
}

/**
 * Handles alliance selection for priority editing
 * @param {import('discord.js').StringSelectMenuInteraction} interaction 
 */
async function handlePriorityAllianceSelection(interaction) {
    const { lang } = getAdminLang(interaction.user.id);
    try {
        const selectedAllianceId = parseInt(interaction.values[0]);
        const alliance = allianceQueries.getAllianceById(selectedAllianceId);

        if (!alliance) {
            await interaction.reply({
                content: lang.common.error,
                ephemeral: true
            });
            return;
        }

        // Show priority editing interface
        await showPriorityEditInterface(interaction, alliance, lang);

    } catch (error) {
        await sendError(interaction, lang, error, 'handlePriorityAllianceSelection');
    }
}

/**
 * Shows the priority editing interface for a specific alliance
 * @param {import('discord.js').StringSelectMenuInteraction} interaction 
 * @param {Object} alliance - Alliance data
 * @param {Object} lang - Language object
 */
async function showPriorityEditInterface(interaction, alliance, lang) {
    // Get all alliances to determine context
    const allAlliances = allianceQueries.getAllAlliances();
    const totalAlliances = allAlliances.length;

    // Get 3 alliances above and below current alliance by priority
    const currentIndex = allAlliances.findIndex(a => a.id === alliance.id);
    const contextAlliances = [];

    for (let i = Math.max(0, currentIndex - 3); i <= Math.min(allAlliances.length - 1, currentIndex + 3); i++) {
        contextAlliances.push(allAlliances[i]);
    }

    // Add context alliances
    const contextList = contextAlliances.map(a => {
        const indicator = a.id === alliance.id ? replaceEmojiPlaceholders('{emoji.1016} ', getEmojiMapForAdmin(interaction.user.id)) : '   ';
        return `\u200E${indicator}**${a.priority}.** ${a.name}`;
    }).join('\n');

    // Create action buttons
    const actionRow = new ActionRowBuilder();

    const highestButton = new ButtonBuilder()
        .setCustomId(`priority_highest_${alliance.id}`)
        .setLabel(lang.alliance.editPriority.buttons.highest)
        .setStyle(ButtonStyle.Success)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1048'));

    const customButton = new ButtonBuilder()
        .setCustomId(`priority_custom_${alliance.id}`)
        .setLabel(lang.alliance.editPriority.buttons.custom)
        .setStyle(ButtonStyle.Primary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1043'));

    const lowestButton = new ButtonBuilder()
        .setCustomId(`priority_lowest_${alliance.id}`)
        .setLabel(lang.alliance.editPriority.buttons.lowest)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1007'));

    const backButton = new ButtonBuilder()
        .setCustomId(`back_to_priority_select_${interaction.user.id}`)
        .setLabel(lang.alliance.editPriority.buttons.backToSelect)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1019'));

    actionRow.addComponents(highestButton, customButton, lowestButton, backButton);

    const container = [
        new ContainerBuilder()
            .setAccentColor(2417109) // blue
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.alliance.editPriority.content.title.edit.replace('{allianceName}', alliance.name)}\n` +
                    `${lang.alliance.editPriority.content.description.edit}\n` +

                    `${lang.alliance.editPriority.content.currentPriorityField.name}\n` +
                    `${lang.alliance.editPriority.content.currentPriorityField.value
                        .replace('{priority}', alliance.priority)
                        .replace('{totalAlliances}', totalAlliances)}\n` +

                    `${lang.alliance.editPriority.content.priorityContextField.name}\n` +
                    `${contextList || lang.alliance.editPriority.content.priorityContextField.value}`
                )
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            )
            .addActionRowComponents(actionRow),
    ];

    const content = updateComponentsV2AfterSeparator(interaction, container);

    await interaction.update({
        components: content,
        flags: MessageFlags.IsComponentsV2
    });
}

/**
 * Handles priority change to highest (priority 1)
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handlePriorityHighest(interaction) {
    const { lang } = getAdminLang(interaction.user.id);
    try {
        const allianceId = parseInt(interaction.customId.split('_')[2]);
        await updateAlliancePriority(interaction, allianceId, 1);
    } catch (error) {
        await sendError(interaction, lang, error, 'handlePriorityHighest');
    }
}

/**
 * Handles priority change to lowest
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handlePriorityLowest(interaction) {
    const { lang } = getAdminLang(interaction.user.id);
    try {
        const allianceId = parseInt(interaction.customId.split('_')[2]);
        const allAlliances = allianceQueries.getAllAlliances();
        const maxPriority = allAlliances.length;

        await updateAlliancePriority(interaction, allianceId, maxPriority);
    } catch (error) {
        await sendError(interaction, lang, error, 'handlePriorityLowest');
    }
}

/**
 * Handles custom priority input modal
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handlePriorityCustom(interaction) {
    const { lang } = getAdminLang(interaction.user.id);
    try {
        const allianceId = interaction.customId.split('_')[2];
        const allAlliances = allianceQueries.getAllAlliances();
        const maxPriority = allAlliances.length;

        // Create modal
        const modal = new ModalBuilder()
            .setCustomId(`priority_custom_modal_${allianceId}`)
            .setTitle(lang.alliance.editPriority.modal.title);

        const priorityInput = new TextInputBuilder()
            .setCustomId('priority_value')
            .setPlaceholder(lang.alliance.editPriority.modal.priorityLabel.placeholder.replace('{maxPriority}', maxPriority))
            .setStyle(TextInputStyle.Short)
            .setMinLength(1)
            .setMaxLength(3)
            .setRequired(true);

        const priorityLabel = new LabelBuilder()
            .setLabel(lang.alliance.editPriority.modal.priorityLabel.label)
            .setDescription(lang.alliance.editPriority.modal.priorityLabel.description)
            .setTextInputComponent(priorityInput);

        modal.addLabelComponents(priorityLabel);

        await interaction.showModal(modal);

    } catch (error) {
        await sendError(interaction, lang, error, 'handlePriorityCustom');
    }
}

/**
 * Handles custom priority modal submission
 * @param {import('discord.js').ModalSubmitInteraction} interaction 
 */
async function handlePriorityCustomModal(interaction) {
    const { lang } = getAdminLang(interaction.user.id);
    try {
        const allianceId = parseInt(interaction.customId.split('_')[3]);
        const priorityValue = interaction.fields.getTextInputValue('priority_value');

        // Validate input
        const priority = parseInt(priorityValue);
        if (isNaN(priority) || priority < 1) {
            await interaction.reply({
                content: lang.alliance.editPriority.errors.invalidPriority,
                ephemeral: true
            });
            return;
        }

        // Get max allowed priority
        const allAlliances = allianceQueries.getAllAlliances();
        const maxPriority = allAlliances.length;

        // Clamp priority to valid range
        const finalPriority = Math.min(priority, maxPriority);

        await updateAlliancePriority(interaction, allianceId, finalPriority);

    } catch (error) {
        await sendError(interaction, lang, error, 'handlePriorityCustomModal');
    }
}

/**
 * Updates alliance priority and resolves conflicts
 * @param {import('discord.js').Interaction} interaction 
 * @param {number} allianceId - Alliance ID to update
 * @param {number} newPriority - New priority value
 */
async function updateAlliancePriority(interaction, allianceId, newPriority) {
    const { lang } = getAdminLang(interaction.user.id);
    try {

        const alliance = allianceQueries.getAllianceById(allianceId);
        if (!alliance) {
            await interaction.reply({
                content: lang.common.error,
                ephemeral: true
            });
            return;
        }

        const oldPriority = alliance.priority;

        // If priority didn't change, just refresh the interface
        if (oldPriority === newPriority) {
            await showPriorityEditInterface(interaction, alliance, lang);
            return;
        }

        // Get all alliances ordered by priority
        const allAlliances = allianceQueries.getAllAlliances();

        // Create a new priority order
        const alliancesWithoutTarget = allAlliances.filter(a => a.id !== allianceId);
        const newOrder = [];

        // Insert the target alliance at the desired position
        let inserted = false;
        for (let i = 0; i < alliancesWithoutTarget.length; i++) {
            if (!inserted && (i + 1) === newPriority) {
                newOrder.push({ id: allianceId, priority: newPriority });
                inserted = true;
            }
            newOrder.push({
                id: alliancesWithoutTarget[i].id,
                priority: inserted ? i + 2 : i + 1
            });
        }

        // If we want to insert at the end
        if (!inserted) {
            newOrder.push({ id: allianceId, priority: newPriority });
        }

        // Step 1: Set all alliances to temporary negative priorities
        for (const alliance of allAlliances) {
            allianceQueries.updateAlliancePriority(alliance.id, -(alliance.id));
        }

        // Step 2: Update all alliances to their new priorities
        for (const item of newOrder) {
            allianceQueries.updateAlliancePriority(item.id, item.priority);
        }

        // Log the priority change
        systemLogQueries.addLog(
            'alliance_priority',
            `Alliance priority updated: ${alliance.name}`,
            JSON.stringify({
                alliance_id: allianceId,
                alliance_name: alliance.name,
                old_priority: oldPriority,
                new_priority: newPriority,
                updated_by: interaction.user.id,
                updated_by_tag: interaction.user.tag,
                function: 'updateAlliancePriority'
            })
        );

        // Get updated alliance data and show interface
        const updatedAlliance = allianceQueries.getAllianceById(allianceId);
        await showPriorityEditInterface(interaction, updatedAlliance, lang);

        // Send success message
        await interaction.followUp({
            content: lang.alliance.editPriority.content.priorityUpdated
                .replace('{allianceName}', alliance.name)
                .replace('{oldPriority}', oldPriority)
                .replace('{newPriority}', newPriority),
            ephemeral: true
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'updateAlliancePriority');
    }
}

/**
 * Handles back to priority select button interaction
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleBackToPrioritySelect(interaction) {
    const { lang } = getAdminLang(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[4]; // back_to_priority_select_userId

        // Check if the interaction user matches the expected user
        if (!assertUserMatches(interaction, expectedUserId, lang)) return;

        // Get all alliances ordered by priority
        const alliances = allianceQueries.getAllAlliances();

        if (!alliances || alliances.length === 0) {
            await interaction.reply({
                content: lang.alliance.editPriority.errors.noAlliances,
                ephemeral: true
            });
            return;
        }

        // Show first page with update (false = update, not reply)
        await showPrioritySelectPage(interaction, alliances, 0, lang);

    } catch (error) {
        await sendError(interaction, lang, error, 'handleBackToPrioritySelect');
    }
}

module.exports = {
    createEditPriorityButton,
    handleEditPriorityButton,
    handleEditPriorityPagination,
    handlePriorityAllianceSelection,
    handleBackToPrioritySelect,
    handlePriorityHighest,
    handlePriorityLowest,
    handlePriorityCustom,
    handlePriorityCustomModal
};
