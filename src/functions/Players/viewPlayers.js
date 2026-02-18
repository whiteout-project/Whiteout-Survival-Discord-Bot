const {
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    ContainerBuilder,
    MessageFlags,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize
} = require('discord.js');
const { allianceQueries, playerQueries } = require('../utility/database');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../Pagination/universalPagination');
const { getFurnaceReadable } = require('./furnaceReadable');
const { getAdminLang, assertUserMatches, sendError, hasPermission, updateComponentsV2AfterSeparator, createAllianceSelectionComponents } = require('../utility/commonFunctions');
const { getEmojiMapForAdmin, getComponentEmoji } = require('../utility/emojis');

const PLAYERS_PER_PAGE = 10;

/**
 * Creates the view players button for the player management panel
 * @param {string} userId - User ID who can interact with the button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} View players button
 */
function createViewPlayersButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`view_players_${userId}`)
        .setLabel(lang.players.mainPage.buttons.viewPlayers)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1049'));
}


/**
 * Gets alliances available to a user based on their permissions
 * @param {Object} adminData - Admin data from database
 * @returns {Array} Array of alliance objects
 */
function getAlliancesForUser(adminData) {
    try {
        if (adminData.is_owner || (adminData.permissions & PERMISSIONS.FULL_ACCESS)) {
            return allianceQueries.getAllAlliances();
        }

        if (adminData.permissions & PERMISSIONS.PLAYER_MANAGEMENT) {
            const assignedAlliances = JSON.parse(adminData.alliances || '[]');
            if (assignedAlliances.length === 0) return [];

            return assignedAlliances.map(allianceId =>
                allianceQueries.getAllianceById(allianceId)
            ).filter(Boolean);
        }

        return [];
    } catch (error) {
        console.error('Error getting alliances for user:', error);
        return [];
    }
}

/**
 * Creates the alliance selection container using the shared utility
 * @param {import('discord.js').Interaction} interaction
 * @param {Array} alliances - Alliances with players
 * @param {Object} lang - Language object
 * @param {number} page - Current page (default 0)
 * @returns {{ components: Array }}
 */
function createAllianceSelectionContainer(interaction, alliances, lang, page = 0) {
    return createAllianceSelectionComponents({
        interaction,
        alliances,
        lang,
        page,
        customIdPrefix: 'view_players_alliance_select',
        feature: 'view_players',
        subtype: 'alliance',
        placeholder: lang.players.viewPlayers.selectMenu.allianceSelect.placeholder,
        title: lang.players.viewPlayers.content.title.base,
        description: lang.players.viewPlayers.content.description.base,
        accentColor: 2417109, // Blue
        showAll: false,
        optionMapper: (alliance) => {
            const playerCount = playerQueries.getPlayersByAllianceId(alliance.id).length;
            return {
                label: alliance.name,
                value: alliance.id.toString(),
                description: lang.players.viewPlayers.selectMenu.allianceSelect.description
                    .replace('{alliancePriority}', alliance.priority)
                    .replace('{playerCount}', playerCount),
                emoji: getComponentEmoji(getEmojiMapForAdmin(interaction.user.id), '1001')
            };
        }
    });
}


/**
 * Builds the player-list container for the given page
 * @param {import('discord.js').Interaction} interaction
 * @param {Array} players - All players in the alliance (pre-filtered)
 * @param {Object} lang - Language object
 * @param {Object} alliance - Alliance object
 * @param {number} page - Current page (0-indexed)
 * @returns {{ components: Array }}
 */
function createPlayerListContainer(interaction, players, lang, alliance, page = 0) {
    // Sort players by furnace level (highest first) then paginate
    const sortedPlayers = Array.isArray(players)
        ? [...players].sort((a, b) => (b.furnace_level || 0) - (a.furnace_level || 0))
        : [];

    const totalPages = Math.max(1, Math.ceil(sortedPlayers.length / PLAYERS_PER_PAGE));
    const startIndex = page * PLAYERS_PER_PAGE;
    const currentPagePlayers = sortedPlayers.slice(startIndex, startIndex + PLAYERS_PER_PAGE);

    // Build player list text
    const playerLines = currentPagePlayers.map(player =>
        lang.players.viewPlayers.content.playerField.value
            .replace('{nickname}', player.nickname || `Player ${player.fid}`)
            .replace('{fid}', player.fid)
            .replace('{furnace}', getFurnaceReadable(player.furnace_level, lang) || 'Unknown')
            .replace('{state}', player.state || 'Unknown')
    );

    const titleText = lang.players.viewPlayers.content.title.playerList
        .replace('{allianceName}', alliance.name);
    const pageInfo = lang.pagination.text.pageInfo
        .replace('{current}', page + 1)
        .replace('{total}', totalPages);

    const displayText = [
        titleText,
        playerLines.join('\n'),
        '',
        pageInfo
    ].join('\n');

    // Pagination row (null when only 1 page)
    const paginationRow = createUniversalPaginationButtons({
        feature: 'view_players',
        subtype: 'player',
        userId: interaction.user.id,
        currentPage: page,
        totalPages,
        lang,
        contextData: [alliance.id]
    });

    const container = new ContainerBuilder()
        .setAccentColor(2417109) // Blue
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(displayText)
        )
        .addSeparatorComponents(
            new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
        );

    if (paginationRow) {
        container.addActionRowComponents(paginationRow);
    }

    const newSection = [container];

    return { components: updateComponentsV2AfterSeparator(interaction, newSection) };
}

/**
 * Handles the view players button — shows alliance selection
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleViewPlayersButton(interaction) {
    const { lang, adminData } = getAdminLang(interaction.user.id);
    try {
        const expectedUserId = interaction.customId.split('_')[2]; // view_players_userId

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.PLAYER_MANAGEMENT);
        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        const allAlliances = getAlliancesForUser(adminData);
        if (allAlliances.length === 0) {
            return await interaction.reply({
                content: lang.players.viewPlayers.errors.noAssignedAlliances,
                ephemeral: true
            });
        }

        // Filter to alliances that have at least one player
        const allianceIds = allAlliances.map(a => a.id);
        const playerCounts = playerQueries.getPlayerCountsByAllianceIds(allianceIds);
        const playerCountMap = {};
        playerCounts.forEach(row => { playerCountMap[row.alliance_id] = row.player_count; });

        const alliancesWithPlayers = allAlliances.filter(a => (playerCountMap[a.id] || 0) > 0);
        if (alliancesWithPlayers.length === 0) {
            return await interaction.reply({
                content: lang.players.viewPlayers.errors.noAvailableAlliances,
                ephemeral: true
            });
        }

        const { components } = createAllianceSelectionContainer(interaction, alliancesWithPlayers, lang, 0);
        await interaction.update({
            components,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleViewPlayersButton');
    }
}

/**
 * Handles pagination on the alliance selection screen
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleViewPlayersAlliancePagination(interaction) {
    const { lang, adminData } = getAdminLang(interaction.user.id);
    try {
        const { userId: expectedUserId, newPage } = parsePaginationCustomId(interaction.customId, 0);

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const allAlliances = getAlliancesForUser(adminData);
        const allianceIds = allAlliances.map(a => a.id);
        const playerCounts = playerQueries.getPlayerCountsByAllianceIds(allianceIds);
        const playerCountMap = {};
        playerCounts.forEach(row => { playerCountMap[row.alliance_id] = row.player_count; });

        const alliancesWithPlayers = allAlliances.filter(a => (playerCountMap[a.id] || 0) > 0);

        const { components } = createAllianceSelectionContainer(interaction, alliancesWithPlayers, lang, newPage);
        await interaction.update({
            components,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleViewPlayersAlliancePagination');
    }
}

/**
 * Handles alliance selection from the dropdown — shows player list (page 0)
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 */
async function handleViewPlayersAllianceSelection(interaction) {
    const { lang } = getAdminLang(interaction.user.id);
    try {
        // customId: view_players_alliance_select_{userId}_{page}
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[4];

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const allianceId = parseInt(interaction.values[0]);
        const alliance = allianceQueries.getAllianceById(allianceId);
        if (!alliance) {
            return await interaction.reply({
                content: lang.common.error,
                ephemeral: true
            });
        }

        const players = playerQueries.getPlayersByAllianceId(allianceId);
        if (players.length === 0) {
            return await interaction.reply({
                content: lang.players.viewPlayers.errors.noPlayersInAlliance,
                ephemeral: true
            });
        }

        const { components } = createPlayerListContainer(interaction, players, lang, alliance, 0);
        await interaction.update({
            components,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleViewPlayersAllianceSelection');
    }
}

/**
 * Handles pagination on the player list screen
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleViewPlayersPlayerPagination(interaction) {
    const { lang } = getAdminLang(interaction.user.id);
    try {
        // contextData[0] = allianceId
        const { userId: expectedUserId, newPage, contextData } = parsePaginationCustomId(interaction.customId, 1);

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const allianceId = parseInt(contextData[0]);
        const alliance = allianceQueries.getAllianceById(allianceId);
        const players = playerQueries.getPlayersByAllianceId(allianceId);

        const { components } = createPlayerListContainer(interaction, players, lang, alliance, newPage);
        await interaction.update({
            components,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleViewPlayersPlayerPagination');
    }
}

module.exports = {
    createViewPlayersButton,
    handleViewPlayersButton,
    handleViewPlayersAlliancePagination,
    handleViewPlayersAllianceSelection,
    handleViewPlayersPlayerPagination
};
