const fs = require('fs');
const path = require('path');

// Version labels do not change the dependency tree; all other package and lock data still matters.
function dependencyFingerprint(dir) {
    return JSON.stringify(['package.json', 'package-lock.json'].map(name => {
        const file = path.join(dir, name);
        if (!fs.existsSync(file)) return null;
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        delete data.version;
        if (name === 'package-lock.json' && data.packages?.['']) delete data.packages[''].version;
        return data;
    }));
}

module.exports = { dependencyFingerprint };
