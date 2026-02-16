const { ButtonBuilder, ButtonStyle, ActionRowBuilder, ContainerBuilder, TextDisplayBuilder, FileBuilder, SeparatorBuilder, SeparatorSpacingSize, StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const { playerQueries, allianceQueries, adminQueries } = require('../utility/database');
const { getAdminLang, assertUserMatches, sendError, updateComponentsV2AfterSeparator, encodeExportSelection, decodeExportSelection, checkCustomIdLength, hasPermission } = require('../utility/commonFunctions');
const { getComponentEmoji, getEmojiMapForAdmin } = require('../utility/emojis');
const { getFurnaceReadable, FURNACE_LEVEL_MAPPING } = require('./furnaceReadable');
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../Pagination/universalPagination');
const fs = require('fs');
const path = require('path');
const { PERMISSIONS } = require('../Settings/admin/permissions');

/**
 * Creates an export button
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} The export button
 */
function createExportButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`export_panel_${userId}`)
        .setLabel(lang.players.mainPage.buttons.export)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForAdmin(userId), '1035'));
}

/**
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {Object} lang - Language object for localized text
 * @param {string} encodedSelection - The current encoded filter selection
 * @param {string} stateDisplay - Pre-rendered display string for the current state filter (e.g., "State 1, State 2" or "All")
 * @param {string} allianceDisplay - Pre-rendered display string for the current alliance filter (e.g., "Alliance 1, Alliance 2" or "All")
 * @param {string} furnaceDisplay - Pre-rendered display string for the current furnace filter (e.g., "Furnace 1, Furnace 2" or "All")
 * @param {number} count - The number of players matching the current filters
 * @param {string} headerTitle - Optional title to override the main panel title
 * @param {string} headerDesc - Optional description to override the main panel description
 * @param {Array<ActionRowBuilder>} extraActionRows - Optional extra action rows to append to the container (e.g., for select menus or pagination buttons)
 * Returns a ContainerBuilder ready to be added to interaction.update()
 */
function buildExportContainer(interaction, lang, encodedSelection, stateDisplay, allianceDisplay, furnaceDisplay, count, headerTitle = null, headerDesc = null, extraActionRows = []) {
    const userId = interaction.user.id;

    const stateLabel = stateDisplay || (lang.players.export.content.all);
    const allianceLabel = allianceDisplay || (lang.players.export.content.all);
    const furnaceLabel = furnaceDisplay || (lang.players.export.content.all);

    const filterRow = createFilterButtonRow(userId, encodedSelection, lang, count);

    const title = headerTitle || (lang.players.export.content.title.base);
    const desc = headerDesc || (lang.players.export.content.description.base);

    const container = new ContainerBuilder()
        .setAccentColor(2417109)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `${title}\n` +
                `${desc}\n` +
                `${lang.players.export.content.filtersField.name}\n` +
                `${lang.players.export.content.filtersField.value
                    .replace('{state}', stateLabel)
                    .replace('{alliance}', allianceLabel)
                    .replace('{furnace}', furnaceLabel)}\n` +
                `${lang.players.export?.content?.count?.replace('{playerCount}', count)}`
            )
        )
        .addSeparatorComponents(
            new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
        )
        .addActionRowComponents(filterRow);

    // Append any extra action rows (select menus, pagination) so callers don't need to recreate the button row
    if (Array.isArray(extraActionRows) && extraActionRows.length > 0) {
        for (const ar of extraActionRows) {
            try { container.addActionRowComponents(ar); } catch (e) { /* ignore invalid rows */ }
        }
    }

    return container;
}

/**
 * Shows the main export panel with filter buttons
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function showExportPanel(interaction) {
    const { lang, adminData } = getAdminLang(interaction.user.id);

    try {
        const expectedUserId = interaction.customId.split('_')[2];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check permissions
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.PLAYER_MANAGEMENT);
        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Create initial encoded selection (empty)
        const encoded = 'none';

        // Determine initial matching players count scoped to admin access
        const initialAllianceFilter = getAccessibleAllianceIds(adminData);
        if (initialAllianceFilter && initialAllianceFilter.length === 0) {
            return await interaction.reply({
                content: lang.players.export.errors.noAlliances,
                ephemeral: true
            });
        }

        const initialCount = playerQueries.getPlayersForExport({
            states: undefined,
            allianceIds: initialAllianceFilter,
            furnaceLevels: undefined
        }).length;

        const allLabel = lang.players.export.content.all;
        const container = buildExportContainer(
            interaction,
            lang,
            encoded,
            allLabel,
            allLabel,
            allLabel,
            initialCount
        );

        await interaction.update({
            components: updateComponentsV2AfterSeparator(interaction, [container]),
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'showExportPanel');
    }
}

/**
 * Handle state filter button click
 */
async function handleStateFilterButton(interaction) {
    const { lang, adminData } = getAdminLang(interaction.user.id);

    try {
        const parts = interaction.customId.split('_');
        const userId = parts[3];
        const encodedSelection = parts[4];

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        const currentSelection = decodeExportSelection(encodedSelection);

        // States available in DB for this admin's accessible alliances
        const allStates = getUniqueStates(adminData);

        const selectMenuComponents = createPaginatedSelectMenu({
            items: allStates,
            itemsPerPage: 24,
            currentPage: 0,
            customIdBase: 'export_state_select',
            userId: userId,
            encodedSelection: encodedSelection,
            lang: lang,
            labelFn: (state) => `State ${state}`,
            valueFn: (state) => state.toString(),
            selectedValues: (currentSelection.states || []).map(s => s.toString()),
            allOption: {
                label: lang.players.export.selectMenu.stateFilter.all,
                value: 'all'
            },
            feature: 'export_state',
            placeholder: lang.players.export.selectMenu.stateFilter.placeholder
        });

        const playerCount = getFilteredPlayerCount(currentSelection, adminData);
        const displayLabels = generateFilterDisplayLabels(currentSelection, lang);

        const container = buildExportContainer(
            interaction,
            lang,
            encodedSelection,
            displayLabels.stateDisplay,
            displayLabels.allianceDisplay,
            displayLabels.furnaceDisplay,
            playerCount,
            lang.players.export.content.title.selectState,
            lang.players.export.content.description.selectState,
            selectMenuComponents
        );

        await interaction.update({
            components: updateComponentsV2AfterSeparator(interaction, [container]),
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleStateFilterButton');
    }
}

/**
 * Handle state selection from menu
 */
async function handleStateSelection(interaction) {
    const { lang, adminData } = getAdminLang(interaction.user.id);

    try {
        const parts = interaction.customId.split('_');
        const userId = parts[3];
        const encodedSelection = parts[4];

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        const currentSelection = decodeExportSelection(encodedSelection);
        const selectedValues = interaction.values;

        if (selectedValues.includes('all')) {
            currentSelection.states = [];
        } else {
            currentSelection.states = selectedValues.map(v => parseInt(v, 10));
        }

        const newEncoded = encodeExportSelection(currentSelection);
        const playerCount = getFilteredPlayerCount(currentSelection, adminData);
        const displayLabels = generateFilterDisplayLabels(currentSelection, lang);

        const allLabel = lang.players.export.content.all;
        const container = buildExportContainer(
            interaction,
            lang,
            newEncoded,
            displayLabels.stateDisplay,
            displayLabels.allianceDisplay,
            displayLabels.furnaceDisplay,
            playerCount
        );

        await interaction.update({
            components: updateComponentsV2AfterSeparator(interaction, [container]),
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleStateSelection');
    }
}

/**
 * Handle alliance filter button click
 */
async function handleAllianceFilterButton(interaction) {
    const { lang, adminData } = getAdminLang(interaction.user.id);

    try {
        const parts = interaction.customId.split('_');
        const userId = parts[3];
        const encodedSelection = parts[4];

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        const currentSelection = decodeExportSelection(encodedSelection);
        const alliances = getFilteredAlliances(adminData);

        const selectMenuComponents = createPaginatedSelectMenu({
            items: alliances,
            itemsPerPage: 24,
            currentPage: 0,
            customIdBase: 'export_alliance_select',
            userId: userId,
            encodedSelection: encodedSelection,
            lang: lang,
            labelFn: (alliance) => alliance.name,
            valueFn: (alliance) => alliance.id.toString(),
            selectedValues: (currentSelection.allianceIds || []).map(id => id.toString()),
            allOption: {
                label: lang.players.export.selectMenu.allianceFilter.all,
                value: 'all'
            },
            feature: 'export_alliance',
            placeholder: lang.players.export.selectMenu.allianceFilter.placeholder
        });

        const playerCount = getFilteredPlayerCount(currentSelection, adminData);
        const displayLabels = generateFilterDisplayLabels(currentSelection, lang);

        const container = buildExportContainer(
            interaction,
            lang,
            encodedSelection,
            displayLabels.stateDisplay,
            displayLabels.allianceDisplay,
            displayLabels.furnaceDisplay,
            playerCount,
            lang.players.export.content.title.selectAlliance,
            lang.players.export.content.description.selectAlliance,
            selectMenuComponents
        );

        await interaction.update({
            components: updateComponentsV2AfterSeparator(interaction, [container]),
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleAllianceFilterButton');
    }
}

/**
 * Handle alliance selection from menu
 */
async function handleAllianceSelection(interaction) {
    const { lang, adminData } = getAdminLang(interaction.user.id);

    try {
        const parts = interaction.customId.split('_');
        const userId = parts[3];
        const encodedSelection = parts[4];

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        const currentSelection = decodeExportSelection(encodedSelection);
        const selectedValues = interaction.values;

        if (selectedValues.includes('all')) {
            currentSelection.allianceIds = [];
        } else {
            currentSelection.allianceIds = selectedValues.map(v => parseInt(v, 10));
        }

        const newEncoded = encodeExportSelection(currentSelection);
        const playerCount = getFilteredPlayerCount(currentSelection, adminData);
        const displayLabels = generateFilterDisplayLabels(currentSelection, lang);

        const container = buildExportContainer(
            interaction,
            lang,
            newEncoded,
            displayLabels.stateDisplay,
            displayLabels.allianceDisplay,
            displayLabels.furnaceDisplay,
            playerCount
        );

        await interaction.update({
            components: updateComponentsV2AfterSeparator(interaction, [container]),
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleAllianceSelection');
    }
}

/**
 * Handle furnace filter button click
 */
async function handleFurnaceFilterButton(interaction) {
    const { lang, adminData } = getAdminLang(interaction.user.id);

    try {
        const parts = interaction.customId.split('_');
        const userId = parts[3];
        const encodedSelection = parts[4];

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        const currentSelection = decodeExportSelection(encodedSelection);

        const uniqueFurnaceLevels = getUniqueFurnaceLevels(adminData);
        const fcMainLevels = getMainFurnaceLevels(uniqueFurnaceLevels);

        const selectMenuComponents = createPaginatedSelectMenu({
            items: fcMainLevels,
            itemsPerPage: 24,
            currentPage: 0,
            customIdBase: 'export_furnace_select',
            userId: userId,
            encodedSelection: encodedSelection,
            lang: lang,
            labelFn: (level) => getFurnaceReadable(level),
            valueFn: (level) => level.toString(),
            selectedValues: (currentSelection.furnaceLevels || []).map(l => l.toString()),
            allOption: {
                label: lang.players.export.selectMenu.furnaceFilter.all,
                value: 'all'
            },
            feature: 'export_furnace',
            placeholder: lang.players.export.selectMenu.furnaceFilter.placeholder
        });

        const playerCount = getFilteredPlayerCount(currentSelection, adminData);
        const displayLabels = generateFilterDisplayLabels(currentSelection, lang);

        const container = buildExportContainer(
            interaction,
            lang,
            encodedSelection,
            displayLabels.stateDisplay,
            displayLabels.allianceDisplay,
            displayLabels.furnaceDisplay,
            playerCount,
            lang.players.export.content.title.selectFurnace,
            lang.players.export.content.description.selectFurnace,
            selectMenuComponents
        );

        await interaction.update({
            components: updateComponentsV2AfterSeparator(interaction, [container]),
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleFurnaceFilterButton');
    }
}

/**
 * Handle furnace selection from menu
 */
async function handleFurnaceSelection(interaction) {
    const { lang, adminData } = getAdminLang(interaction.user.id);

    try {
        const parts = interaction.customId.split('_');
        const userId = parts[3];
        const encodedSelection = parts[4];

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        const currentSelection = decodeExportSelection(encodedSelection);
        const selectedValues = interaction.values;

        if (selectedValues.includes('all')) {
            currentSelection.furnaceLevels = [];
        } else {
            currentSelection.furnaceLevels = selectedValues.map(v => parseInt(v, 10));
        }

        const newEncoded = encodeExportSelection(currentSelection);
        const playerCount = getFilteredPlayerCount(currentSelection, adminData);
        const displayLabels = generateFilterDisplayLabels(currentSelection, lang);

        const container = buildExportContainer(
            interaction,
            lang,
            newEncoded,
            displayLabels.stateDisplay,
            displayLabels.allianceDisplay,
            displayLabels.furnaceDisplay,
            playerCount
        );

        await interaction.update({
            components: updateComponentsV2AfterSeparator(interaction, [container]),
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, 'handleFurnaceSelection');
    }
}

/**
 * Handle generate CSV button click
 */
async function handleGenerate(interaction) {
    const { lang, adminData } = getAdminLang(interaction.user.id);

    try {
        const parts = interaction.customId.split('_');
        const userId = parts[2];
        const encodedSelection = parts[3];

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        await interaction.deferUpdate();

        const currentSelection = decodeExportSelection(encodedSelection);

        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
        let allianceFilter;

        if (currentSelection.allianceIds && currentSelection.allianceIds.length > 0) {
            allianceFilter = currentSelection.allianceIds;
        } else if (!hasFullAccess) {
            allianceFilter = JSON.parse(adminData?.alliances || '[]');
        }

        const players = playerQueries.getPlayersForExport({
            states: currentSelection.states && currentSelection.states.length > 0 ? currentSelection.states : undefined,
            allianceIds: allianceFilter && allianceFilter.length > 0 ? allianceFilter : undefined,
            furnaceLevels: currentSelection.furnaceLevels && currentSelection.furnaceLevels.length > 0 ? currentSelection.furnaceLevels : undefined
        });

        if (players.length === 0) {
            return await interaction.followUp({
                content: lang.players.export.errors.noPlayers,
                ephemeral: true
            });
        }

        // Generate CSV
        const headers = ['Player ID', 'Alliance Name', 'Player Name', 'Furnace Level', 'State'];
        const rows = players.map(p => [
            p.fid,
            p.alliance_name || '',
            p.nickname || '',
            getFurnaceReadable(p.furnace_level) || 0,
            p.state,
        ]);

        const csvContent = [
            headers.join(','),
            ...rows.map(row => row.map(cell => {
                const str = String(cell);
                return str.includes(',') || str.includes('"') || str.includes('\n')
                    ? `"${str.replace(/"/g, '""')}"`
                    : str;
            }).join(','))
        ].join('\n');

        // Save to file (prepend UTF-8 BOM so Excel on Windows reads characters correctly)
        const tempDir = path.join(__dirname, '../../temp');
        await fs.promises.mkdir(tempDir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `players_export_${timestamp}.csv`;
        const filePath = path.join(tempDir, filename);
        const csvWithBOM = '\uFEFF' + csvContent;
        fs.writeFileSync(filePath, csvWithBOM, 'utf-8');
        const fileBuffer = await fs.promises.readFile(filePath);


        const container = [
            new ContainerBuilder()
                .setAccentColor(0x8e44ad)
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.players.export.content.title.generated}\n` +
                        `${lang.players.export.content.generated.replace('{playerCount}', players.length)}`
                    )
                )
                .addSeparatorComponents(
                    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
                )
                .addFileComponents(
                    new FileBuilder().setURL(`attachment://${filename}`)
                )
        ];

        const content = updateComponentsV2AfterSeparator(interaction, container);
        await interaction.editReply({
            components: content,
            files: [{ attachment: fileBuffer, name: filename }],
            flags: MessageFlags.IsComponentsV2
        });

        // Clean up file after sending
        setTimeout(() => {
            try {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            } catch (e) {
                console.error('Error deleting export file:', e);
            }
        }, 60000); // Delete after 1 minute

    } catch (error) {
        await sendError(interaction, lang, error, 'handleGenerate');
    }
}

/**
 * Handle pagination for state selection
 */
async function handleStatePagination(interaction) {
    const paginationConfig = {
        getItems: (adminData) => getUniqueStates(adminData),
        itemsPerPage: 24,
        customIdBase: 'export_state_select',
        labelFn: (state) => `${state}`,
        valueFn: (state) => state.toString(),
        getSelectedValues: (selection) => (selection.states || []).map(s => s.toString()),
        allOption: (lang) => ({
            label: lang.players.export.selectMenu.stateFilter.all,
            value: 'all'
        }),
        feature: 'export_state',
        placeholder: (lang) => lang.players.export.selectMenu.stateFilter.placeholder,
        headerTitle: (lang) => lang.players.export.content.title.selectStates,
        headerDesc: (lang) => lang.players.export.content.description.selectStates,
        errorContext: 'handleStatePagination'
    };

    await handleGenericPagination(interaction, paginationConfig);
}

/**
 * Handle pagination for alliance selection
 */
async function handleAlliancePagination(interaction) {
    const paginationConfig = {
        getItems: (adminData) => getFilteredAlliances(adminData),
        itemsPerPage: 24,
        customIdBase: 'export_alliance_select',
        labelFn: (alliance) => alliance.name,
        valueFn: (alliance) => alliance.id.toString(),
        getSelectedValues: (selection) => (selection.allianceIds || []).map(id => id.toString()),
        allOption: (lang) => ({
            label: lang.players.export.selectMenu.allianceFilter.all,
            value: 'all'
        }),
        feature: 'export_alliance',
        placeholder: (lang) => lang.players.export.selectMenu.allianceFilter.placeholder,
        headerTitle: (lang) => lang.players.export.content.title.selectAlliances,
        headerDesc: (lang) => lang.players.export.content.description.selectAlliances,
        errorContext: 'handleAlliancePagination'
    };

    await handleGenericPagination(interaction, paginationConfig);
}

/**
 * Handle pagination for furnace selection
 */
async function handleFurnacePagination(interaction) {
    const paginationConfig = {
        getItems: (adminData) => {
            const uniqueLevels = getUniqueFurnaceLevels(adminData);
            return getMainFurnaceLevels(uniqueLevels);
        },
        itemsPerPage: 24,
        customIdBase: 'export_furnace_select',
        labelFn: (level) => getFurnaceReadable(level),
        valueFn: (level) => level.toString(),
        getSelectedValues: (selection) => (selection.furnaceLevels || []).map(l => l.toString()),
        allOption: (lang) => ({
            label: lang.players.export.selectMenu.furnaceFilter.all,
            value: 'all'
        }),
        feature: 'export_furnace',
        placeholder: (lang) => lang.players.export.selectMenu.furnaceFilter.placeholder,
        headerTitle: (lang) => lang.players.export.content.title.selectFurnace,
        headerDesc: (lang) => lang.players.export.content.description.selectFurnace,
        errorContext: 'handleFurnacePagination'
    };

    await handleGenericPagination(interaction, paginationConfig);
}

/**
 * Get alliances accessible to the admin based on their permissions
 * @param {Object} adminData - Admin data object
 * @returns {Array} Array of accessible alliance IDs or undefined for full access
 */
function getAccessibleAllianceIds(adminData) {
    const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
    if (hasFullAccess) {
        return undefined; // undefined means all alliances
    }
    return JSON.parse(adminData?.alliances || '[]');
}

/**
 * Get filtered alliances based on admin access
 * @param {Object} adminData - Admin data object
 * @returns {Array} Array of alliance objects the admin can access
 */
function getFilteredAlliances(adminData) {
    const allAlliances = allianceQueries.getAllAlliances();
    const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);

    if (hasFullAccess) {
        return allAlliances;
    }

    const assignedAllianceIds = JSON.parse(adminData?.alliances || '[]');
    return allAlliances.filter(a => assignedAllianceIds.includes(a.id));
}

/**
 * Calculate the count of players matching the current filters
 * @param {Object} currentSelection - Current filter selection
 * @param {Object} adminData - Admin data for permission checking
 * @returns {number} Count of matching players
 */
function getFilteredPlayerCount(currentSelection, adminData) {
    const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
    let allianceFilter;

    if (currentSelection.allianceIds && currentSelection.allianceIds.length > 0) {
        allianceFilter = currentSelection.allianceIds;
    } else if (!hasFullAccess) {
        allianceFilter = JSON.parse(adminData?.alliances || '[]');
    }

    return playerQueries.getPlayersForExport({
        states: currentSelection.states && currentSelection.states.length > 0 ? currentSelection.states : undefined,
        allianceIds: allianceFilter && allianceFilter.length > 0 ? allianceFilter : undefined,
        furnaceLevels: currentSelection.furnaceLevels && currentSelection.furnaceLevels.length > 0 ? currentSelection.furnaceLevels : undefined
    }).length;
}

/**
 * Create a single filter button
 * @param {string} filterType - Type of filter (state, alliance, furnace, generate)
 * @param {string} userId - User ID
 * @param {string} encodedSelection - Encoded selection string
 * @param {Object} lang - Language object
 * @param {boolean} disabled - Whether button should be disabled
 * @returns {ButtonBuilder} The configured button
 */
function createFilterButton(filterType, userId, encodedSelection, lang, disabled = false) {
    const buttonConfigs = {
        state: {
            customId: `export_filter_state_${userId}_${encodedSelection}`,
            label: lang.players.export.buttons.state,
            style: ButtonStyle.Secondary,
            emoji: getComponentEmoji(getEmojiMapForAdmin(userId), '1040')
        },
        alliance: {
            customId: `export_filter_alliance_${userId}_${encodedSelection}`,
            label: lang.players.export.buttons.alliance,
            style: ButtonStyle.Secondary,
            emoji: getComponentEmoji(getEmojiMapForAdmin(userId), '1001')
        },
        furnace: {
            customId: `export_filter_furnace_${userId}_${encodedSelection}`,
            label: lang.players.export.buttons.furnace,
            style: ButtonStyle.Secondary,
            emoji: getComponentEmoji(getEmojiMapForAdmin(userId), '1012')
        },
        generate: {
            customId: `export_generate_${userId}_${encodedSelection}`,
            label: lang.players.export.buttons.generate,
            style: ButtonStyle.Success,
            emoji: getComponentEmoji(getEmojiMapForAdmin(userId), '1004')
        }
    };

    const config = buttonConfigs[filterType];
    const button = new ButtonBuilder()
        .setCustomId(config.customId)
        .setLabel(config.label)
        .setStyle(config.style);
    if (config.emoji) {
        try { button.setEmoji(config.emoji); } catch (e) { /* ignore invalid emoji */ }
    }

    if (disabled) {
        try { button.setDisabled(true); } catch (e) { /* ignore */ }
    }

    return button;
}

/**
 * Create all filter buttons at once
 * @param {string} userId - User ID
 * @param {string} encodedSelection - Encoded selection string
 * @param {Object} lang - Language object
 * @param {number} playerCount - Count of players (to determine if generate should be disabled)
 * @returns {Object} Object containing all buttons
 */
function createFilterButtons(userId, encodedSelection, lang, playerCount = 1) {
    return {
        state: createFilterButton('state', userId, encodedSelection, lang),
        alliance: createFilterButton('alliance', userId, encodedSelection, lang),
        furnace: createFilterButton('furnace', userId, encodedSelection, lang),
        generate: createFilterButton('generate', userId, encodedSelection, lang, playerCount === 0)
    };
}

/**
 * Create an ActionRow with all filter buttons
 * @param {string} userId - User ID
 * @param {string} encodedSelection - Encoded selection string
 * @param {Object} lang - Language object
 * @param {number} playerCount - Count of players
 * @returns {ActionRowBuilder} Action row with all buttons
 */
function createFilterButtonRow(userId, encodedSelection, lang, playerCount = 1) {
    const buttons = createFilterButtons(userId, encodedSelection, lang, playerCount);
    return new ActionRowBuilder().addComponents(
        buttons.state,
        buttons.alliance,
        buttons.furnace,
        buttons.generate
    );
}

/**
 * Generate display labels for current filters
 * @param {Object} currentSelection - Current filter selection
 * @param {Object} lang - Language object
 * @returns {Object} Object with stateDisplay, allianceDisplay, furnaceDisplay
 */
function generateFilterDisplayLabels(currentSelection, lang) {
    const allLabel = lang.players.export.content.all;

    // State display
    const stateDisplay = currentSelection.states && currentSelection.states.length > 0
        ? currentSelection.states.map(s => `State ${s}`).join(', ')
        : allLabel;

    // Alliance display
    const allianceDisplay = currentSelection.allianceIds && currentSelection.allianceIds.length > 0
        ? allianceQueries.getAllAlliances()
            .filter(a => currentSelection.allianceIds.includes(a.id))
            .map(a => a.name)
            .join(', ')
        : allLabel;

    // Furnace display
    const furnaceDisplay = currentSelection.furnaceLevels && currentSelection.furnaceLevels.length > 0
        ? (() => {
            const rawLabels = currentSelection.furnaceLevels.map(l => getFurnaceReadable(l));
            const mainLabels = rawLabels.map(lbl => {
                if (typeof lbl !== 'string') return String(lbl);
                if (lbl.includes('-')) return lbl.split('-')[0].trim();
                return lbl;
            });
            return [...new Set(mainLabels)].join(', ');
        })()
        : allLabel;

    return { stateDisplay, allianceDisplay, furnaceDisplay };
}

/**
 * Get unique furnace levels available to the admin
 * @param {Object} adminData - Admin data
 * @returns {Array} Sorted array of unique furnace levels
 */
function getUniqueFurnaceLevels(adminData) {
    const alliances = getFilteredAlliances(adminData);
    const allPlayers = [];

    for (const alliance of alliances) {
        const players = playerQueries.getPlayersByAllianceId(alliance.id);
        allPlayers.push(...players);
    }

    return [...new Set(allPlayers.map(p => p.furnace_level))].sort((a, b) => a - b);
}

/**
 * Get unique state values from players the admin can access
 * @param {Object} adminData
 * @returns {Array} Sorted unique state numbers
 */
function getUniqueStates(adminData) {
    const alliances = getFilteredAlliances(adminData);
    const allPlayers = [];

    for (const alliance of alliances) {
        const players = playerQueries.getPlayersByAllianceId(alliance.id);
        allPlayers.push(...players);
    }

    return [...new Set(allPlayers.map(p => p.state))]
        .filter(v => v !== null && v !== undefined)
        .sort((a, b) => a - b);
}

/**
 * Filter furnace levels to only main FC levels (FC 1, FC 2, etc.)
 * @param {Array} furnaceLevels - Array of furnace levels
 * @returns {Array} Filtered array of main FC levels
 */
function getMainFurnaceLevels(furnaceLevels) {
    return furnaceLevels.filter(level => {
        if (!FURNACE_LEVEL_MAPPING[level]) return true; // include unmapped (includes 30)
        const readable = FURNACE_LEVEL_MAPPING[level];
        return (/^FC \d+$/.test(readable));
    });
}

/**
 * Create select menu options for a list of items
 * @param {Array} items - Items to create options for
 * @param {Function} labelFn - Function to get label from item
 * @param {Function} valueFn - Function to get value from item
 * @param {Array} selectedValues - Currently selected values
 * @param {Object} allOption - Optional "All" option configuration
 * @returns {Array} Array of select menu options
 */
function createSelectOptions(items, labelFn, valueFn, selectedValues = [], allOption = null) {
    const options = items.map(item => ({
        label: labelFn(item),
        value: valueFn(item),
        default: selectedValues.includes(valueFn(item))
    }));

    if (allOption) {
        options.unshift({
            label: allOption.label,
            value: allOption.value,
            default: false
        });
    }

    return options;
}

/**
 * Create a paginated select menu with navigation
 * @param {Object} config - Configuration object
 * @returns {Array} Array of ActionRows (select menu + optional pagination)
 */
function createPaginatedSelectMenu(config) {
    const {
        items,
        itemsPerPage,
        currentPage,
        customIdBase,
        userId,
        encodedSelection,
        lang,
        labelFn,
        valueFn,
        selectedValues,
        allOption,
        feature,
        placeholder
    } = config;

    const totalPages = Math.ceil(items.length / itemsPerPage);
    const startIndex = currentPage * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const pageItems = items.slice(startIndex, endIndex);

    const selectOptions = createSelectOptions(pageItems, labelFn, valueFn, selectedValues, allOption);

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`${customIdBase}_${userId}_${encodedSelection}_${currentPage}`)
        .setPlaceholder(placeholder)
        .setMinValues(1)
        .setMaxValues(selectOptions.length)
        .addOptions(selectOptions);

    const components = [new ActionRowBuilder().addComponents(selectMenu)];

    if (totalPages > 1) {
        const paginationRow = createUniversalPaginationButtons({
            feature: feature,
            userId: userId,
            currentPage: currentPage,
            totalPages: totalPages,
            lang: lang,
            contextData: [encodedSelection]
        });
        components.push(paginationRow);
    }

    return components;
}

/**
 * Generic pagination handler
 * @param {Object} interaction - Discord interaction
 * @param {Object} config - Configuration for the specific filter type
 */
async function handleGenericPagination(interaction, config) {
    const { lang, adminData } = getAdminLang(interaction.user.id);

    try {
        const { userId, newPage, contextData } = parsePaginationCustomId(interaction.customId, 1);

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        const encodedSelection = contextData[0];
        const currentSelection = decodeExportSelection(encodedSelection);

        // Get items and create select menu
        const items = config.getItems(adminData, currentSelection);
        const selectMenuComponents = createPaginatedSelectMenu({
            items: items,
            itemsPerPage: config.itemsPerPage,
            currentPage: newPage,
            customIdBase: config.customIdBase,
            userId: userId,
            encodedSelection: encodedSelection,
            lang: lang,
            labelFn: config.labelFn,
            valueFn: config.valueFn,
            selectedValues: config.getSelectedValues(currentSelection),
            allOption: config.allOption(lang),
            feature: config.feature,
            placeholder: config.placeholder(lang)
        });

        // Calculate player count and generate display labels
        const playerCount = getFilteredPlayerCount(currentSelection, adminData);
        const displayLabels = generateFilterDisplayLabels(currentSelection, lang);

        // Build container
        const container = buildExportContainer(
            interaction,
            lang,
            encodedSelection,
            displayLabels.stateDisplay,
            displayLabels.allianceDisplay,
            displayLabels.furnaceDisplay,
            playerCount,
            config.headerTitle(lang),
            config.headerDesc(lang),
            selectMenuComponents
        );

        await interaction.update({
            components: updateComponentsV2AfterSeparator(interaction, [container]),
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await sendError(interaction, lang, error, config.errorContext);
    }
}

module.exports = {
    createExportButton,
    showExportPanel,
    handleStateFilterButton,
    handleStateSelection,
    handleAllianceFilterButton,
    handleAllianceSelection,
    handleFurnaceFilterButton,
    handleFurnaceSelection,
    handleGenerate,
    handleStatePagination,
    handleAlliancePagination,
    handleFurnacePagination
};