const GIT_METADATA_NAMES = new Set(['.git', '.gitignore', '.gitattributes', '.gitmodules']);

function isGitMetadataPath(relativePath) {
    return relativePath.split(/[\\/]/).some(part => GIT_METADATA_NAMES.has(part));
}

module.exports = { isGitMetadataPath };
