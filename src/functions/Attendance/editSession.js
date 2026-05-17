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
        .setLabel(lang.attendance.editSession.buttons.rename)
        .setStyle(ButtonStyle.Secondary);

    const dateBtn = new ButtonBuilder()
        .setCustomId(`attendance_edit_date_${interaction.user.id}_${sessionId}`)
        .setLabel(lang.attendance.editSession.buttons.editDate)
        .setStyle(ButtonStyle.Secondary);

    const editMarksBtn = new ButtonBuilder()
        .setCustomId(`attendance_edit_marks_${interaction.user.id}_${sessionId}`)
        .setLabel(lang.attendance.editSession.buttons.editMarks)
        .setStyle(ButtonStyle.Primary);

    const deleteBtn = new ButtonBuilder()
        .setCustomId(`attendance_edit_delete_${interaction.user.id}_${sessionId}`)
        .setLabel(lang.attendance.editSession.buttons.delete)
        .setStyle(ButtonStyle.Danger);

    const back = new ButtonBuilder()
        .setCustomId(`attendance_view_reports_${interaction.user.id}`)
        .setLabel(lang.attendance.editSession.buttons.back)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1024'));

    const eventSelect = new StringSelectMenuBuilder()
        .setCustomId(`attendance_edit_event_${interaction.user.id}_${sessionId}`)
        .setPlaceholder(lang.attendance.editSession.selectMenu.eventType.placeholder)
        .addOptions(EVENT_TYPES.map(et => new StringSelectMenuOptionBuilder().setLabel(lang.attendance.markAttendance.eventTypes[et] || `📋 ${et}`).setValue(et).setDefault(et === session.event_type)));

    const rows = [new ActionRowBuilder().addComponents(renameBtn, dateBtn, back)];
    rows.push(new ActionRowBuilder().addComponents(eventSelect));
    if (LEGION_EVENTS.includes(session.event_type)) {
        const legionValues = ['Not Set', 'Legion 1', 'Legion 2'];
        const legionLabels = [lang.attendance.editSession.selectMenu.legion.notSet, lang.attendance.markAttendance.legionOptions.legion1, lang.attendance.markAttendance.legionOptions.legion2];
        const legionOpts = legionLabels.map((l, i) =>
            new StringSelectMenuOptionBuilder().setLabel(l).setValue(legionValues[i]).setDefault(legionValues[i] === (session.event_subtype || 'Not Set'))
        );
        rows.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`attendance_edit_legion_${interaction.user.id}_${sessionId}`)
                .setPlaceholder(lang.attendance.editSession.selectMenu.legion.placeholder)
                .addOptions(legionOpts)
        ));
    }
    rows.push(new ActionRowBuilder().addComponents(editMarksBtn));
    rows.push(new ActionRowBuilder().addComponents(deleteBtn));

    const editEventLabel = lang.attendance.markAttendance.eventTypes[session.event_type] || `📋 ${session.event_type}`;
    const editEventStr = session.event_subtype ? `${editEventLabel} (${session.event_subtype})` : editEventLabel;
    const components = [
        new ContainerBuilder()
            .setAccentColor(2417109)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.attendance.editSession.content.title}\n${lang.attendance.editSession.content.sessionInfo.replace('{name}', session.session_name).replace('{event}', editEventStr).replace('{date}', session.event_date || lang.attendance.editSession.content.notSet)}`
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
            .setTitle(lang.attendance.editSession.modal.rename.title)
            .addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('session_name')
                        .setLabel(lang.attendance.editSession.modal.rename.label)
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
        if (!name) return await interaction.reply({ content: lang.attendance.editSession.errors.nameEmpty, ephemeral: true });

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
            .setTitle(lang.attendance.editSession.modal.date.title)
            .addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('event_date')
                        .setLabel(lang.attendance.editSession.modal.date.label)
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
            return await interaction.reply({ content: lang.attendance.editSession.errors.invalidDate, ephemeral: true });
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
            .setLabel(lang.attendance.editSession.confirmDelete.confirm)
            .setStyle(ButtonStyle.Danger);

        const cancel = new ButtonBuilder()
            .setCustomId(`attendance_edit_delete_cancel_${interaction.user.id}_${sessionId}`)
            .setLabel(lang.attendance.editSession.confirmDelete.cancel)
            .setStyle(ButtonStyle.Secondary);

        const components = [
            new ContainerBuilder()
                .setAccentColor(15158332)
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(`${lang.attendance.editSession.confirmDelete.title}\n${lang.attendance.editSession.confirmDelete.description}`)
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
        .setLabel(lang.attendance.editMarks.buttons.back)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1024'));

    rows.push(new ActionRowBuilder().addComponents(back));

    const editMarksEventLabel = lang.attendance.markAttendance.eventTypes[session.event_type] || `📋 ${session.event_type}`;
    const editMarksEventStr = session.event_subtype ? `${editMarksEventLabel} (${session.event_subtype})` : editMarksEventLabel;
    const summary = lang.attendance.editMarks.content.summary.replace('{present}', present).replace('{total}', total).replace('{absent}', absent);

    const components = [new ContainerBuilder().setAccentColor(2417109)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `${lang.attendance.editMarks.content.title.replace('{sessionName}', session.session_name)}\n${lang.attendance.editMarks.content.eventInfo.replace('{eventType}', editMarksEventStr)}\n${lang.attendance.editMarks.content.dateInfo.replace('{date}', session.event_date || lang.attendance.editMarks.content.notSet)}\n\n${summary}`
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
            .setTitle(lang.attendance.editMarks.modal.editMark.title)
            .addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('points')
                        .setLabel(lang.attendance.editMarks.modal.editMark.points.label)
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
