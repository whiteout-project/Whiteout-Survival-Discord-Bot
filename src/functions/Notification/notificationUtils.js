/**
 * Notification Utility Functions
 * Shared utilities for mention tag parsing and conversion
 */

/**
 * Extract @tag patterns from text
 * @param {string} text - The text to search for @tag patterns
 * @returns {string[]} Array of unique @tag patterns found
 */
function extractMentionTags(text) {
    if (!text) return [];

    // Match @ followed by word characters (letters, numbers, underscore)
    const tagRegex = /@(\w+)/g;
    const matches = [];
    const seenTags = new Set();
    let match;

    while ((match = tagRegex.exec(text)) !== null) {
        const tag = match[1];
        if (!seenTags.has(tag)) {
            seenTags.add(tag);
            matches.push(tag);
        }
    }

    return matches;
}

/**
 * Convert raw @tag placeholders to their configured Discord mention format for display
 * This is for DISPLAY ONLY - database values remain unchanged as @tag format
 * @param {string} text - The text containing @tag placeholders
 * @param {object} mentions - Parsed mention object from notification.mention
 * @param {string} component - Component type ('message', 'description', or 'fields')
 * @returns {string} Text with configured tags converted to Discord mention format
 */
function convertTagsToMentions(text, mentions, component) {
    if (!text || !mentions || !mentions[component]) return text;

    let result = text;
    const componentMentions = mentions[component];

    // Replace each configured tag with its Discord mention format
    Object.entries(componentMentions).forEach(([tag, value]) => {
        const [type, id] = value.split(':');
        let mentionString = '';

        if (type === 'everyone') {
            mentionString = '@everyone';
        } else if (type === 'here') {
            mentionString = '@here';
        } else if (type === 'user') {
            mentionString = `<@${id}>`;
        } else if (type === 'role') {
            mentionString = `<@&${id}>`;
        }

        // Replace all occurrences of @tag with the mention string using word boundary
        const tagRegex = new RegExp(`@${tag}\\b`, 'g');
        result = result.replace(tagRegex, mentionString);
    });

    return result;
}

/**
 * Convert Discord mentions back to their @tag placeholder format for database storage
 * This preserves the @tag format in the database while allowing display of actual mentions
 * @param {string} text - The text containing Discord mentions
 * @param {object} mentions - Parsed mention object from notification.mention
 * @param {string} component - Component type ('message' or 'description')
 * @returns {string} Text with Discord mentions converted back to @tag format
 */
function convertMentionsToTags(text, mentions, component) {
    if (!text || !mentions || !mentions[component]) return text;

    let result = text;
    const componentMentions = mentions[component];

    // Replace each Discord mention with its @tag placeholder
    Object.entries(componentMentions).forEach(([tag, value]) => {
        const [type, id] = value.split(':');
        let mentionPattern;

        if (type === 'everyone') {
            mentionPattern = /@everyone/g;
        } else if (type === 'here') {
            mentionPattern = /@here/g;
        } else if (type === 'user') {
            // Match <@userId> or <@!userId> (with or without nickname indicator)
            mentionPattern = new RegExp(`<@!?${id}>`, 'g');
        } else if (type === 'role') {
            mentionPattern = new RegExp(`<@&${id}>`, 'g');
        }

        // Replace the Discord mention format with @tag
        if (mentionPattern) {
            result = result.replace(mentionPattern, `@${tag}`);
        }
    });

    return result;
}

/**
 * Parse existing mentions from notification
 * @param {string} mentionJson - JSON string of mentions
 * @returns {object} Parsed mention object
 */
function parseMentions(mentionJson) {
    try {
        return mentionJson ? JSON.parse(mentionJson) : {};
    } catch (error) {
        console.error('Error parsing mentions:', error);
        return {};
    }
}

/**
 * Calculate the total number of characters in an embed configuration
 * @param {object} embedData - Object containing embed properties (title, description, author, footer, fields)
 * @returns {number} Total character count
 */
function calculateEmbedSize(embedData) {
    let total = 0;
    if (embedData.title) total += embedData.title.length;
    if (embedData.description) total += embedData.description.length;
    if (embedData.author) total += embedData.author.length;
    if (embedData.footer) total += embedData.footer.length;

    // Handle fields whether they are an array or JSON string
    let fields = [];
    if (Array.isArray(embedData.fields)) {
        fields = embedData.fields;
    } else if (typeof embedData.fields === 'string') {
        try {
            fields = JSON.parse(embedData.fields);
        } catch (e) {
            fields = [];
        }
    }

    if (Array.isArray(fields)) {
        fields.forEach(field => {
            if (field.name) total += field.name.length;
            if (field.value) total += field.value.length;
        });
    }
    return total;
}

module.exports = {
    extractMentionTags,
    convertTagsToMentions,
    convertMentionsToTags,
    parseMentions,
    calculateEmbedSize
};
