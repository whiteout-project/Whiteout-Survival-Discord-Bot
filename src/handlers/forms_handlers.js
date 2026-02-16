const createAlliance = require('../functions/Alliance/createAlliance');
const editAlliance = require('../functions/Alliance/editAlliance');
const editPriority = require('../functions/Alliance/editPriority');
const addPlayer = require('../functions/Players/addPlayer');
const movePlayers = require('../functions/Players/movePlayers');
const removePlayers = require('../functions/Players/removePlayers');
const giftSetTestId = require('../functions/GiftCode/setTestId');
const addGift = require('../functions/GiftCode/addGift');
const createNotification = require('../functions/Notification/createNotification');
const editNotification = require('../functions/Notification/editNotification');
const notificationEditor = require('../functions/Notification/notificationEditor');
const notificationFields = require('../functions/Notification/notificationFields');
const notificationSettings = require('../functions/Notification/notificationSettings');
const uploadNotification = require('../functions/Notification/uploadNotification');
const emojisCreate = require('../functions/Settings/theme/emojisCreate');
const emojisEditor = require('../functions/Settings/theme/emojisEditor');
const emojisUpload = require('../functions/Settings/theme/emojisImport');
const dbMigration = require('../functions/Settings/migration');
const backUpCreate = require('../functions/Settings/backup/backupCreate');

// === HANDLER REGISTRY ===
const formHandlers = [
    // Alliance modals
    { pattern: /^create_alliance_modal_/, fn: createAlliance.handleCreateAllianceModal },
    { pattern: /^edit_alliance_modal_/, fn: editAlliance.handleEditAllianceModal },
    { pattern: /^priority_custom_modal_/, fn: editPriority.handlePriorityCustomModal },

    // Player modals
    { pattern: /^player_id_modal_/, fn: addPlayer.handlePlayerIdModal },
    { pattern: /^move_players_ids_modal_/, fn: movePlayers.handleMovePlayersIdsModal },
    { pattern: /^remove_players_ids_modal_/, fn: removePlayers.handleRemovePlayersIdsModal },

    // Gift Code modals
    { pattern: /^test_id_modal_/, fn: giftSetTestId.handleTestIdModal },
    { pattern: /^add_gift_modal_/, fn: addGift.handleGiftCodeModal },

    // Notification modals
    { pattern: /^notification_create_/, fn: createNotification.handleCreateNotificationModal },
    { pattern: /^notification_update_message_/, fn: notificationEditor.handleUpdateMessageModal },
    { pattern: /^notification_update_embed_/, fn: notificationEditor.handleUpdateEmbedComponentModal },
    { pattern: /^notification_field_add_modal_/, fn: notificationFields.handleAddFieldModal },
    { pattern: /^notification_field_edit_modal_/, fn: notificationFields.handleEditFieldModal },
    { pattern: /^notification_pattern_custom_modal_/, fn: notificationSettings.handleCustomPatternModal },
    { pattern: /^notification_repeat_custom_modal_/, fn: notificationSettings.handleCustomRepeatModal },
    { pattern: /^notification_update_time_modal_/, fn: notificationSettings.handleUpdateTimeModal },
    { pattern: /^notification_edit_info_modal_/, fn: editNotification.handleInfoModal },
    { pattern: /^template_upload_file_modal_/, fn: uploadNotification.handleFileUploadModalSubmit },
    { pattern: /^template_import_modal_/, fn: uploadNotification.handleImportModalSubmit },
    { pattern: /^emoji_create_modal_/, fn: emojisCreate.handleEmojiCreateModal },
    { pattern: /^emoji_editor_modal_/, fn: emojisEditor.handleEmojiEditorModal },
    { pattern: /^emoji_upload_modal_/, fn: emojisUpload.handleEmojiUploadModal },
    { pattern: /^emoji_upload_rename_modal_/, fn: emojisUpload.handleEmojiUploadRenameModal },
    { pattern: /^db_migration_modal_/, fn: dbMigration.handleDBMigrationModal },
    { pattern: /^db_backup_oauth_modal_/, fn: backUpCreate.handleOAuthModal },
    { pattern: /^db_backup_oauth_code_modal_/, fn: backUpCreate.handleOAuthCodeModal },
];

// === SETUP FUNCTION ===
/**
 * Handles all modal form (ModalSubmit) interactions
 * @param {import('discord.js').Client} client - Discord client instance
 */
function setupFormHandlers(client) {
    const listener = async (interaction) => {
        if (!interaction.isModalSubmit()) return;

        for (const { pattern, fn } of formHandlers) {
            if (pattern.test(interaction.customId)) {
                try {
                    await fn(interaction);
                } catch (error) {
                    console.error(`[FormHandler] Error handling form ${interaction.customId}:`, error);
                    try {
                        const reply = interaction.deferred || interaction.replied
                            ? interaction.followUp.bind(interaction)
                            : interaction.reply.bind(interaction);
                        await reply({ content: 'An error occurred while processing this form.', flags: 64 });
                    } catch (_) { /* interaction may have expired */ }
                }
                return; // stop after first match
            }
        }
    };

    client.on('interactionCreate', listener);

    return () => client.off('interactionCreate', listener);
}

module.exports = setupFormHandlers;
