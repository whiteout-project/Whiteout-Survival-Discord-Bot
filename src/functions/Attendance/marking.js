const { ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ActionRowBuilder, ContainerBuilder, MessageFlags, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { allianceQueries, attendanceQueries, systemLogQueries } = require('../utility/database');
const { getUserInfo, assertUserMatches, handleError, hasPermission } = require('../utility/commonFunctions');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { getEmojiMapForUser, getComponentEmoji } = require('./../utility/emojis');
const crypto = require('crypto');

const EVENT_TYPES = ['Foundry', 'Canyon Clash', 'Crazy Joe', 'Bear Trap', 'Castle Battle', 'Frostdragon Tyrant', 'Other'];
const EVENT_TYPE_ICONS = { Foundry: '🏭', 'Canyon Clash': '⚔️', 'Crazy Joe': '🤪', 'Bear Trap': '🐻', 'Castle Battle': '🏰', 'Frostdragon Tyrant': '🐉', Other: '📋' };
const LEGION_EVENTS = ['Foundry', 'Canyon Clash'];
const PAGE_SIZE = 25;

function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function parsePoints(str) {
    if (!str) return 0;
    const s = str.trim().toUpperCase().replace(/,/g, '');
    if (s.endsWith('M')) return Math.round(parseFloat(s.slice(0,-1)) * 1000000);
    if (s.endsWith('K')) return Math.round(parseFloat(s.slice(0,-1)) * 1000);
    const n = parseInt(s, 10);
    return isNaN(n) ? 0 : n;
}

async function handleMarkAttendanceButton(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        const expectedUserId = interaction.customId.split('_')[2];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
        let alliances;
        if (hasFullAccess) alliances = allianceQueries.getAllAlliances();
        else {
            const assignedIds = JSON.parse(adminData.alliances || '[]');
            alliances = allianceQueries.getAllAlliances().filter(a => assignedIds.includes(a.id));
        }
        if (!alliances.length) return await interaction.reply({ content: lang.attendance.markAttendance.errors.noAlliances, ephemeral: true });
        await showAlliancePage(interaction, alliances, 0);
    } catch (error) {
        await handleError(interaction, lang, error, 'handleMarkAttendanceButton');
    }
}

async function showAlliancePage(interaction, alliances, page) {
    const { lang } = getUserInfo(interaction.user.id);
    const totalPages = Math.ceil(alliances.length / PAGE_SIZE);
    const start = page * PAGE_SIZE;
    const pageItems = alliances.slice(start, start + PAGE_SIZE);

    const select = new StringSelectMenuBuilder()
        .setCustomId(`attendance_mark_select_${interaction.user.id}`)
        .setPlaceholder(`Select alliance... (Page ${page+1}/${totalPages})`)
        .addOptions(pageItems.map(a => new StringSelectMenuOptionBuilder().setLabel(a.name).setValue(String(a.id))));

    const rows = [new ActionRowBuilder().addComponents(select)];
    const navRow = new ActionRowBuilder();
    if (page > 0) navRow.addComponents(new ButtonBuilder().setCustomId(`attendance_mark_page_${interaction.user.id}_${page-1}`).setLabel('◀️ Prev').setStyle(ButtonStyle.Secondary));
    if (page < totalPages - 1) navRow.addComponents(new ButtonBuilder().setCustomId(`attendance_mark_page_${interaction.user.id}_${page+1}`).setLabel('Next ▶️').setStyle(ButtonStyle.Secondary));
    if (navRow.components.length) rows.push(navRow);

    const back = new ButtonBuilder()
        .setCustomId(`attendance_management_${interaction.user.id}`)
        .setLabel(lang.attendance.markAttendance.buttons.back)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1024'));
    rows.push(new ActionRowBuilder().addComponents(back));

    const components = [new ContainerBuilder().setAccentColor(2417109)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${lang.attendance.markAttendance.content.title.selectAlliance}\n${lang.attendance.markAttendance.content.description.selectAlliance}`))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addActionRowComponents(...rows)];

    await interaction.update({ components, flags: MessageFlags.IsComponentsV2 });
}

async function handleAlliancePage(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        const parts = interaction.customId.split('_');
        const expectedUserId = parts[3];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;
        const page = parseInt(parts[4], 10);

        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
        let alliances;
        if (hasFullAccess) alliances = allianceQueries.getAllAlliances();
        else {
            const assignedIds = JSON.parse(adminData.alliances || '[]');
            alliances = allianceQueries.getAllAlliances().filter(a => assignedIds.includes(a.id));
        }
        await showAlliancePage(interaction, alliances, page);
    } catch (error) {
        await handleError(interaction, lang, error, 'handleAlliancePage');
    }
}

async function handleMarkAttendanceSelect(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const expectedUserId = interaction.customId.split('_')[3];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;
        const allianceId = parseInt(interaction.values[0], 10);

        const modal = new ModalBuilder()
            .setCustomId(`attendance_session_modal_${interaction.user.id}_${allianceId}`)
            .setTitle('Session Name')
            .addComponents(
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('session_name').setLabel('Session name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50).setPlaceholder('e.g. Bear Trap Week 12')),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('event_date').setLabel('Date (YYYY-MM-DD HH:MM, optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(16).setPlaceholder('Leave blank for now'))
            );
        await interaction.showModal(modal);
    } catch (error) {
        await handleError(interaction, lang, error, 'handleMarkAttendanceSelect');
    }
}

async function handleSessionModal(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const parts = interaction.customId.split('_');
        const expectedUserId = parts[3];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;
        const allianceId = parseInt(parts[4], 10);
        const sessionName = interaction.fields.getTextInputValue('session_name').trim();
        const raw = interaction.fields.getTextInputValue('event_date')?.trim();
        const eventDate = raw && /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(raw) ? raw : null;
        const sessionId = crypto.randomUUID();

        attendanceQueries.createSession(sessionId, allianceId, sessionName, 'pending', null, eventDate, interaction.user.id);

        const select = new StringSelectMenuBuilder()
            .setCustomId(`attendance_mark_event_${interaction.user.id}_${allianceId}_${sessionId}`)
            .setPlaceholder('Select event type')
            .addOptions(EVENT_TYPES.map(et => new StringSelectMenuOptionBuilder().setLabel(`${EVENT_TYPE_ICONS[et] || '📋'} ${et}`).setValue(et)));

        const back = new ButtonBuilder()
            .setCustomId(`attendance_mark_${interaction.user.id}`)
            .setLabel('Back')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1024'));

        const components = [new ContainerBuilder().setAccentColor(2417109)
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(`### Select Event Type\nSession: **${sessionName}**\nDate: **${eventDate || 'Not set'}**`))
            .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
            .addActionRowComponents(new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(back))];

        await interaction.update({ components, flags: MessageFlags.IsComponentsV2 });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleSessionModal');
    }
}

async function handleEventTypeSelect(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const parts = interaction.customId.split('_');
        const expectedUserId = parts[3];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;
        const allianceId = parseInt(parts[4], 10);
        const sessionId = parts[5];
        const eventType = interaction.values[0];

        if (LEGION_EVENTS.includes(eventType)) {
            attendanceQueries.updateSession(sessionId, attendanceQueries.getSession(sessionId)?.session_name || '', eventType, null, null);
            const select = new StringSelectMenuBuilder()
                .setCustomId(`attendance_mark_legion_${interaction.user.id}_${allianceId}_${sessionId}`)
                .setPlaceholder('Select legion')
                .addOptions([1,2].map(l => new StringSelectMenuOptionBuilder().setLabel(`Legion ${l}`).setValue(`Legion ${l}`)));
            return await interaction.update({ components: [new ContainerBuilder().setAccentColor(2417109)
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(`Select legion for **${EVENT_TYPE_ICONS[eventType] || ''} ${eventType}**:`))
                .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
                .addActionRowComponents(new ActionRowBuilder().addComponents(select))], flags: MessageFlags.IsComponentsV2 });
        }

        attendanceQueries.updateSession(sessionId, attendanceQueries.getSession(sessionId)?.session_name || '', eventType, null, null);
        await showMarkingScreen(interaction, allianceId, sessionId, eventType, null);
    } catch (error) {
        await handleError(interaction, lang, error, 'handleEventTypeSelect');
    }
}

async function handleLegionSelect(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const parts = interaction.customId.split('_');
        const expectedUserId = parts[3];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;
        const allianceId = parseInt(parts[4], 10);
        const sessionId = parts[5];
        const legion = interaction.values[0];
        const session = attendanceQueries.getSession(sessionId);
        attendanceQueries.updateSession(sessionId, session?.session_name || '', session?.event_type || 'Other', legion, null);
        await showMarkingScreen(interaction, allianceId, sessionId, session?.event_type || 'Other', legion);
    } catch (error) {
        await handleError(interaction, lang, error, 'handleLegionSelect');
    }
}

async function showMarkingScreen(interaction, allianceId, sessionId, eventType, eventSubtype) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const session = attendanceQueries.getSession(sessionId);
        if (!session) return await interaction.reply({ content: lang.common.error, ephemeral: true });
        const players = attendanceQueries.getPlayersByAlliance(allianceId);
        if (!players || !players.length) return await interaction.reply({ content: lang.attendance.markAttendance.errors.noPlayers, ephemeral: true });

        for (const p of players) {
            attendanceQueries.upsertRecord(sessionId, p.fid, p.nickname || `ID:${p.fid}`, 'absent', 0, interaction.user.id);
        }

        await renderMarkingUI(interaction, sessionId, session, players, eventType, eventSubtype);
    } catch (error) {
        await handleError(interaction, lang, error, 'showMarkingScreen');
    }
}

async function renderMarkingUI(interaction, sessionId, session, players, eventType, eventSubtype) {
    const { lang } = getUserInfo(interaction.user.id);
    const records = attendanceQueries.getRecords(sessionId);
    const present = attendanceQueries.getPresentCount(sessionId);
    const total = attendanceQueries.getRecordCount(sessionId);
    const absent = attendanceQueries.getAbsentCount(sessionId);

    const buttons = players.map(p => {
        const rec = records.find(r => r.player_id === p.fid);
        const isPresent = rec && rec.status === 'present';
        const pts = rec ? rec.points : 0;
        return new ButtonBuilder()
            .setCustomId(`attendance_mark_toggle_${interaction.user.id}_${sessionId}_${p.fid}`)
            .setLabel(`${p.nickname || `ID:${p.fid}`}${pts ? ` (${pts}pts)` : ''}`)
            .setStyle(isPresent ? ButtonStyle.Success : ButtonStyle.Danger)
            .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), isPresent ? '1004' : '1050'));
    });

    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));

    const selectAll = new ButtonBuilder()
        .setCustomId(`attendance_mark_all_${interaction.user.id}_${sessionId}_present`)
        .setLabel('Select All Present')
        .setStyle(ButtonStyle.Success);
    const clearAll = new ButtonBuilder()
        .setCustomId(`attendance_mark_all_${interaction.user.id}_${sessionId}_absent`)
        .setLabel('All Absent')
        .setStyle(ButtonStyle.Danger);
    const done = new ButtonBuilder()
        .setCustomId(`attendance_mark_done_${interaction.user.id}_${sessionId}`)
        .setLabel('Done')
        .setStyle(ButtonStyle.Primary);

    rows.push(new ActionRowBuilder().addComponents(selectAll, clearAll, done));

    const eventLabel = eventSubtype ? `${EVENT_TYPE_ICONS[eventType] || ''} ${eventType} (${eventSubtype})` : `${EVENT_TYPE_ICONS[eventType] || ''} ${eventType}`;
    const summary = `Present: **${present}/${total}** | Absent: **${absent}**`;

    const components = [new ContainerBuilder().setAccentColor(2417109)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `### Mark Attendance — ${session.session_name}\n**Event:** ${eventLabel}\n**Date:** ${session.event_date || 'Not set'}\n\n${summary}`
        ))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addActionRowComponents(...rows)];

    await interaction.update({ components, flags: MessageFlags.IsComponentsV2 });
}

async function handleMarkToggle(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const parts = interaction.customId.split('_');
        const expectedUserId = parts[3];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;
        const sessionId = parts[4];
        const playerId = parseInt(parts[5], 10);
        const records = attendanceQueries.getRecords(sessionId);
        const rec = records.find(r => r.player_id === playerId);

        const modal = new ModalBuilder()
            .setCustomId(`attendance_mark_toggle_modal_${interaction.user.id}_${sessionId}_${playerId}`)
            .setTitle('Mark Player')
            .addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('points')
                        .setLabel('Points (0 for absent)')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                        .setValue(String(rec?.points ?? 1))
                        .setMaxLength(10)
                )
            );
        await interaction.showModal(modal);
    } catch (error) {
        await handleError(interaction, lang, error, 'handleMarkToggle');
    }
}

async function handleMarkToggleModal(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const parts = interaction.customId.split('_');
        const expectedUserId = parts[4];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;
        const sessionId = parts[5];
        const playerId = parseInt(parts[6], 10);
        const raw = interaction.fields.getTextInputValue('points');
        const pts = parsePoints(raw);
        const safePts = pts < 0 ? 0 : pts;

        const existing = (attendanceQueries.getRecords(sessionId) || []).find(r => r.player_id === playerId);
        const newStatus = existing && existing.status === 'present' ? 'absent' : 'present';
        const adjustedPoints = newStatus === 'present' ? safePts : 0;

        attendanceQueries.upsertRecord(sessionId, playerId, existing?.player_name || `ID:${playerId}`, newStatus, adjustedPoints, interaction.user.id);

        const session = attendanceQueries.getSession(sessionId);
        const allianceId = session?.alliance_id;
        const players = attendanceQueries.getPlayersByAlliance(allianceId);
        await renderMarkingUI(interaction, sessionId, session, players, session?.event_type, session?.event_subtype);
    } catch (error) {
        await handleError(interaction, lang, error, 'handleMarkToggleModal');
    }
}

async function handleMarkAll(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const parts = interaction.customId.split('_');
        const expectedUserId = parts[3];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;
        const sessionId = parts[4];
        const status = parts[5];
        const session = attendanceQueries.getSession(sessionId);
        if (!session) return;
        const players = attendanceQueries.getPlayersByAlliance(session.alliance_id);

        for (const p of players) {
            attendanceQueries.upsertRecord(sessionId, p.fid, p.nickname || `ID:${p.fid}`, status, status === 'present' ? 1 : 0, interaction.user.id);
        }
        await renderMarkingUI(interaction, sessionId, session, players, session?.event_type, session?.event_subtype);
    } catch (error) {
        await handleError(interaction, lang, error, 'handleMarkAll');
    }
}

async function handleDoneMarking(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const parts = interaction.customId.split('_');
        const expectedUserId = parts[3];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;
        const sessionId = parts[4];
        const present = attendanceQueries.getPresentCount(sessionId);
        const total = attendanceQueries.getRecordCount(sessionId);

        try { systemLogQueries.addLog('attendance', 'session_completed', JSON.stringify({ sessionId, present, total, userId: interaction.user.id })); } catch (_) {}

        const { components } = require('./attendance').createAttendanceContainer(interaction, null, lang);
        await interaction.update({ components, flags: MessageFlags.IsComponentsV2 });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleDoneMarking');
    }
}

module.exports = {
    handleMarkAttendanceButton, handleAlliancePage, handleMarkAttendanceSelect, handleSessionModal,
    handleEventTypeSelect, handleLegionSelect, handleMarkToggle, handleMarkToggleModal, handleMarkAll, handleDoneMarking,
    EVENT_TYPES, EVENT_TYPE_ICONS, LEGION_EVENTS, parsePoints
};
