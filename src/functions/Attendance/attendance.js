const { ButtonBuilder, ButtonStyle, ActionRowBuilder, ContainerBuilder, MessageFlags, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize } = require('discord.js');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { getUserInfo, assertUserMatches, handleError, hasPermission } = require('../utility/commonFunctions');
const { getEmojiMapForUser, getComponentEmoji } = require('./../utility/emojis');

function createAttendanceManagementButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`attendance_management_${userId}`)
        .setLabel(lang.panel.mainPage.buttons.attendance)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(userId), '1021'));
}

async function handleAttendanceManagementButton(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        const expectedUserId = interaction.customId.split('_')[2];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;
        if (!hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.ATTENDANCE_MANAGEMENT)) {
            return await interaction.reply({ content: lang.common.noPermission, ephemeral: true });
        }
        const { components } = module.exports.createAttendanceContainer(interaction, adminData, lang);
        await interaction.update({ components, flags: MessageFlags.IsComponentsV2 });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleAttendanceManagementButton');
    }
}

function createAttendanceContainer(interaction, adminData, lang) {
    const markButton = new ButtonBuilder()
        .setCustomId(`attendance_mark_${interaction.user.id}`)
        .setLabel(lang.attendance.mainPage.buttons.markAttendance)
        .setStyle(ButtonStyle.Success)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1004'));

    const reportButton = new ButtonBuilder()
        .setCustomId(`attendance_view_reports_${interaction.user.id}`)
        .setLabel(lang.attendance.mainPage.buttons.viewReports)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1026'));

    const backButton = new ButtonBuilder()
        .setCustomId(`back_to_panel_${interaction.user.id}`)
        .setLabel(lang.attendance.mainPage.buttons.backToPanel)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1024'));

    const components = [
        new ContainerBuilder()
            .setAccentColor(2417109)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.attendance.mainPage.content.title}\n` +
                    `${lang.attendance.mainPage.content.description}\n\n` +
                    `${lang.attendance.mainPage.content.markAttendanceField.name}\n` +
                    `${lang.attendance.mainPage.content.markAttendanceField.value}\n\n` +
                    `${lang.attendance.mainPage.content.viewReportsField.name}\n` +
                    `${lang.attendance.mainPage.content.viewReportsField.value}\n`
                )
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            )
            .addActionRowComponents(
                new ActionRowBuilder().addComponents(markButton, reportButton, backButton)
            ),
    ];
    return { components };
}

module.exports = {
    createAttendanceManagementButton,
    handleAttendanceManagementButton,
    createAttendanceContainer
};
