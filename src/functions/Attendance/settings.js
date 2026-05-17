const { ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ActionRowBuilder, ContainerBuilder, MessageFlags, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize } = require('discord.js');
const { attendancePrefQueries } = require('../utility/database');
const { getUserInfo, assertUserMatches, handleError } = require('../utility/commonFunctions');
const { getEmojiMapForUser, getComponentEmoji } = require('./../utility/emojis');

const SORT_OPTIONS = [
    { value: 'points_desc', label: 'By Points', description: 'Present first (points descending), then absent' },
    { value: 'name_asc', label: 'Name A-Z', description: 'Present first (alphabetical), then absent' },
    { value: 'name_asc_all', label: 'Name A-Z (All)', description: 'All players sorted alphabetically' },
    { value: 'last_attended_first', label: 'Last Attended First', description: 'Most recent attendance first' }
];

async function handleAttendanceSettingsButton(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const expectedUserId = interaction.customId.split('_')[2];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        await showSettings(interaction);
    } catch (error) {
        await handleError(interaction, lang, error, 'handleAttendanceSettingsButton');
    }
}

async function showSettings(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    const prefs = attendancePrefQueries.get(interaction.user.id) || { report_type: 'text', sort_preference: 'points_desc' };

    const reportBtn = new ButtonBuilder()
        .setCustomId(`attendance_settings_report_${interaction.user.id}`)
        .setLabel(`Report: ${prefs.report_type === 'text' ? 'Text' : 'Text'}`)
        .setStyle(ButtonStyle.Secondary);

    const sortBtn = new ButtonBuilder()
        .setCustomId(`attendance_settings_sort_${interaction.user.id}`)
        .setLabel(`Sort: ${SORT_OPTIONS.find(s => s.value === prefs.sort_preference)?.label || 'Points'}`)
        .setStyle(ButtonStyle.Secondary);

    const back = new ButtonBuilder()
        .setCustomId(`attendance_management_${interaction.user.id}`)
        .setLabel('Back')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1024'));

    const components = [
        new ContainerBuilder()
            .setAccentColor(2417109)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `### Attendance Settings\nReport type: **${prefs.report_type === 'text' ? 'Text' : 'Text'}**\nSort: **${SORT_OPTIONS.find(s => s.value === prefs.sort_preference)?.label || 'Points'}**`
                )
            )
            .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
            .addActionRowComponents(new ActionRowBuilder().addComponents(reportBtn, sortBtn, back)),
    ];

    await interaction.update({ components, flags: MessageFlags.IsComponentsV2 });
}

async function handleSettingsSortSelect(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const expectedUserId = interaction.customId.split('_')[3];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const sortPref = interaction.values[0];
        const current = attendancePrefQueries.get(interaction.user.id) || { report_type: 'text', sort_preference: 'points_desc' };
        attendancePrefQueries.upsert(interaction.user.id, current.report_type, sortPref);
        await showSettings(interaction);
    } catch (error) {
        await handleError(interaction, lang, error, 'handleSettingsSortSelect');
    }
}

async function handleSettingsSortButton(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const expectedUserId = interaction.customId.split('_')[3];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const select = new StringSelectMenuBuilder()
            .setCustomId(`attendance_settings_sort_select_${interaction.user.id}`)
            .setPlaceholder('Select sort order')
            .addOptions(SORT_OPTIONS.map(o =>
                new StringSelectMenuOptionBuilder().setLabel(o.label).setValue(o.value).setDescription(o.description)
            ));

        const components = [
            new ContainerBuilder()
                .setAccentColor(2417109)
                .addTextDisplayComponents(new TextDisplayBuilder().setContent('Choose sort order for attendance reports:'))
                .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
                .addActionRowComponents(new ActionRowBuilder().addComponents(select)),
        ];

        await interaction.update({ components, flags: MessageFlags.IsComponentsV2 });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleSettingsSortButton');
    }
}

module.exports = {
    handleAttendanceSettingsButton,
    handleSettingsSortButton,
    handleSettingsSortSelect,
    SORT_OPTIONS
};
