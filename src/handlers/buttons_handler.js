const settings = require('../functions/Settings/settings');
const language = require('../functions/Settings/language');
const autoClean = require('../functions/Settings/autoClean');
const autoUpdate = require('../functions/Settings/autoUpdate');
const db = require('../functions/Settings/backup/backup');
const dbMigration = require('../functions/Settings/migration');
const backUpCreate = require('../functions/Settings/backup/backupCreate');
const backUpView = require('../functions/Settings/backup/backupView');
const backupRestore = require('../functions/Settings/backup/backupRestore');
const backupReAuth = require('../functions/Settings/backup/backup_reauth');
const emojis = require('../functions/Settings/theme/emojis');
const emojisActivate = require('../functions/Settings/theme/emojisActivate');
const emojisCreate = require('../functions/Settings/theme/emojisCreate');
const emojisEdit = require('../functions/Settings/theme/emojisEdit');
const emojisView = require('../functions/Settings/theme/emojisView');
const emojisExport = require('../functions/Settings/theme/emojisExport');
const emojisUpload = require('../functions/Settings/theme/emojisImport');
const emojisDelete = require('../functions/Settings/theme/emojisDelete');
const emojisEditor = require('../functions/Settings/theme/emojisEditor');
const emojisReload = require('../functions/Settings/theme/emojisReload');
const emojisTemplate = require('../functions/Settings/theme/emojisTemplate');
const panel = require('../functions/Panel/backToPanel');
const alliance = require('../functions/Alliance/Alliance');
const players = require('../functions/Players/players');
const support = require('../functions/Support/support');
const { processRecovery } = require('../functions/Processes/processRecovery');

const addPlayer = require('../functions/Players/addPlayer');
const fetchPlayerData = require('../functions/Players/fetchPlayerData');
const movePlayers = require('../functions/Players/movePlayers');
const removePlayers = require('../functions/Players/removePlayers');
const idChannel = require('../functions/Players/idChannel');
const exportPlayers = require('../functions/Players/export');

const createAlliance = require('../functions/Alliance/createAlliance');
const editAlliance = require('../functions/Alliance/editAlliance');
const deleteAlliance = require('../functions/Alliance/deleteAlliance');
const viewAlliances = require('../functions/Alliance/viewAlliances');
const editPriority = require('../functions/Alliance/editPriority');
const assignAlliance = require('../functions/Alliance/assignAlliance');
const triggerRefresh = require('../functions/Alliance/triggerRefresh');

const admin = require('../functions/Settings/admin');
const giftCode = require('../functions/GiftCode/giftCode');
const giftSetTestId = require('../functions/GiftCode/setTestId');
const addGift = require('../functions/GiftCode/addGift');
const redeemGift = require('../functions/GiftCode/redeemGift');
const removeGift = require('../functions/GiftCode/removeGift');
const autoRedeem = require('../functions/GiftCode/autoRedeem');
const viewGift = require('../functions/GiftCode/viewGift');
const giftCodeChannel = require('../functions/GiftCode/giftCodeChannel');

const notification = require('../functions/Notification/notification');
const createNotification = require('../functions/Notification/createNotification');
const deleteNotification = require('../functions/Notification/deleteNotification');
const editNotification = require('../functions/Notification/editNotification');
const notificationEditor = require('../functions/Notification/notificationEditor');
const notificationMentions = require('../functions/Notification/notificationMentions');
const notificationFields = require('../functions/Notification/notificationFields');
const notificationSettings = require('../functions/Notification/notificationSettings');
const templateLibrary = require('../functions/Notification/templateLibrary');
const shareNotification = require('../functions/Notification/shareNotification');
const uploadNotification = require('../functions/Notification/uploadNotification');


// === HANDLER REGISTRY ===
const buttonHandlers = [
    // Process recovery (bind methods to maintain 'this' context)
    { pattern: /^(resume_process_|resume_crash_)/, fn: processRecovery.handleProcessResume.bind(processRecovery) },
    { pattern: /^(cancel_process_|cancel_crash_)/, fn: processRecovery.handleProcessCancel.bind(processRecovery) },

    // Settings & Panel
    { pattern: /^settings_/, fn: settings.handleSettingsButton },
    { pattern: /^toggle_auto_delete_/, fn: autoClean.handleToggleAutoDelete },
    { pattern: /^auto_update_check_/, fn: autoUpdate.handleAutoUpdateCheck },
    { pattern: /^auto_update_apply_/, fn: autoUpdate.handleAutoUpdateApply },
    { pattern: /^change_language_/, fn: language.handleChangeLanguageButton },
    { pattern: /^back_to_panel_/, fn: panel.handleBackToPanelButton },
    { pattern: /^back_to_settings_/, fn: admin.handleBackToSettingsButton },
    { pattern: /^backup_/, fn: db.handleBackupButton },
    { pattern: /^db_migration_confirm_/, fn: dbMigration.handleDBMigrationConfirm },
    { pattern: /^db_migration_cancel_/, fn: dbMigration.handleDBMigrationCancel },
    { pattern: /^db_migration_button_/, fn: dbMigration.handleDBMigrationButton },
    { pattern: /^db_backup_create_/, fn: backUpCreate.handleBackupCreateButton },
    { pattern: /^db_backup_oauth_guide_back_/, fn: backUpCreate.handleOAuthGuideBackButton },
    { pattern: /^db_backup_oauth_guide_next_/, fn: backUpCreate.handleOAuthGuideNextButton },
    { pattern: /^db_backup_oauth_setup_/, fn: backUpCreate.handleOAuthSetupButton },
    { pattern: /^db_backup_oauth_code_/, fn: backUpCreate.handleOAuthCodeSubmitButton },
    { pattern: /^db_backup_view_/, fn: backUpView.handleBackupViewButton },
    { pattern: /^db_backup_restore_execute_/, fn: backupRestore.handleRestoreExecuteButton },
    { pattern: /^db_backup_restore_confirm_/, fn: backupRestore.handleRestoreConfirmButton },
    { pattern: /^db_backup_restore_cancel_/, fn: backupRestore.handleRestoreCancelButton },
    { pattern: /^db_backup_restore_/, fn: backupRestore.handleBackupRestoreButton },
    { pattern: /^db_backup_reset_oauth_confirm_/, fn: backupReAuth.handleResetOAuthConfirm },
    { pattern: /^db_backup_reset_oauth_cancel_/, fn: backupReAuth.handleResetOAuthCancel },
    { pattern: /^db_backup_reset_oauth_/, fn: backupReAuth.handleResetOAuthButton },
    { pattern: /^emoji_theme_create_/, fn: emojisCreate.handleEmojiCreateButton },
    { pattern: /^emoji_theme_edit_/, fn: emojisEdit.handleEmojiEditButton },
    { pattern: /^pagination_emoji_edit_/, fn: emojisEdit.handleEmojiEditPagination },
    { pattern: /^emoji_theme_view_/, fn: emojisView.handleEmojiViewButton },
    { pattern: /^pagination_emoji_view_/, fn: emojisView.handleEmojiViewPagination },
    { pattern: /^emoji_template_/, fn: emojisTemplate.handleEmojiTemplateButton },
    { pattern: /^emoji_theme_share_/, fn: emojisExport.handleEmojiExportButton },
    { pattern: /^pagination_emoji_export_/, fn: emojisExport.handleEmojiExportPagination },
    { pattern: /^emoji_theme_upload_/, fn: emojisUpload.handleEmojiUploadButton },
    { pattern: /^emoji_upload_rename_/, fn: emojisUpload.handleEmojiUploadRenameButton },
    { pattern: /^emoji_theme_delete_/, fn: emojisDelete.handleEmojiDeleteButton },
    { pattern: /^pagination_emoji_delete_/, fn: emojisDelete.handleEmojiDeletePagination },
    { pattern: /^emoji_delete_confirm_/, fn: emojisDelete.handleEmojiDeleteConfirm },
    { pattern: /^emoji_delete_cancel_/, fn: emojisDelete.handleEmojiDeleteCancel },
    { pattern: /^emoji_editor_open_/, fn: emojisEditor.handleEmojiEditorButton },
    { pattern: /^emoji_editor_(prev|next)_/, fn: emojisEditor.handleEmojiEditorPagination },
    { pattern: /^emoji_theme_activate_/, fn: emojisActivate.handleEmojiActivateButton },
    { pattern: /^emoji_theme_reload_confirm_/, fn: emojisReload.handleEmojiReloadConfirmButton },
    { pattern: /^emoji_theme_reload_/, fn: emojisReload.handleEmojiReloadDefaultButton },
    { pattern: /^emoji_activate_global_/, fn: emojisActivate.handleEmojiActivateChoice },
    { pattern: /^emoji_activate_personal_/, fn: emojisActivate.handleEmojiActivateChoice },
    { pattern: /^pagination_emoji_activate_/, fn: emojisActivate.handleEmojiActivatePagination },
    { pattern: /^emoji_theme_/, fn: emojis.handleEmojiThemeButton },
    { pattern: /^support_/, fn: support.handleSupportButton },

    // Alliance management
    { pattern: /^alliance_management_/, fn: alliance.handleAllianceManagementButton },
    { pattern: /^create_alliance_/, fn: createAlliance.handleCreateAllianceButton },
    { pattern: /^(edit_alliance_prev_|edit_alliance_next_)/, fn: editAlliance.handleEditAlliancePagination },
    { pattern: /^edit_alliance_(?!prev_|next_)/, fn: editAlliance.handleEditAllianceButton },
    { pattern: /^(delete_alliance_prev_|delete_alliance_next_)/, fn: deleteAlliance.handleDeleteAlliancePagination },
    { pattern: /^delete_alliance_(?!prev_|next_)/, fn: deleteAlliance.handleDeleteAllianceButton },
    { pattern: /^confirm_delete_alliance_/, fn: deleteAlliance.handleConfirmDeleteAlliance },
    { pattern: /^approve_delete_alliance_/, fn: deleteAlliance.handleApproveDeleteAlliance },
    { pattern: /^cancel_delete_alliance_/, fn: deleteAlliance.handleCancelDeleteAlliance },
    { pattern: /^deny_delete_alliance_/, fn: deleteAlliance.handleDenyDeleteAlliance },
    { pattern: /^view_alliances_(?!prev_|next_)/, fn: viewAlliances.handleViewAlliancesButton },
    { pattern: /^(view_alliances_prev_|view_alliances_next_)/, fn: viewAlliances.handleViewAlliancesPagination },
    { pattern: /^back_to_priority_select_/, fn: editPriority.handleBackToPrioritySelect },
    { pattern: /^edit_priority_(?!prev_|next_)/, fn: editPriority.handleEditPriorityButton },
    { pattern: /^(edit_priority_prev_|edit_priority_next_)/, fn: editPriority.handleEditPriorityPagination },
    { pattern: /^priority_highest_/, fn: editPriority.handlePriorityHighest },
    { pattern: /^priority_lowest_/, fn: editPriority.handlePriorityLowest },
    { pattern: /^priority_custom_(?!modal_)/, fn: editPriority.handlePriorityCustom },
    { pattern: /^back_to_alliance_management_/, fn: alliance.handleAllianceManagementButton },
    { pattern: /^(assign_admin_prev_|assign_admin_next_)/, fn: assignAlliance.handleAssignAdminPagination },
    { pattern: /^(assign_alliances_prev_|assign_alliances_next_)/, fn: assignAlliance.handleAssignAlliancesPagination },
    { pattern: /^assign_alliance_/, fn: assignAlliance.handleAssignAllianceButton },
    { pattern: /^(trigger_refresh_prev_|trigger_refresh_next_)/, fn: triggerRefresh.handleTriggerRefreshPagination },
    { pattern: /^trigger_refresh_(?!prev_|next_)/, fn: triggerRefresh.handleTriggerRefreshButton },

    // Gift Code management
    { pattern: /^gift_code_management_/, fn: giftCode.handleGiftCodeManagementButton },
    { pattern: /^set_test_id_/, fn: giftSetTestId.handleSetTestIdButton },
    { pattern: /^add_gift_/, fn: addGift.handleAddGiftButton },
    { pattern: /^manual_redeem_gift_/, fn: redeemGift.handleManualRedeemButton },
    { pattern: /^(manual_redeem_alliance_prev_|manual_redeem_alliance_next_)/, fn: redeemGift.handleAllianceSelectionPagination },
    { pattern: /^(manual_redeem_code_prev_|manual_redeem_code_next_)/, fn: redeemGift.handleGiftCodeSelectionPagination },
    { pattern: /^remove_gift_(?!select_|confirm_|cancel_|prev_|next_)/, fn: removeGift.handleRemoveGiftButton },
    { pattern: /^(remove_gift_prev_|remove_gift_next_)/, fn: removeGift.handleRemoveGiftPagination },
    { pattern: /^remove_gift_confirm_/, fn: removeGift.handleRemoveGiftConfirm },
    { pattern: /^remove_gift_cancel_/, fn: removeGift.handleRemoveGiftCancel },
    { pattern: /^toggle_auto_redeem_(?!select_|prev_|next_)/, fn: autoRedeem.handleToggleAutoRedeemButton },
    { pattern: /^(toggle_auto_redeem_prev_|toggle_auto_redeem_next_)/, fn: autoRedeem.handleToggleAutoRedeemPagination },
    { pattern: /^view_gift_(?!prev_|next_)/, fn: viewGift.handleViewGiftButton },
    { pattern: /^(view_gift_prev_|view_gift_next_)/, fn: viewGift.handleViewGiftPagination },
    { pattern: /^gift_code_channel_manage_/, fn: giftCodeChannel.handleGiftCodeChannelButton },
    { pattern: /^gift_code_channel_add_/, fn: giftCodeChannel.handleGiftCodeChannelAdd },
    { pattern: /^gift_code_channel_remove_(?!select_)/, fn: giftCodeChannel.handleGiftCodeChannelRemove },


    // Player management
    { pattern: /^player_management_/, fn: players.handlePlayerManagementButton },
    { pattern: /^(add_player_prev_|add_player_next_)/, fn: addPlayer.handleAddPlayerPagination },
    { pattern: /^add_player_(?!prev_|next_)/, fn: addPlayer.handleAddPlayerButton },
    { pattern: /^open_player_form_/, fn: addPlayer.handlePlayerFormButton },
    { pattern: /^view_failed_players_/, fn: fetchPlayerData.handleViewFailedPlayersButton },
    { pattern: /^id_channel_manage_/, fn: idChannel.handleIdChannelButton },
    { pattern: /^id_channel_add_/, fn: idChannel.handleIdChannelAdd },
    { pattern: /^id_channel_remove_/, fn: idChannel.handleIdChannelRemove },
    { pattern: /^(id_channel_prev_|id_channel_next_)/, fn: idChannel.handleIdChannelPagination },
    { pattern: /^(id_channel_remove_prev_|id_channel_remove_next_)/, fn: idChannel.handleIdChannelRemovePagination },

    // Move players
    { pattern: /^(move_players_source_prev_|move_players_source_next_)/, fn: movePlayers.handleMovePlayersSourcePagination },
    { pattern: /^(move_players_dest_prev_|move_players_dest_next_)/, fn: movePlayers.handleMovePlayersDestPagination },
    { pattern: /^(move_players_player_prev_|move_players_player_next_)/, fn: movePlayers.handleMovePlayersPlayerPagination },
    { pattern: /^move_players_add_ids_/, fn: movePlayers.handleMovePlayersAddIds },
    { pattern: /^move_players_confirm_wrong_/, fn: movePlayers.handleMovePlayersConfirmWrong },
    { pattern: /^move_players_cancel_wrong_/, fn: movePlayers.handleMovePlayersCancelWrong },
    { pattern: /^move_players_(?!source_|dest_|player_|prev_|next_|select_|add_|confirm_|cancel_|done_)/, fn: movePlayers.handleMovePlayersButton },

    // Remove players
    { pattern: /^remove_players_add_ids_/, fn: removePlayers.handleRemovePlayersAddIds },
    { pattern: /^(remove_players_alliance_prev_|remove_players_alliance_next_)/, fn: removePlayers.handleRemovePlayersAlliancePagination },
    { pattern: /^(remove_players_player_prev_|remove_players_player_next_)/, fn: removePlayers.handleRemovePlayersPlayerPagination },
    { pattern: /^remove_players_confirm_/, fn: removePlayers.handleRemovePlayersConfirm },
    { pattern: /^remove_players_cancel_/, fn: removePlayers.handleRemovePlayersCancel },
    { pattern: /^remove_players_(?!alliance_|player_|select_|confirm_|cancel_|done_|add_ids_)/, fn: removePlayers.handleRemovePlayersButton },

    // Export players
    { pattern: /^export_panel_/, fn: exportPlayers.showExportPanel },
    { pattern: /^export_filter_state_/, fn: exportPlayers.handleStateFilterButton },
    { pattern: /^export_filter_alliance_/, fn: exportPlayers.handleAllianceFilterButton },
    { pattern: /^export_filter_furnace_/, fn: exportPlayers.handleFurnaceFilterButton },
    { pattern: /^export_generate_/, fn: exportPlayers.handleGenerate },
    { pattern: /^(export_state_prev_|export_state_next_)/, fn: exportPlayers.handleStatePagination },
    { pattern: /^(export_alliance_prev_|export_alliance_next_)/, fn: exportPlayers.handleAlliancePagination },
    { pattern: /^(export_furnace_prev_|export_furnace_next_)/, fn: exportPlayers.handleFurnacePagination },

    // Admin management
    { pattern: /^manage_admins_/, fn: admin.handleManageAdminsButton },
    { pattern: /^add_admin_/, fn: admin.handleAddAdminButton },
    { pattern: /^confirm_remove_admin_/, fn: admin.handleConfirmRemoveAdmin },
    { pattern: /^cancel_remove_admin_/, fn: admin.handleCancelRemoveAdmin },
    { pattern: /^(remove_admin_prev_|remove_admin_next_)/, fn: admin.handleRemoveAdminPagination },
    { pattern: /^remove_admin_(?!prev_|next_)/, fn: admin.handleRemoveAdminButton },
    { pattern: /^(edit_admin_prev_|edit_admin_next_)/, fn: admin.handleEditAdminPagination },
    { pattern: /^edit_admin_(?!prev_|next_)/, fn: admin.handleEditAdminButton },
    { pattern: /^(view_admin_prev_|view_admin_next_)/, fn: admin.handleViewAdminPagination },
    { pattern: /^view_admin_(?!prev_|next_)/, fn: admin.handleViewAdminButton },
    { pattern: /^(view_full_logs_prev_|view_full_logs_next_)/, fn: admin.handleViewFullLogsPagination },
    { pattern: /^view_full_logs_(?!prev_|next_)/, fn: admin.handleViewFullLogsButton },
    { pattern: /^admin_permissions_/, fn: admin.handleEditAdminButton },

    // Notification management
    { pattern: /^notification_management_/, fn: notification.handleNotificationManagementButton },
    { pattern: /^notification_create_/, fn: createNotification.handleNotificationCreateButton },
    { pattern: /^notification_type_/, fn: createNotification.handleNotificationTypeButton },
    { pattern: /^notification_delete_type_/, fn: deleteNotification.handleTypeSelection },
    { pattern: /^notification_delete_(?!type_|select_|confirm_|cancel_|prev_|next_)/, fn: deleteNotification.handleDeleteNotificationButton },
    { pattern: /^(notification_delete_prev_|notification_delete_next_)/, fn: deleteNotification.handleDeleteNotificationPagination },
    { pattern: /^notification_delete_confirm_/, fn: deleteNotification.handleDeleteConfirm },
    { pattern: /^notification_delete_cancel_/, fn: deleteNotification.handleDeleteCancel },
    { pattern: /^notification_edit_main_/, fn: editNotification.handleEditNotificationButton },
    { pattern: /^notification_edit_type_/, fn: editNotification.handleTypeSelection },
    { pattern: /^(notification_edit_prev_|notification_edit_next_)/, fn: editNotification.handleEditNotificationPagination },
    { pattern: /^notification_edit_info_(?!modal_)/, fn: editNotification.handleInfoButton },
    { pattern: /^notification_edit_content_/, fn: editNotification.handleContentButton },
    { pattern: /^notification_edit_repeat_/, fn: editNotification.handleRepeatButtonFromEdit },
    { pattern: /^notification_edit_pattern_/, fn: editNotification.handlePatternButtonFromEdit },
    { pattern: /^notification_edit_save_/, fn: editNotification.handleSaveButton },
    { pattern: /^notification_edit_message_/, fn: notificationEditor.handleEditMessageButton },
    { pattern: /^notification_toggle_embed_/, fn: notificationEditor.handleToggleEmbedButton },
    { pattern: /^notification_field_add_(?!modal_)/, fn: notificationFields.handleAddFieldButton },
    { pattern: /^notification_field_edit_(?!select_|modal_)/, fn: notificationFields.handleEditFieldButton },
    { pattern: /^notification_field_remove_(?!modal_)/, fn: notificationFields.handleRemoveFieldButton },
    { pattern: /^notification_field_reorder_(?!modal_)/, fn: notificationFields.handleReorderFieldsButton },
    { pattern: /^notification_save_/, fn: createNotification.handleSaveButton },
    { pattern: /^notification_pattern_(?!custom_modal_)/, fn: notificationSettings.handlePatternButton },
    { pattern: /^notification_repeat_(?!custom_modal_)/, fn: notificationSettings.handleRepeatButton },
    { pattern: /^notification_update_time_(?!modal_)/, fn: notificationSettings.handleUpdateTimeButton },
    { pattern: /^notification_helper_/, fn: notificationEditor.handleHelperButton },
    { pattern: /^notification_mention_user_/, fn: notificationMentions.handleMentionTypeButton },
    { pattern: /^notification_mention_role_/, fn: notificationMentions.handleMentionTypeButton },
    { pattern: /^notification_mention_everyone_/, fn: notificationMentions.handleMentionTypeButton },
    { pattern: /^notification_mention_here_/, fn: notificationMentions.handleMentionTypeButton },
    { pattern: /^notification_tag_save_/, fn: notificationMentions.handleTagSave },
    { pattern: /^notification_tag_prev_/, fn: notificationMentions.handleTagPagination },
    { pattern: /^notification_tag_next_/, fn: notificationMentions.handleTagPagination },

    // Template Library
    { pattern: /^template_library_/, fn: templateLibrary.handleTemplateLibraryButton },
    { pattern: /^template_share_type_/, fn: shareNotification.handleTypeSelection },
    { pattern: /^template_share_(?!type_)/, fn: shareNotification.handleShareNotificationButton },
    { pattern: /^template_upload_/, fn: uploadNotification.handleUploadNotificationButton },
    { pattern: /^template_import_type_/, fn: uploadNotification.handleImportTypeSelection },
    { pattern: /^pagination_template_export_/, fn: shareNotification.handleExportPagination }
];

// === SETUP FUNCTION ===
function setupButtonHandlers(client) {
    const listener = async (interaction) => {
        if (!interaction.isButton()) return;

        for (const { pattern, fn } of buttonHandlers) {
            if (pattern.test(interaction.customId)) {
                try {
                    await fn(interaction);
                } catch (error) {
                    console.error(`[ButtonHandler] Error handling button ${interaction.customId}:`, error);
                    try {
                        const reply = interaction.deferred || interaction.replied
                            ? interaction.followUp.bind(interaction)
                            : interaction.reply.bind(interaction);
                        await reply({ content: 'An error occurred while processing this button.', flags: 64 });
                    } catch (_) { /* interaction may have expired */ }
                }
                return; // stop after first match
            }
        }
    };

    client.on('interactionCreate', listener);

    return () => client.off('interactionCreate', listener);
}

module.exports = setupButtonHandlers;
