const fs = require('fs');
const path = require('path');

// Load all language files from i18n directory
const languages = {};

function loadLanguages() {
    const languageFiles = fs.readdirSync(__dirname).filter(file => file.endsWith('.json'));

    for (const file of languageFiles) {
        const languageCode = path.parse(file).name;
        const filePath = path.join(__dirname, file);
        
        try {
            const languageData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            languages[languageCode] = languageData;
        } catch (error) {
            console.error(`Failed to load language file ${file}: ${error.message}`);
        }
    }
}

// Load languages on module initialization
loadLanguages();

// Export the languages object that can be imported directly
module.exports = languages;

// Add reload function for hot reloading
module.exports.reload = function() {
    // Clear existing languages
    Object.keys(languages).forEach(key => delete languages[key]);
    // Reload from files
    loadLanguages();
    console.log('i18n files reloaded');
};