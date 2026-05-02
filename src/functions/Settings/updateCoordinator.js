let activeUpdate = null;

function acquireUpdateLock(label) {
    if (activeUpdate) {
        return {
            acquired: false,
            active: { ...activeUpdate }
        };
    }

    const token = {
        label,
        startedAt: Date.now()
    };

    activeUpdate = token;
    return {
        acquired: true,
        token
    };
}

function releaseUpdateLock(token) {
    if (activeUpdate === token) {
        activeUpdate = null;
    }
}

function getActiveUpdate() {
    return activeUpdate ? { ...activeUpdate } : null;
}

function formatActiveUpdateMessage(active = getActiveUpdate()) {
    if (!active) {
        return 'Another update is already in progress.';
    }

    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - active.startedAt) / 1000));
    const suffix = elapsedSeconds > 0 ? ` (${elapsedSeconds}s ago)` : '';
    return `Another update is already in progress: ${active.label}${suffix}.`;
}

module.exports = {
    acquireUpdateLock,
    releaseUpdateLock,
    getActiveUpdate,
    formatActiveUpdateMessage
};
