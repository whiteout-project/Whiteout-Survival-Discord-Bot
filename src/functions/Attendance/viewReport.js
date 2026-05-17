const { ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ActionRowBuilder, ContainerBuilder, MessageFlags, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize } = require('discord.js');
const { allianceQueries, attendanceQueries, attendancePrefQueries, systemLogQueries } = require('../utility/database');
const { getUserInfo, assertUserMatches, handleError, hasPermission } = require('../utility/commonFunctions');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { getEmojiMapForUser, getComponentEmoji } = require('./../utility/emojis');

const SORT_OPTIONS = [
    { value: 'points_desc', fn: (records) => [...records].sort((a, b) => {
        if (a.status === 'present' && b.status !== 'present') return -1;
        if (a.status !== 'present' && b.status === 'present') return 1;
        return (b.points || 0) - (a.points || 0);
    })},
    { value: 'name_asc', fn: (records) => {
        const p = records.filter(r => r.status === 'present').sort((a, b) => (a.player_name || '').localeCompare(b.player_name || ''));
        const a = records.filter(r => r.status !== 'present').sort((a, b) => (a.player_name || '').localeCompare(b.player_name || ''));
        return [...p, ...a];
    }},
    { value: 'name_asc_all', fn: (records) => [...records].sort((a, b) => (a.player_name || '').localeCompare(b.player_name || ''))},
    { value: 'last_attended_first', fn: (records) => [...records].sort((a, b) => {
        if (a.status === 'present' && b.status !== 'present') return -1;
        if (a.status !== 'present' && b.status === 'present') return 1;
        return (b.points || 0) - (a.points || 0);
    })}
];

function getSorted(records, sortPref) {
    const opt = SORT_OPTIONS.find(s => s.value === sortPref) || SORT_OPTIONS[0];
    return opt.fn(records);
}

async function handleViewReportsButton(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        const expectedUserId = interaction.customId.split('_')[3];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
        let alliances;
        if (hasFullAccess) alliances = allianceQueries.getAllAlliances();
        else {
            const assignedIds = JSON.parse(adminData.alliances || '[]');
            alliances = allianceQueries.getAllAlliances().filter(a => assignedIds.includes(a.id));
        }
        if (!alliances.length) return await interaction.reply({ content: lang.attendance.viewReports.errors.noAlliances, ephemeral: true });

        const select = new StringSelectMenuBuilder()
            .setCustomId(`attendance_report_select_${interaction.user.id}`)
            .setPlaceholder(lang.attendance.viewReports.selectMenu.allianceSelect.placeholder)
            .addOptions(alliances.map(a => new StringSelectMenuOptionBuilder().setLabel(a.name).setValue(String(a.id))));

        const back = new ButtonBuilder()
            .setCustomId(`attendance_management_${interaction.user.id}`)
            .setLabel(lang.attendance.viewReports.buttons.backToAllianceSelect)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1024'));

        const components = [new ContainerBuilder().setAccentColor(2417109)
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${lang.attendance.viewReports.content.title.selectAlliance}\n${lang.attendance.viewReports.content.description.selectAlliance}`))
            .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
            .addActionRowComponents(new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(back))];

        await interaction.update({ components, flags: MessageFlags.IsComponentsV2 });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleViewReportsButton');
    }
}

async function handleReportSelect(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const expectedUserId = interaction.customId.split('_')[3];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;
        const allianceId = parseInt(interaction.values[0], 10);
        const alliance = allianceQueries.getAllianceById(allianceId);
        if (!alliance) return await interaction.reply({ content: lang.common.error, ephemeral: true });

        const sessions = attendanceQueries.getRecentSessions(allianceId);
        if (!sessions || !sessions.length) {
            const back = new ButtonBuilder().setCustomId(`attendance_view_reports_${interaction.user.id}`).setLabel('Back').setStyle(ButtonStyle.Secondary);
            return await interaction.update({ components: [new ContainerBuilder().setAccentColor(15158332)
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${lang.attendance.viewReports.content.title.noData}\n${lang.attendance.viewReports.content.description.noData}`))
                .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
                .addActionRowComponents(new ActionRowBuilder().addComponents(back))], flags: MessageFlags.IsComponentsV2 });
        }

        const select = new StringSelectMenuBuilder()
            .setCustomId(`attendance_report_session_${interaction.user.id}_${allianceId}`)
            .setPlaceholder(lang.attendance.viewReports.selectMenu.sessionSelect.placeholder)
            .addOptions(sessions.map(s => {
                const eventLabel = lang.attendance.markAttendance.eventTypes[s.event_type || 'Other'] || '\u{1F4CB} ' + (s.event_type || 'Other');
                return new StringSelectMenuOptionBuilder()
                    .setLabel(s.session_name + ' (' + eventLabel + ')')
                    .setValue(s.id)
                    .setDescription('Records: ' + (s.record_count || 0) + ' | ' + (s.event_date || ''));
            }))

        const components = [new ContainerBuilder().setAccentColor(2417109)
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${lang.attendance.viewReports.content.title.selectSession}\n${lang.attendance.viewReports.content.description.selectSession}`))
            .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
            .addActionRowComponents(new ActionRowBuilder().addComponents(select))];

        await interaction.update({ components, flags: MessageFlags.IsComponentsV2 });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleReportSelect');
    }
}

async function handleSessionSelect(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const parts = interaction.customId.split('_');
        const expectedUserId = parts[3];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;
        const allianceId = parseInt(parts[4], 10);
        const sessionId = interaction.values[0];
        const alliance = allianceQueries.getAllianceById(allianceId);
        const session = attendanceQueries.getSession(sessionId);
        if (!alliance || !session) return await interaction.reply({ content: lang.common.error, ephemeral: true });

        const prefs = attendancePrefQueries.get(interaction.user.id) || { sort_preference: 'points_desc' };
        const records = getSorted(attendanceQueries.getRecords(sessionId), prefs.sort_preference);
        const present = records.filter(r => r.status === 'present').length;
        const absent = records.filter(r => r.status === 'absent').length;
        const total = records.length;

        const playerLines = records.map(r => {
            const status = r.status === 'present' ? lang.attendance.viewReports.content.present
                : r.status === 'absent' ? lang.attendance.viewReports.content.absent
                : lang.attendance.viewReports.content.notRecorded;
            const pts = r.points ? ` (${r.points}pts)` : '';
            return `- **${r.player_name || `ID:${r.player_id}`}** — ${status}${pts}`;
        }).join('\n');

        const eventLabel = lang.attendance.markAttendance.eventTypes[session.event_type] || `📋 ${session.event_type || 'Other'}`;
        const eventStr = session.event_subtype ? `${eventLabel} (${session.event_subtype})` : eventLabel;

        const back = new ButtonBuilder()
            .setCustomId(`attendance_view_reports_${interaction.user.id}`)
            .setLabel(lang.attendance.viewReports.buttons.backToAllianceSelect)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1024'));

        const editBtn = new ButtonBuilder()
            .setCustomId(`attendance_edit_session_${interaction.user.id}_${sessionId}`)
            .setLabel(lang.attendance.viewReports.buttons.edit)
            .setStyle(ButtonStyle.Secondary);

        const components = [new ContainerBuilder().setAccentColor(2417109)
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                `${lang.attendance.viewReports.content.title.report.replace('{allianceName}', alliance.name)}\nSession: **${session.session_name}** — ${eventStr}\nDate: **${session.event_date || lang.attendance.viewReports.content.notSet}**\n\n` +
                `${lang.attendance.viewReports.content.summaryField.value.replace('{present}', present).replace('{total}', total).replace('{absent}', absent)}\n\n${playerLines || lang.attendance.viewReports.content.noPlayers}`
            ))
            .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
            .addActionRowComponents(new ActionRowBuilder().addComponents(editBtn, back))];

        try { systemLogQueries.addLog('attendance', 'view_report', JSON.stringify({ sessionId, allianceId, userId: interaction.user.id })); } catch (_) {}

        await interaction.update({ components, flags: MessageFlags.IsComponentsV2 });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleSessionSelect');
    }
}

module.exports = { handleViewReportsButton, handleReportSelect, handleSessionSelect, SORT_OPTIONS };
