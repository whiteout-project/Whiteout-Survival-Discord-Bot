const { ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ActionRowBuilder, ContainerBuilder, MessageFlags, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { allianceQueries, attendanceQueries, systemLogQueries } = require('../utility/database');
const { getUserInfo, assertUserMatches, handleError } = require('../utility/commonFunctions');
const { getEmojiMapForUser, getComponentEmoji } = require('./../utility/emojis');

const EVENT_TYPES = ['Foundry', 'Canyon Clash', 'Crazy Joe', 'Bear Trap', 'Castle Battle', 'Frostdragon Tyrant', 'Other'];
const LEGION_EVENTS = ['Foundry', 'Canyon Clash'];
const { parsePoints } = require('./marking');

async function handleEditSessionButton(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const parts = interaction.customId.split('_');
        const expectedUserId = parts[3];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const sessionId = parts[4];
        await showEditScreen(interaction, sessionId);
    } catch (error) {
        await handleError(interaction, lang, error, 'handleEditSessionButton');
    }
}

async function showEditScreen(interaction, sessionId) {
    const { lang } = getUserInfo(interaction.user.id);
    const session = attendanceQueries.getSession(sessionId);
    if (!session) return await interaction.reply({ content: lang.common.error, ephemeral: true });

    const renameBtn = new ButtonBuilder()
        .setCustomId(`attendance_edit_rename_${interaction.user.id}_${sessionId}`)
        .setLabel('Rename Session')
        .setStyle(ButtonStyle.Secondary);

    const dateBtn = new ButtonBuilder()
        .setCustomId(`attendance_edit_date_${interaction.user.id}_${sessionId}`)
        .setLabel('Edit Date')
        .setStyle(ButtonStyle.Secondary);

    const eventSelect = new StringSelectMenuBuilder()
        .setCustomId(`attendance_edit_event_${interaction.user.id}_${sessionId}`)
        .setPlaceholder('Change event type')
        .addOptions(EVENT_TYPES.map(et =>
            new StringSelectMenuOptionBuilder().setLabel(et).setValue(et).setDefault(et === session.event_type)
        ));

    const editMarksBtn = new ButtonBuilder()
        .setCustomId(`attendance_edit_marks_${interaction.user.id}_${sessionId}`)
        .setLabel('Edit Marks')
        .setStyle(ButtonStyle.Primary);

    const deleteBtn = new ButtonBuilder()
        .setCustomId(`attendance_edit_delete_${interaction.user.id}_${sessionId}`)
        .setLabel('Delete Event')
        .setStyle(ButtonStyle.Danger);

    const back = new ButtonBuilder()
        .setCustomId(`attendance_view_reports_${interaction.user.id}`)
        .setLabel('Back')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1024'));

    const rows = [new ActionRowBuilder().addComponents(renameBtn, dateBtn, back)];
    rows.push(new ActionRowBuilder().addComponents(eventSelect));
    if (LEGION_EVENTS.includes(session.event_type)) {
        const legionOpts = ['Not Set', 'Legion 1', 'Legion 2'].map(l =>
            new StringSelectMenuOptionBuilder().setLabel(l).setValue(l).setDefault(l === (session.event_subtype || 'Not Set'))
        );
        rows.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`attendance_edit_legion_${interaction.user.id}_${sessionId}`)
                .setPlaceholder('Change legion')
                .addOptions(legionOpts)
        ));
    }
    rows.push(new ActionRowBuilder().addComponents(editMarksBtn));
    rows.push(new ActionRowBuilder().addComponents(deleteBtn));

    const eventLabel = session.event_subtype ? `${session.event_type} (${session.event_subtype})` : session.event_type;
    const components = [
        new ContainerBuilder()
            .setAccentColor(2417109)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `### Edit Session\n**Name:** ${session.session_name}\n**Event:** ${eventLabel}\n**Date:** ${session.event_date || 'Not set'}`
                )
            )
            .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
            .addActionRowComponents(...rows),
    ];

    await interaction.update({ components, flags: MessageFlags.IsComponentsV2 });
}

async function handleEditRename(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const parts = interaction.customId.split('_');
        const expectedUserId = parts[3];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;
        const sessionId = parts[4];
        const session = attendanceQueries.getSession(sessionId);
        if (!session) return await interaction.reply({ content: lang.common.error, ephemeral: true });

        const modal = new ModalBuilder()
            .setCustomId(`attendance_edit_rename_modal_${interaction.user.id}_${sessionId}`)
            .setTitle('Rename Session')
            .addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('session_name')
                        .setLabel('New session name')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                        .setMaxLength(50)
                        .setValue(session.session_name)
                )
            );
        await interaction.showModal(modal);
    } catch (error) {
        await handleError(interaction, lang, error, 'handleEditRename');
    }
}

async function handleEditRenameModal(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const parts = interaction.customId.split('_');
        const expectedUserId = parts[4];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;
        const sessionId = parts[5];
        const name = interaction.fields.getTextInputValue('session_name').trim();
        if (!name) return await interaction.reply({ content: 'Name cannot be empty.', ephemeral: true });

        const session = attendanceQueries.getSession(sessionId);
        if (!session) return await interaction.reply({ content: lang.common.error, ephemeral: true });
        attendanceQueries.updateSession(sessionId, name, session.event_type, session.event_subtype, session.event_date);
        await showEditScreen(interaction, sessionId);
    } catch (error) {
        await handleError(interaction, lang, error, 'handleEditRenameModal');
    }
}

async function handleEditDate(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const parts = interaction.customId.split('_');
        const expectedUserId = parts[3];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;
        const sessionId = parts[4];
        const session = attendanceQueries.getSession(sessionId);

        const modal = new ModalBuilder()
            .setCustomId(`attendance_edit_date_modal_${interaction.user.id}_${sessionId}`)
            .setTitle('Edit Event Date/Time')
            .addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('event_date')
                        .setLabel('Date (YYYY-MM-DD HH:MM)')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false)
                        .setMaxLength(16)
                        .setValue(session?.event_date || '')
                )
            );
        await interaction.showModal(modal);
    } catch (error) {
        await handleError(interaction, lang, error, 'handleEditDate');
    }
}

async function handleEditDateModal(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const parts = interaction.customId.split('_');
        const expectedUserId = parts[4];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;
        const sessionId = parts[5];
        const raw = interaction.fields.getTextInputValue('event_date')?.trim();
        const session = attendanceQueries.getSession(sessionId);
        if (!session) return await interaction.reply({ content: lang.common.error, ephemeral: true });

        if (raw && !/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(raw)) {
            return await interaction.reply({ content: 'Invalid format. Use YYYY-MM-DD or YYYY-MM-DD HH:MM.', ephemeral: true });
        }
        const date = raw || session.event_date;
        attendanceQueries.updateSession(sessionId, session.session_name, session.event_type, session.event_subtype, date);
        await showEditScreen(interaction, sessionId);
    } catch (error) {
        await handleError(interaction, lang, error, 'handleEditDateModal');
    }
}

async function handleEditEventSelect(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const parts = interaction.customId.split('_');
        const expectedUserId = parts[3];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;
        const sessionId = parts[4];
        const eventType = interaction.values[0];
        const session = attendanceQueries.getSession(sessionId);
        if (!session) return await interaction.reply({ content: lang.common.error, ephemeral: true });

        attendanceQueries.updateSession(sessionId, session.session_name, eventType, LEGION_EVENTS.includes(eventType) ? session.event_subtype : null, session.event_date);
        await showEditScreen(interaction, sessionId);
    } catch (error) {
        await handleError(interaction, lang, error, 'handleEditEventSelect');
    }
}

async function handleEditLegionSelect(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const parts = interaction.customId.split('_');
        const expectedUserId = parts[3];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;
        const sessionId = parts[4];
        const legion = interaction.values[0] === 'Not Set' ? null : interaction.values[0];
        const session = attendanceQueries.getSession(sessionId);
        if (!session) return await interaction.reply({ content: lang.common.error, ephemeral: true });

        attendanceQueries.updateSession(sessionId, session.session_name, session.event_type, legion, session.event_date);
        await showEditScreen(interaction, sessionId);
    } catch (error) {
        await handleError(interaction, lang, error, 'handleEditLegionSelect');
    }
}

async function handleEditDelete(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const parts = interaction.customId.split('_');
        const expectedUserId = parts[3];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;
        const sessionId = parts[4];

        const confirm = new ButtonBuilder()
            .setCustomId(`attendance_edit_delete_confirm_${interaction.user.id}_${sessionId}`)
            .setLabel('Confirm Delete')
            .setStyle(ButtonStyle.Danger);

        const cancel = new ButtonBuilder()
            .setCustomId(`attendance_edit_delete_cancel_${interaction.user.id}_${sessionId}`)
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary);

        const components = [
            new ContainerBuilder()
                .setAccentColor(15158332)
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent('**Confirm Delete**\nAre you sure? This cannot be undone.')
                )
                .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
                .addActionRowComponents(new ActionRowBuilder().addComponents(confirm, cancel)),
        ];

        await interaction.update({ components, flags: MessageFlags.IsComponentsV2 });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleEditDelete');
    }
}

async function handleEditDeleteConfirm(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const parts = interaction.customId.split('_');
        const expectedUserId = parts[4];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;
        const sessionId = parts[5];

        attendanceQueries.deleteSession(sessionId);
        try { systemLogQueries.addLog('attendance', 'session_deleted', JSON.stringify({ sessionId, userId: interaction.user.id })); } catch (_) {}

        const { components } = require('./attendance').createAttendanceContainer(interaction, null, lang);
        await interaction.update({ components, flags: MessageFlags.IsComponentsV2 });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleEditDeleteConfirm');
    }
}

async function handleEditDeleteCancel(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const parts = interaction.customId.split('_');
        const expectedUserId = parts[4];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;
        const sessionId = parts[5];
        await showEditScreen(interaction, sessionId);
    } catch (error) {
        await handleError(interaction, lang, error, 'handleEditDeleteCancel');
    }
}

async function handleEditMarks(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const parts = interaction.customId.split('_');
        const expectedUserId = parts[3];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;
        const sessionId = parts[4];
        const session = attendanceQueries.getSession(sessionId);
        if (!session) return await interaction.reply({ content: lang.common.error, ephemeral: true });
        const players = attendanceQueries.getPlayersByAlliance(session.alliance_id);
        await renderEditMarksUI(interaction, sessionId, session, players);
    } catch (error) {
        await handleError(interaction, lang, error, 'handleEditMarks');
    }
}

async function renderEditMarksUI(interaction, sessionId, session, players) {
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
            .setCustomId(`attendance_edit_mark_toggle_${interaction.user.id}_${sessionId}_${p.fid}`)
            .setLabel(`${p.nickname || `ID:${p.fid}`}${pts ? ` (${pts}pts)` : ''}`)
            .setStyle(isPresent ? ButtonStyle.Success : ButtonStyle.Danger)
            .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), isPresent ? '1004' : '1050'));
    });

    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));

    const back = new ButtonBuilder()
        .setCustomId(`attendance_edit_session_${interaction.user.id}_${sessionId}`)
        .setLabel('Back')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1024'));

    rows.push(new ActionRowBuilder().addComponents(back));

    const eventLabel = session.event_subtype ? `${session.event_type} (${session.event_subtype})` : session.event_type;
    const summary = `Present: **${present}/${total}** | Absent: **${absent}**`;

    const components = [new ContainerBuilder().setAccentColor(2417109)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `### Edit Marks — ${session.session_name}\n**Event:** ${eventLabel}\n**Date:** ${session.event_date || 'Not set'}\n\n${summary}`
        ))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addActionRowComponents(...rows)];

    await interaction.update({ components, flags: MessageFlags.IsComponentsV2 });
}

async function handleEditMarkToggle(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const parts = interaction.customId.split('_');
        const expectedUserId = parts[4];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;
        const sessionId = parts[5];
        const playerId = parseInt(parts[6], 10);
        const records = attendanceQueries.getRecords(sessionId);
        const rec = records.find(r => r.player_id === playerId);

        const modal = new ModalBuilder()
            .setCustomId(`attendance_edit_mark_modal_${interaction.user.id}_${sessionId}_${playerId}`)
            .setTitle('Edit Player Mark')
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
        await handleError(interaction, lang, error, 'handleEditMarkToggle');
    }
}

async function handleEditMarkModal(interaction) {
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
        const players = attendanceQueries.getPlayersByAlliance(session?.alliance_id);
        await renderEditMarksUI(interaction, sessionId, session, players);
        try { systemLogQueries.addLog('attendance', 'edit_mark_toggle', JSON.stringify({ sessionId, playerId, status: newStatus, points: adjustedPoints, userId: interaction.user.id })); } catch (_) {}
    } catch (error) {
        await handleError(interaction, lang, error, 'handleEditMarkModal');
    }
}

module.exports = {
    handleEditSessionButton,
    handleEditRename,
    handleEditRenameModal,
    handleEditDate,
    handleEditDateModal,
    handleEditEventSelect,
    handleEditLegionSelect,
    handleEditDelete,
    handleEditDeleteConfirm,
    handleEditDeleteCancel,
    handleEditMarks,
    handleEditMarkToggle,
    handleEditMarkModal
};
