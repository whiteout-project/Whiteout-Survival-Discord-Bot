const { handleIdChannelMessage } = require('../functions/Players/idChannel');
const { handleGiftCodeChannelMessage } = require('../functions/GiftCode/giftCodeChannel');

module.exports = {
    name: 'messageCreate',
    async execute(message) {
        // Ignore bot messages
        if (message.author.bot) return;

        // Handle ID channel messages
        try {
            await handleIdChannelMessage(message);
        } catch (error) {
            console.error('[messageCreate] Error handling ID channel message:', error);
        }

        // Handle gift code channel messages
        try {
            await handleGiftCodeChannelMessage(message);
        } catch (error) {
            console.error('[messageCreate] Error handling gift code channel message:', error);
        }
    }
};
