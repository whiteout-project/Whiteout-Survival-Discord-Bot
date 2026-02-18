const language = require('../functions/Settings/language');
const admin = require('../functions/Settings/admin');
const createAlliance = require('../functions/Alliance/createAlliance');
const editAlliance = require('../functions/Alliance/editAlliance');
const deleteAlliance = require('../functions/Alliance/deleteAlliance');
const editPriority = require('../functions/Alliance/editPriority');
const viewAlliances = require('../functions/Alliance/viewAlliances');
const addPlayer = require('../functions/Players/addPlayer');
const movePlayers = require('../functions/Players/movePlayers');
const removePlayers = require('../functions/Players/removePlayers');
const viewPlayers = require('../functions/Players/viewPlayers');
const idChannel = require('../functions/Players/idChannel');
const exportPlayers = require('../functions/Players/export');
const redeemGift = require('../functions/GiftCode/redeemGift');
const removeGift = require('../functions/GiftCode/removeGift');
const autoRedeem = require('../functions/GiftCode/autoRedeem');
const giftCodeChannel = require('../functions/GiftCode/giftCodeChannel');
const triggerRefresh = require('../functions/Alliance/triggerRefresh');
const assignAlliance = require('../functions/Alliance/assignAlliance');
const deleteNotification = require('../functions/Notification/deleteNotification');
const editNotification = require('../functions/Notification/editNotification');
const notificationEditor = require('../functions/Notification/notificationEditor');
const notificationMentions = require('../functions/Notification/notificationMentions');
const notificationFields = require('../functions/Notification/notificationFields');
const notificationSettings = require('../functions/Notification/notificationSettings');
const shareNotification = require('../functions/Notification/shareNotification');
const emojisActivate = require('../functions/Settings/theme/emojisActivate');
const emojisEdit = require('../functions/Settings/theme/emojisEdit');
const emojisView = require('../functions/Settings/theme/emojisView');
const emojisExport = require('../functions/Settings/theme/emojisExport');
const emojisDelete = require('../functions/Settings/theme/emojisDelete');

// === HANDLER REGISTRY ===
const dropdownHandlers = [
    // === String Select Menus ===
    { type: 'string', pattern: /^language_select_/, fn: language.handleLanguageSelection },

    // Admin selections
    { type: 'string', pattern: /^select_admin_remove_/, fn: admin.handleRemoveAdminSelection },
    { type: 'string', pattern: /^select_admin_edit_/, fn: admin.handleEditAdminSelection },
    { type: 'string', pattern: /^select_admin_view_/, fn: admin.handleViewAdminSelection },
    { type: 'string', pattern: /^select_permissions_/, fn: admin.handlePermissionSelection },

    // Alliance selections
    { type: 'string', pattern: /^select_alliance_edit_/, fn: editAlliance.handleEditAllianceSelection },
    { type: 'string', pattern: /^select_alliance_delete_/, fn: deleteAlliance.handleDeleteAllianceSelection },
    { type: 'string', pattern: /^select_alliance_priority_/, fn: editPriority.handlePriorityAllianceSelection },
    { type: 'string', pattern: /^select_view_alliance_/, fn: viewAlliances.handleViewAllianceSelection },

    // Emoji theme selections
    { type: 'string', pattern: /^emoji_activate_select_/, fn: emojisActivate.handleEmojiActivateSelection },
    { type: 'string', pattern: /^emoji_edit_select_/, fn: emojisEdit.handleEmojiEditSelection },
    { type: 'string', pattern: /^emoji_view_select_/, fn: emojisView.handleEmojiViewSelection },
    { type: 'string', pattern: /^emoji_export_select_/, fn: emojisExport.handleEmojiExportSelection },
    { type: 'string', pattern: /^emoji_delete_select_/, fn: emojisDelete.handleEmojiDeleteSelection },
    { type: 'string', pattern: /^alliance_select_add_player_/, fn: addPlayer.handleAllianceSelection },
    { type: 'string', pattern: /^id_channel_alliance_select_/, fn: idChannel.handleIdChannelAllianceSelection },
    { type: 'string', pattern: /^id_channel_remove_select_/, fn: idChannel.handleIdChannelRemoveSelect },

    // Move players selections
    { type: 'string', pattern: /^move_players_source_select_/, fn: movePlayers.handleMovePlayersSourceSelection },
    { type: 'string', pattern: /^move_players_dest_select_/, fn: movePlayers.handleMovePlayersDestSelection },
    { type: 'string', pattern: /^move_players_player_select_/, fn: movePlayers.handleMovePlayersPlayerSelection },

    // Remove players selections
    { type: 'string', pattern: /^remove_players_alliance_select_/, fn: removePlayers.handleRemovePlayersAllianceSelection },
    { type: 'string', pattern: /^remove_players_player_select_/, fn: removePlayers.handleRemovePlayersPlayerSelection },

    // View players selections
    { type: 'string', pattern: /^view_players_alliance_select_/, fn: viewPlayers.handleViewPlayersAllianceSelection },

    // Export players selections
    { type: 'string', pattern: /^export_state_select_/, fn: exportPlayers.handleStateSelection },
    { type: 'string', pattern: /^export_alliance_select_/, fn: exportPlayers.handleAllianceSelection },
    { type: 'string', pattern: /^export_furnace_select_/, fn: exportPlayers.handleFurnaceSelection },

    // Manual redeem selections
    { type: 'string', pattern: /^manual_redeem_alliance_select_/, fn: redeemGift.handleAllianceSelection },
    { type: 'string', pattern: /^manual_redeem_code_select_/, fn: redeemGift.handleGiftCodeSelection },

    // Remove gift selections
    { type: 'string', pattern: /^remove_gift_select_/, fn: removeGift.handleRemoveGiftSelect },

    // Toggle auto-redeem selections
    { type: 'string', pattern: /^toggle_auto_redeem_select_/, fn: autoRedeem.handleToggleAutoRedeemSelect },

    // Gift code channel selections
    { type: 'string', pattern: /^gift_code_channel_remove_select_/, fn: giftCodeChannel.handleGiftCodeChannelRemoveSelect },

    // Trigger refresh selections
    { type: 'string', pattern: /^select_trigger_refresh_/, fn: triggerRefresh.handleTriggerRefreshSelection },

    // Assign alliance selections
    { type: 'string', pattern: /^select_assign_admin_/, fn: assignAlliance.handleAssignAdminSelection },
    { type: 'string', pattern: /^select_assign_alliances_/, fn: assignAlliance.handleAssignAlliancesSelection },

    // === User Select Menus ===
    { type: 'user', pattern: /^select_user_add_admin_/, fn: admin.handleAddAdminUserSelection },
    { type: 'user', pattern: /^notification_mention_select_.*\|user\|/, fn: notificationMentions.handleMentionSelection },

    // === Role Select Menus ===
    { type: 'role', pattern: /^notification_mention_select_.*\|role\|/, fn: notificationMentions.handleMentionSelection },

    // Notification embed component selection
    { type: 'string', pattern: /^notification_embed_select_/, fn: notificationEditor.handleEmbedSelectMenu },

    // Notification field edit selection
    { type: 'string', pattern: /^notification_field_edit_select_/, fn: notificationFields.handleEditFieldSelectMenu },
    { type: 'string', pattern: /^notification_field_remove_select_/, fn: notificationFields.handleRemoveFieldSelect },
    { type: 'string', pattern: /^notification_field_reorder_from_/, fn: notificationFields.handleReorderFieldsFromSelect },
    { type: 'string', pattern: /^notification_field_reorder_to_/, fn: notificationFields.handleReorderFieldsToSelect },
    { type: 'string', pattern: /^notification_tag_select_/, fn: notificationMentions.handleTagSelection },
    { type: 'string', pattern: /^notification_delete_select_/, fn: deleteNotification.handleNotificationSelection },
    { type: 'string', pattern: /^notification_edit_select_/, fn: editNotification.handleNotificationSelection },
    { type: 'string', pattern: /^template_export_menu_/, fn: shareNotification.handleNotificationExportSelection },

    // === Channel Select Menus ===
    { type: 'channel', pattern: /^alliance_channel_select_/, fn: createAlliance.handleAllianceChannelSelection },
    { type: 'channel', pattern: /^alliance_channel_edit_/, fn: editAlliance.handleEditAllianceChannelSelection },
    { type: 'channel', pattern: /^id_channel_select_/, fn: idChannel.handleIdChannelSelect },
    { type: 'channel', pattern: /^gift_code_channel_select_/, fn: giftCodeChannel.handleGiftCodeChannelSelect },
    { type: 'channel', pattern: /^notification_channel_select_/, fn: notificationSettings.handleChannelSelection },
];

// === SETUP FUNCTION ===
function setupDropdownHandlers(client) {
    const listener = async (interaction) => {
        for (const { type, pattern, fn } of dropdownHandlers) {
            if (
                (type === 'string' && interaction.isStringSelectMenu()) ||
                (type === 'user' && interaction.isUserSelectMenu()) ||
                (type === 'role' && interaction.isRoleSelectMenu()) ||
                (type === 'channel' && interaction.isChannelSelectMenu())
            ) {
                if (pattern.test(interaction.customId)) {
                    try {
                        await fn(interaction);
                    } catch (error) {
                        console.error(`[DropdownHandler] Error handling dropdown ${interaction.customId}:`, error);
                        try {
                            const reply = interaction.deferred || interaction.replied
                                ? interaction.followUp.bind(interaction)
                                : interaction.reply.bind(interaction);
                            await reply({ content: 'An error occurred while processing this selection.', flags: 64 });
                        } catch (_) { /* interaction may have expired */ }
                    }
                    return; // stop at first match
                }
            }
        }
    };

    client.on('interactionCreate', listener);

    return () => client.off('interactionCreate', listener);
}

module.exports = setupDropdownHandlers;
