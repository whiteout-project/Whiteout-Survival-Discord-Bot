const { playerQueries, allianceQueries, processQueries, stateSearchRetryQueries, giftCodeUsageQueries, systemLogQueries } = require('../utility/database');
const { createProcess, getProcessById, updateProcessProgress, updateProcessStatus, PROCESS_STATUS } = require('../Processes/createProcesses');
const { queueManager } = require('../Processes/queueManager');

const pendingCreations = new Set();
const MATCH_STATUSES = new Set([
    'SUCCESS', 'RECEIVED', 'SAME TYPE EXCHANGE',
    'STOVE_LV ERROR', 'RECHARGE_MONEY ERROR', 'RECHARGE_MONEY_VIP ERROR'
]);
const UNUSABLE_CODE_STATUSES = new Set(['USED', 'TIME ERROR', 'CDK NOT FOUND']);

function getPlayerStateInfo(fid, gameType) {
    const player = playerQueries.getPlayer(fid, gameType);
    if (!player) return null;
    const alliance = allianceQueries.getAllianceById(player.alliance_id, gameType);
    const effectiveState = player.state_override ?? alliance?.state ?? null;
    return {
        player,
        alliance,
        effectiveState,
        blocked: effectiveState != null && Number(player.state_search_blocked_for) === Number(effectiveState)
    };
}

function candidateState(baseState, index) {
    const distance = Math.floor(index / 2) + 1;
    return Number(baseState) + (index % 2 === 0 ? distance : -distance);
}

async function queueStateSearch(fid, gameType, attemptedState, giftCode) {
    const info = getPlayerStateInfo(fid, gameType);
    if (!info || info.blocked || Number(info.effectiveState) !== Number(attemptedState)) return;

    stateSearchRetryQueries.add(fid, giftCode, gameType);
    const key = `${gameType}:${fid}`;
    if (pendingCreations.has(key)) return;
    const existing = processQueries.getProcessesByActionAndTarget('state_search', '0').some(process => {
        try {
            const details = JSON.parse(process.details);
            return details.game_type === gameType && String(details.player_ids) === String(fid);
        } catch {
            return false;
        }
    });
    if (existing) return;

    pendingCreations.add(key);
    try {
        const created = await createProcess({
            admin_id: 'SYSTEM_STATE_SEARCH',
            alliance_id: 0,
            player_ids: String(fid),
            action: 'state_search',
            game_type: gameType
        });
        await updateProcessProgress(created.process_id, {
            pending: [String(fid)], done: [], failed: [], existing: [],
            search: { baseState: Number(attemptedState), nextIndex: 0, excludedCodes: [] }
        });
        await queueManager.manageQueue(created);
    } finally {
        pendingCreations.delete(key);
    }
}

async function queueMissedCodes(fid, gameType) {
    const info = getPlayerStateInfo(fid, gameType);
    if (!info?.alliance || info.blocked) return;
    const { createRedeemProcess } = require('./redeemFunction');
    for (const { gift_code: giftCode } of stateSearchRetryQueries.getActive(fid, gameType)) {
        const result = await createRedeemProcess([{ id: fid, giftCode, status: 'redeem' }], {
            adminId: 'SYSTEM_STATE_SEARCH',
            deferQueue: true,
            allianceContext: {
                id: info.alliance.id,
                name: info.alliance.name,
                channelId: info.alliance.channel_id,
                gameType
            },
            gameType
        });
        if (result.processId || giftCodeUsageQueries.checkUsage(fid, giftCode, gameType)) {
            stateSearchRetryQueries.remove(fid, giftCode, gameType);
        }
    }
}

async function executeStateSearch(processId) {
    const process = await getProcessById(processId);
    const fid = String(process.details.player_ids);
    const gameType = process.details.game_type;
    let progress = process.progress;
    const info = getPlayerStateInfo(fid, gameType);
    const baseState = progress.search?.baseState ?? info?.effectiveState;
    if (!info || !Number.isSafeInteger(Number(baseState)) || Number(baseState) <= 0) {
        throw new Error(`State search ${processId} has no valid player or assigned state`);
    }
    if (!progress.search) {
        progress.search = { baseState: Number(baseState), nextIndex: 0, excludedCodes: [] };
        await updateProcessProgress(processId, progress);
    }

    const finish = async () => {
        progress = { ...progress, pending: [], done: [fid] };
        await updateProcessProgress(processId, progress);
        await updateProcessStatus(processId, PROCESS_STATUS.COMPLETED);
    };

    if (Number(info.effectiveState) !== Number(baseState)) {
        await queueMissedCodes(fid, gameType);
        await finish();
        await queueManager.startNextProcess();
        return;
    }
    if (info.blocked) {
        await finish();
        await queueManager.startNextProcess();
        return;
    }

    const { makeGiftCodeAPIRequest, handlePostRedemption } = require('./redeemFunction');
    let consecutiveRateLimits = 0;
    for (let index = progress.search?.nextIndex || 0; index < 400;) {
        const { processExecutor } = require('../Processes/executeProcesses');
        if ((await processExecutor.checkForPreemption(processId)).shouldStop) return { preempted: true };
        const current = getPlayerStateInfo(fid, gameType);
        if (!current || Number(current.effectiveState) !== Number(baseState)) {
            await queueMissedCodes(fid, gameType);
            await finish();
            await queueManager.startNextProcess();
            return;
        }

        const candidate = candidateState(baseState, index);
        if (candidate < 1 || !Number.isSafeInteger(candidate)) {
            index++;
            progress.search.nextIndex = index;
            await updateProcessProgress(processId, progress);
            continue;
        }
        const excluded = new Set(progress.search?.excludedCodes || []);
        const probe = stateSearchRetryQueries.getActive(fid, gameType)
            .find(row => !excluded.has(row.gift_code));
        if (!probe) throw new Error(`State search ${processId} has no usable active gift code`);

        const outcome = await makeGiftCodeAPIRequest(fid, probe.gift_code, 'redeem', { gameType, state: candidate });
        outcome.gameType = gameType;
        if (outcome.rateLimited) {
            if (++consecutiveRateLimits > 5) throw new Error(`State search ${processId} remained rate limited`);
            await new Promise(resolve => setTimeout(resolve, Math.max(1000, outcome.retryDelay || 60000)));
            continue;
        }
        consecutiveRateLimits = 0;
        if (outcome.wrongState || outcome.status === 'USER INFO ERROR') {
            index++;
            progress.search.nextIndex = index;
            await updateProcessProgress(processId, progress);
            if (index < 400) await new Promise(resolve => setTimeout(resolve, 2200));
            continue;
        }
        if (UNUSABLE_CODE_STATUSES.has(outcome.status)) {
            progress.search.excludedCodes = [...excluded, probe.gift_code];
            await updateProcessProgress(processId, progress);
            continue;
        }
        if (!MATCH_STATUSES.has(outcome.status)) {
            throw new Error(`State search ${processId} stopped on inconclusive response ${outcome.status || 'UNKNOWN'}`);
        }

        if (Number(getPlayerStateInfo(fid, gameType)?.effectiveState) !== Number(baseState)) {
            await queueMissedCodes(fid, gameType);
            await finish();
            await queueManager.startNextProcess();
            return;
        }

        await handlePostRedemption(fid, probe.gift_code, outcome);
        stateSearchRetryQueries.remove(fid, probe.gift_code, gameType);
        playerQueries.updatePlayerStateOverride(fid, candidate, gameType);
        systemLogQueries.addLog('player_state_search', `Found state ${candidate} for player ${fid}`, JSON.stringify({ fid, gameType, previousState: baseState, state: candidate }));
        await queueMissedCodes(fid, gameType);
        await finish();
        await queueManager.startNextProcess();
        return;
    }

    if (Number(getPlayerStateInfo(fid, gameType)?.effectiveState) !== Number(baseState)) {
        await queueMissedCodes(fid, gameType);
        await finish();
        await queueManager.startNextProcess();
        return;
    }
    playerQueries.blockStateSearch(fid, baseState, gameType);
    systemLogQueries.addLog('player_state_search', `No state found for player ${fid}`, JSON.stringify({ fid, gameType, assignedState: baseState, range: 200 }));
    await finish();
    await queueManager.startNextProcess();
}

module.exports = { candidateState, getPlayerStateInfo, queueStateSearch, executeStateSearch };
