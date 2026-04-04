const {
    ButtonBuilder, ButtonStyle, ActionRowBuilder,
    ContainerBuilder, TextDisplayBuilder, SeparatorBuilder,
    SeparatorSpacingSize, MessageFlags, StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder, ModalBuilder, TextInputBuilder,
    TextInputStyle, LabelBuilder
} = require('discord.js');
const { handleError, assertUserMatches, updateComponentsV2AfterSeparator, getUserInfo } = require('../../utility/commonFunctions');
const { checkFeatureAccess } = require('../../utility/checkAccess');
const { userQueries } = require('../../utility/database');
const { getFurnaceReadable } = require('../../Players/furnaceReadable');
const basicData = require('./basic.json');
const fireCrystalData = require('./fire_crystal.json');
const { getComponentEmoji, getEmojiMapForUser } = require('../../utility/emojis');


// Lazy-load ascii85 once; falls back to null if unavailable
let _ascii85 = null;
function getAscii85() {
    if (_ascii85 === null) {
        try { _ascii85 = require('ascii85'); } catch { _ascii85 = undefined; }
    }
    return _ascii85;
}

const PAGE_SIZE = 24;

function getBuildingNames(lang) {
    const b = lang.calculators.buildings.content.buildings;
    return {
        barricade: b.barricade,
        marksmanCamp: b.marksmanCamp,
        lancerCamp: b.lancerCamp,
        infantryCamp: b.infantryCamp,
        researchCenter: b.researchCenter,
        infirmary: b.infirmary,
        commandCenter: b.commandCenter,
        embassy: b.embassy,
        storehouse: b.storehouse,
        furnace: b.furnace,
        warAcademy: b.warAcademy
    };
}

// Short 2-char codes for compact copy-button customIds — must be unique and contain no `_` or `-`.
const BUILDING_SHORT = {
    barricade:      'Ba',
    marksmanCamp:   'Mc',
    lancerCamp:     'Lc',
    infantryCamp:   'Ic',
    researchCenter: 'Rc',
    infirmary:      'If',
    commandCenter:  'Cc',
    embassy:        'Eb',
    storehouse:     'Sh',
    furnace:        'Fu',
    warAcademy:     'Wa'
};
// Reverse lookup: short code → building key.
const SHORT_TO_BUILDING = Object.fromEntries(
    Object.entries(BUILDING_SHORT).map(([k, v]) => [v, k])
);

function getResourceLabels(lang) {
    const r = lang.calculators.buildings.content.resources;
    return {
        meat:               r.meat,
        wood:               r.wood,
        coal:               r.coal,
        iron:               r.iron,
        fireCrystal:        r.fireCrystal,
        refinedFireCrystal: r.refinedFireCrystal
    };
}

/** Construction-time speed bonus % per pet level (index = level). */
const PET_SPEED     = [0, 5, 7, 9, 12, 15];
/** Resource cost reduction % per Zinman level (index = level). */
const ZINMAN_REDUCE = [0, 3, 6, 9, 12, 15];
/** Fixed seconds subtracted per upgrade level per Expert level. 2h/3h/4h/6h/8h */
const EXPERT_SECS   = [0, 7200, 10800, 14400, 21600, 28800];

// Reusable set of basic (non-crystal) resource keys — defined once at module level
const BASIC_RESOURCES = new Set(['meat', 'wood', 'coal', 'iron']);

// Empty totals template — cloned wherever needed
const EMPTY_TOTALS = { meat: 0, wood: 0, coal: 0, iron: 0, steel: 0, fireCrystal: 0, refinedFireCrystal: 0 };

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Whether a building should offer the "Not Built" (level 0) from-level option.
 *  Basic: only if level-1 has any non-zero cost. FC: only for warAcademy. */
function shouldShowNotBuilt(type, bldId, dataObj) {
    if (type === 'f') return bldId === 'warAcademy';
    const lvl1 = dataObj[bldId]?.['1'];
    if (!lvl1?.cost) return false;
    return Object.values(lvl1.cost).some(v => v > 0);
}

/** Clamp a value between 0 and 5. */
function clamp5(v) { return Math.min(5, Math.max(0, v || 0)); }

function getDataObj(type) {
    return type === 'f' ? fireCrystalData : basicData;
}

function getTypeLabel(type, lang) {
    const t = lang.calculators.buildings.types;
    return type === 'f' ? t.fireCrystal : t.basic;
}

function getBuildingLevelKeys(buildingData) {
    return Object.keys(buildingData)
        .filter(k => !['icon', 'description', 'name', 'max_level'].includes(k))
        .sort((a, b) => parseInt(a) - parseInt(b));
}

/** Returns the human-readable display string for a level key. */
function getLevelDisplay(key, type, lang) {
    if (key === '0') return lang.calculators.buildings.notBuilt;
    if (type === 'f') return getFurnaceReadable(parseInt(key));
    return lang.calculators.buildings.levelDisplay.replace('{key}', key);
}

/** Formats a large number as a compact string (B/M/K suffix). */
function formatNumber(n) {
    if (!n || n <= 0) return '0';
    if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + 'B';
    if (n >= 1_000_000)     return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1_000)         return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
    return n.toLocaleString();
}

/** Formats a duration in seconds as a human-readable string (Xd Xh Xm Xs). */
function formatSeconds(sec) {
    if (!sec || sec <= 0) return '0s';
    sec = Math.floor(sec);
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    if (s > 0) parts.push(`${s}s`);
    return parts.join(' ') || '0s';
}

// ─── Buff helpers ────────────────────────────────────────────────────────────────

/** Loads and parses the user's saved buff settings from the database. */
function getUserBuffs(userId) {
    try {
        const row = userQueries.getBuffs(userId);
        if (!row?.buffs) return { flatSpeedBonus: 0, petLevel: 0, zinmanLevel: 0, expertLevel: 0, constructionSpeed: 0 };
        const parsed = JSON.parse(row.buffs);
        return {
            flatSpeedBonus:    Number(parsed.flatSpeedBonus)   || 0,
            petLevel:          clamp5(parseInt(parsed.petLevel)),
            zinmanLevel:       clamp5(parseInt(parsed.zinmanLevel)),
            expertLevel:       clamp5(parseInt(parsed.expertLevel)),
            constructionSpeed: Number(parsed.constructionSpeed) || 0
        };
    } catch {
        return { flatSpeedBonus: 0, petLevel: 0, zinmanLevel: 0, expertLevel: 0, constructionSpeed: 0 };
    }
}

/** Returns true if any buff field is active (non-zero). */
function hasAnyBuff(buffs) {
    return buffs.constructionSpeed > 0 || buffs.flatSpeedBonus > 0
        || buffs.petLevel > 0 || buffs.zinmanLevel > 0 || buffs.expertLevel > 0;
}

/** Returns the display label for a combined VP / Double Time flat speed bonus value. */
function getFlatSpeedLabel(flatSpeedBonus, lang) {
    const m = lang.calculators.buildings.modal.vpDoubleTime;
    switch (flatSpeedBonus) {
        case 10: return m.vp10;
        case 15: return m.vp15;
        case 20: return m.doubleTime;
        case 30: return m.vp10dt;
        case 35: return m.vp15dt;
        default: return `+${flatSpeedBonus}%`;
    }
}

// ─── Aggregation helpers ───────────────────────────────────────────────────────────

/**
 * Merges building-requirement levels from `source` into `target`,
 * keeping the maximum required level per building key.
 * @param {{ [buildingKey: string]: number }} target - mutated in place
 * @param {{ [buildingKey: string]: number }} source
 */
function mergeRequirements(target, source) {
    for (const [bKey, bLevel] of Object.entries(source)) {
        if (!target[bKey] || bLevel > target[bKey]) target[bKey] = bLevel;
    }
}

/**
 * Accumulates resource totals from a list of upgrade entries into an existing totals object.
 * @param {{ [res: string]: number }} totalRes - mutated in place
 * @param {{ result: { totals: object } }[]} entries
 */
function accumulateTotals(totalRes, entries) {
    for (const e of entries) {
        for (const [res, amt] of Object.entries(e.result.totals)) {
            if (Object.hasOwn(totalRes, res)) totalRes[res] += amt;
        }
    }
}

/**
 * Aggregates all numeric totals and building requirements across a set of upgrade entries.
 * @param {{ result: object }[]} entries
 * @returns {{ totalRes, totalSeconds, reducedSeconds, totalNumLevels, maxBuildingReqs }}
 */
function aggregateEntries(entries) {
    const totalRes        = { ...EMPTY_TOTALS };
    const maxBuildingReqs = {};
    let totalSeconds   = 0;
    let reducedSeconds = 0;
    let totalNumLevels = 0;

    accumulateTotals(totalRes, entries);
    for (const e of entries) {
        totalSeconds   += e.result.totalSeconds;
        reducedSeconds += e.result.reducedSeconds;
        totalNumLevels += e.result.numLevels;
        mergeRequirements(maxBuildingReqs, e.result.maxBuildingReqs);
    }

    return { totalRes, totalSeconds, reducedSeconds, totalNumLevels, maxBuildingReqs };
}

/**
 * Appends requirement lines to a `lines` array.
 * Furnace levels are shown via `getFurnaceReadable` with localisation; all others use the raw number.
 * @param {string[]} lines - mutated in place
 * @param {{ [bKey: string]: number }} reqs
 * @param {{ [bKey: string]: string }} buildingNames
 * @param {string} headerKey      - Localised header string
 * @param {string} levelTemplate  - Localised level template containing `{level}`
 * @param {object} lang           - Language object for localised furnace level display
 */
function appendRequirementLines(lines, reqs, buildingNames, headerKey, levelTemplate, lang) {
    const reqEntries = Object.entries(reqs);
    if (!reqEntries.length) return;
    lines.push(headerKey);
    for (const [bKey, bLevel] of reqEntries) {
        const bName      = buildingNames[bKey] || bKey;
        const bLevelDisp = getFurnaceReadable(bLevel, lang);
        lines.push(`  - ${bName}: ${levelTemplate.replace('{level}', bLevelDisp)}`);
    }
}

/**
 * Reads the results container (index 1) from the current message and decodes
 * its copy-button customId back into upgrade entries.
 * @param {import('discord.js').Message} message
 * @param {object} buffs
 * @returns {{ type, bldId, fromKey, toKey, result }[]}
 */
function getExistingEntries(message, buffs) {
    const components    = message.components;
    if (components.length <= 1) return [];
    const subComponents = components[1].components ?? [];
    const lastRow       = subComponents[subComponents.length - 1];
    const copyId        = lastRow?.components?.[0]?.customId ?? lastRow?.components?.[0]?.custom_id ?? '';
    return copyId.startsWith('calc_bld_copy_') ? decodeResultsEntries(copyId, buffs) : [];
}

// ─── Calculation ──────────────────────────────────────────────────────────────

/**
 * Calculates the total resource cost, build time, and building requirements
 * for upgrading a building from `fromKey` to `toKey`.
 * @param {object} buildingData - Data object for the specific building
 * @param {string} fromKey      - Starting level key
 * @param {string} toKey        - Target level key
 * @param {object} buffs        - User buff settings
 * @returns {{ totals, totalSeconds, reducedSeconds, maxBuildingReqs, numLevels } | null}
 */
function calculateUpgrade(buildingData, fromKey, toKey, buffs) {
    if (!buildingData) return null;

    const levelKeys = getBuildingLevelKeys(buildingData);
    const fromIdx   = fromKey === '0' ? -1 : levelKeys.indexOf(String(fromKey));
    const toIdx     = levelKeys.indexOf(String(toKey));

    if ((fromIdx === -1 && fromKey !== '0') || toIdx === -1 || fromIdx >= toIdx) return null;

    // Resource reduction comes from Zinman level
    const resourceReduction  = ZINMAN_REDUCE[clamp5(buffs?.zinmanLevel)] / 100;

    // Combined speed %: manual input + VP/DT flat bonus + pet bonus
    const totalSpeedPct      = (Number(buffs?.constructionSpeed) || 0)
        + (Number(buffs?.flatSpeedBonus) || 0)
        + PET_SPEED[clamp5(buffs?.petLevel)];

    // Expert: fixed seconds removed per level upgraded
    const expertSecsPerLevel = EXPERT_SECS[clamp5(buffs?.expertLevel)];

    const totals          = { ...EMPTY_TOTALS };
    const maxBuildingReqs = {};
    let totalSeconds = 0;
    let numLevels    = 0;

    // Sum the cost for each level after fromIdx (fromKey is the current level, already paid)
    for (let i = fromIdx + 1; i <= toIdx; i++) {
        const levelData = buildingData[levelKeys[i]];
        if (!levelData) continue;

        if (levelData.cost) {
            for (const [res, amt] of Object.entries(levelData.cost)) {
                let amount = parseFloat(amt) || 0;
                if (resourceReduction > 0 && BASIC_RESOURCES.has(res)) {
                    amount = Math.ceil(amount * (1 - resourceReduction));
                }
                if (Object.hasOwn(totals, res)) totals[res] += amount;
            }
        }

        if (levelData.time) {
            const { days = 0, hours = 0, minutes = 0, seconds = 0 } = levelData.time;
            totalSeconds += days * 86400 + hours * 3600 + minutes * 60 + seconds;
        }

        // Track max required level per prerequisite building
        const buildingReqs = levelData.requirements?.buildings;
        if (buildingReqs) {
            const parsedReqs = Object.fromEntries(
                Object.entries(buildingReqs)
                    .map(([k, v]) => [k, parseInt(v)])
                    .filter(([, v]) => !isNaN(v) && v > 0)
            );
            mergeRequirements(maxBuildingReqs, parsedReqs);
        }

        numLevels++;
    }

    // Apply construction speed: time / (1 + speed%)
    const speedReduced = totalSpeedPct > 0
        ? Math.ceil(totalSeconds / (1 + totalSpeedPct / 100))
        : totalSeconds;

    // Apply expert: subtract fixed seconds per level upgraded (minimum 0)
    const reducedSeconds = Math.max(0, speedReduced - expertSecsPerLevel * numLevels);

    return { totals, totalSeconds, reducedSeconds, maxBuildingReqs, numLevels };
}

/**
 * Decodes all upgrade entries from a copy-button customId.
 * @param {string} copyId  full customId string
 * @param {object} buffs
 * @returns {{type,bldId,fromKey,toKey,result}[]}
 */
function decodeResultsEntries(copyId, buffs) {
    if (!copyId.startsWith('calc_bld_copy_')) return [];
    const withoutPrefix = copyId.slice('calc_bld_copy_'.length); // "{encoded}_{userId}"
    const lastUnderscore = withoutPrefix.lastIndexOf('_');
    if (lastUnderscore === -1) return [];
    let encoded = withoutPrefix.slice(0, lastUnderscore);

    // Decompress Base85 if flagged with leading '~'
    if (encoded.startsWith('~')) {
        try {
            const lib = getAscii85();
            if (!lib) return [];
            encoded = lib.decode(encoded.slice(1)).toString('utf8');
        } catch { return []; }
    }

    // Parse "{type}:{seg1}.{seg2}..."
    const colonIdx = encoded.indexOf(':');
    if (colonIdx === -1) return [];
    const type = encoded.slice(0, colonIdx);
    const segsStr = encoded.slice(colonIdx + 1);

    return segsStr.split('.').flatMap(seg => {
        if (seg.length < 4) return [];
        const cShort = seg.slice(0, 2);
        const bldId = SHORT_TO_BUILDING[cShort];
        const levelStr = seg.slice(2);
        const dashIdx = levelStr.indexOf('-');
        if (dashIdx === -1 || !bldId) return [];
        const fromKey = levelStr.slice(0, dashIdx);
        const toKey = levelStr.slice(dashIdx + 1);
        const result = calculateUpgrade(getDataObj(type)[bldId], fromKey, toKey, buffs);
        return result ? [{ type, bldId, fromKey, toKey, result }] : [];
    });
}

/**
 * Encodes upgrade entries into the copy-button customId.
 * All entries must share the same type (guaranteed by single-type session flow).
 * Applies Base85 compression when it reduces the length.
 * @param {{ type, bldId, fromKey, toKey }[]} entries
 * @param {string} userId
 * @returns {string | null} null if the final customId would exceed 100 characters
 */
function encodeResultsCustomId(entries, userId) {
    if (!entries?.length) return null;
    const type = entries[0].type; // all entries share the same type
    const segs = entries.map(e => `${BUILDING_SHORT[e.bldId] ?? e.bldId}${e.fromKey}-${e.toKey}`);
    const plain = `${type}:${segs.join('.')}`;

    let payload = plain;
    try {
        const lib = getAscii85();
        if (lib) {
            const b85 = lib.encode(Buffer.from(plain, 'utf8')).toString();
            if (b85.length + 1 < plain.length) payload = `~${b85}`; // '~' signals Base85
        }
    } catch { /* keep plain */ }

    const full = `calc_bld_copy_${payload}_${userId}`;
    return full.length <= 100 ? full : null;
}

// ─── UI builders ──────────────────────────────────────────────────────────────

/**
 * Builds the plain-text copy summary for all accumulated upgrade entries (sent via DM).
 * @param {{ type, bldId, fromKey, toKey, result }[]} entries
 * @param {object} buffs
 * @param {object} lang
 */
function buildCopySummary(entries, buffs, lang) {
    const lc             = lang.calculators.buildings;
    const buildingNames  = getBuildingNames(lang);
    const resourceLabels = getResourceLabels(lang);
    const { totalRes, totalSeconds, reducedSeconds, totalNumLevels, maxBuildingReqs } = aggregateEntries(entries);

    const lines = [lc.results.upgradePlan];

    // Per-entry upgrade summary
    lines.push(lc.results.buildingsList);
    for (const e of entries) {
        const bldName   = buildingNames[e.bldId] || e.bldId;
        const dataObj   = getDataObj(e.type);
        const fromDisp  = dataObj[e.bldId] ? getLevelDisplay(e.fromKey, e.type, lang) : e.fromKey;
        const toDisp    = dataObj[e.bldId] ? getLevelDisplay(e.toKey,   e.type, lang) : e.toKey;
        lines.push(`  - ${bldName}: ${fromDisp} → ${toDisp}`);
    }

    // Resources
    const nonZero = Object.entries(totalRes).filter(([, v]) => v > 0);
    if (nonZero.length > 0) {
        lines.push(lc.results.resourcesRequired);
        for (const [res, amt] of nonZero) lines.push(`  - ${resourceLabels[res] || res}: ${formatNumber(amt)}`);
    }

    // Time
    lines.push(lc.results.buildTime);
    lines.push(lc.results.original.replace('{time}', formatSeconds(totalSeconds)));
    if (hasAnyBuff(buffs)) lines.push(lc.results.withBuffs.replace('{time}', formatSeconds(reducedSeconds)));

    // Building requirements
    appendRequirementLines(lines, maxBuildingReqs, buildingNames, lc.results.requirements, lc.results.requirementLevel, lang);

    // Applied buffs
    if (hasAnyBuff(buffs)) {
        const buffParts = [];
        if (buffs.flatSpeedBonus > 0)    buffParts.push(getFlatSpeedLabel(buffs.flatSpeedBonus, lang));
        if (buffs.petLevel > 0)          buffParts.push(lc.results.buffs.pet.replace('{n}', buffs.petLevel).replace('{pct}', PET_SPEED[buffs.petLevel]));
        if (buffs.zinmanLevel > 0)       buffParts.push(lc.results.buffs.zinman.replace('{n}', buffs.zinmanLevel).replace('{pct}', ZINMAN_REDUCE[buffs.zinmanLevel]));
        if (buffs.expertLevel > 0)       buffParts.push(lc.results.buffs.expert.replace('{n}', buffs.expertLevel).replace('{time}', formatSeconds(EXPERT_SECS[buffs.expertLevel])).replace('{levels}', totalNumLevels));
        if (buffs.constructionSpeed > 0) buffParts.push(lc.results.buffs.constructionSpeed.replace('{pct}', buffs.constructionSpeed));
        lines.push(lc.results.buffsLine.replace('{parts}', buffParts.join('\n  - ')));
    }

    return lines.join('\n');
}

/**
 * Container shown after clicking "Buildings" — lets user pick Basic or Fire Crystal
 */
function buildTypeSelectionContainer(userId, lang) {
    const lc = lang.calculators.buildings;
    const basicBtn = new ButtonBuilder()
        .setCustomId(`calc_building_basic_${userId}`)
        .setLabel(lc.buttons.basic)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(userId), '1040'));

    const fcBtn = new ButtonBuilder()
        .setCustomId(`calc_building_fc_${userId}`)
        .setLabel(lc.buttons.fireCrystal)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(userId), '1012'));

    return new ContainerBuilder()
        .setAccentColor(0x3498db)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(lc.header.typeSelection)
        )
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addActionRowComponents(new ActionRowBuilder().addComponents(basicBtn, fcBtn));
}

/**
 * Controls container — building select, optional level selects, buffs + back buttons.
 * @param {string} type - 'b' (basic) or 'f' (fire crystal)
 * @param {string} bldId - Building key or 'x' if not yet selected
 * @param {string} fromKey - From-level key or 'x' if not yet selected
 * @param {string} toKey - To-level key or 'x' if not yet selected
 * @param {number} pageFrom - Current page (0-based) for from-level select
 * @param {number} pageTo - Current page (0-based) for to-level select
 * @param {string} userId
 */
function buildControlsContainer(type, bldId, fromKey, toKey, pageFrom, pageTo, userId, lang) {
    const lc            = lang.calculators.buildings;
    const buildingNames = getBuildingNames(lang);
    const dataObj       = getDataObj(type);
    const emojiMap      = getEmojiMapForUser(userId);

    // Header line — type title only
    const headerText = lc.header.controls.replace('{type}', getTypeLabel(type, lang));

    // Building select (always shown, no default so the menu resets after selection)
    const bldOptions = Object.keys(dataObj).map(id => ({
        label: buildingNames[id] || id,
        value: id,
        default: false
    }));

    const bldSelect = new StringSelectMenuBuilder()
        .setCustomId(`calc_bld_select_${type}_${userId}`)
        .setPlaceholder(lc.placeholders.selectBuilding)
        .addOptions(bldOptions.slice(0, 25));

    const container = new ContainerBuilder()
        .setAccentColor(0x3498db)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(headerText))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));

    // Show selected building name, then from-level below it (both as text, above the select menu)
    if (bldId !== 'x' && dataObj[bldId]) {
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(lc.header.selected.replace('{name}', buildingNames[bldId] || bldId))
        );
        if (fromKey !== 'x') {
            container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(lc.header.from.replace('{level}', getLevelDisplay(fromKey, type, lang)))
            );
        }
    }

    container.addActionRowComponents(new ActionRowBuilder().addComponents(bldSelect));

    // ── Level select rows ──────────────────────────────────────────────────────
    let needFromPagination = false, needToPagination = false;
    let fromPrevPage = -1, fromNextPage = -1;
    let toPrevPage = -1, toNextPage = -1;

    if (bldId !== 'x' && dataObj[bldId]) {
        const levelKeys = getBuildingLevelKeys(dataObj[bldId]);

        if (fromKey === 'x') {
            // Conditionally prepend "Not Built" (level 0) based on building type and cost data
            const notBuilt = shouldShowNotBuilt(type, bldId, dataObj);
            const fromLevelKeys = notBuilt ? ['0', ...levelKeys.slice(0, -1)] : levelKeys.slice(0, -1);
            const pf = Math.max(0, parseInt(pageFrom) || 0);
            const startFrom = pf * PAGE_SIZE;
            const sliceFrom = fromLevelKeys.slice(startFrom, startFrom + PAGE_SIZE);

            if (sliceFrom.length > 0) {
                container.addActionRowComponents(
                    new ActionRowBuilder().addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId(`calc_bld_from_${type}_${bldId}_${pf}_${userId}`)
                            .setPlaceholder(lc.placeholders.selectStartingLevel)
                            .addOptions(sliceFrom.map(key => ({ label: getLevelDisplay(key, type, lang), value: key, default: false })))
                    )
                );

                if (fromLevelKeys.length > PAGE_SIZE) {
                    needFromPagination = true;
                    fromPrevPage = pf > 0 ? pf - 1 : -1;
                    fromNextPage = startFrom + PAGE_SIZE < fromLevelKeys.length ? pf + 1 : -1;
                }
            }
        } else {
            // from-level already chosen — show to-level select
            const fromIdx = fromKey === '0' ? -1 : levelKeys.indexOf(fromKey);
            const toKeys = levelKeys.slice(fromIdx + 1);
            const pt = Math.max(0, parseInt(pageTo) || 0);
            const startTo = pt * PAGE_SIZE;
            const sliceTo = toKeys.slice(startTo, startTo + PAGE_SIZE);

            if (sliceTo.length > 0) {
                container.addActionRowComponents(
                    new ActionRowBuilder().addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId(`calc_bld_to_${type}_${bldId}_${fromKey}_${pt}_${userId}`)
                            .setPlaceholder(lc.placeholders.selectTargetLevel)
                            .addOptions(sliceTo.map(key => ({ label: getLevelDisplay(key, type, lang), value: key, default: key === toKey })))
                    )
                );

                if (toKeys.length > PAGE_SIZE) {
                    needToPagination = true;
                    toPrevPage = pt > 0 ? pt - 1 : -1;
                    toNextPage = startTo + PAGE_SIZE < toKeys.length ? pt + 1 : -1;
                }
            }
        }
    }

    // ── Bottom action row: [◀Prev] [▶Next] [⚙ Buffs] [◀ Back] ─────────────────
    const bottomButtons = [];

    if (needFromPagination) {
        const pf = Math.max(0, parseInt(pageFrom) || 0);
        if (fromPrevPage >= 0) bottomButtons.push(new ButtonBuilder().setCustomId(`calc_bld_fprev_${type}_${bldId}_${pf}_${userId}`).setLabel(lc.buttons.prev).setStyle(ButtonStyle.Secondary).setEmoji(getComponentEmoji(emojiMap, '1019')));
        if (fromNextPage >= 0) bottomButtons.push(new ButtonBuilder().setCustomId(`calc_bld_fnext_${type}_${bldId}_${pf}_${userId}`).setLabel(lc.buttons.next).setStyle(ButtonStyle.Secondary).setEmoji(getComponentEmoji(emojiMap, '1034')));
    }

    if (needToPagination) {
        const pt = Math.max(0, parseInt(pageTo) || 0);
        if (toPrevPage >= 0) bottomButtons.push(new ButtonBuilder().setCustomId(`calc_bld_tprev_${type}_${bldId}_${fromKey}_${pt}_${userId}`).setLabel(lc.buttons.prev).setStyle(ButtonStyle.Secondary).setEmoji(getComponentEmoji(emojiMap, '1019')));
        if (toNextPage >= 0) bottomButtons.push(new ButtonBuilder().setCustomId(`calc_bld_tnext_${type}_${bldId}_${fromKey}_${pt}_${userId}`).setLabel(lc.buttons.next).setStyle(ButtonStyle.Secondary).setEmoji(getComponentEmoji(emojiMap, '1034')));
    }

    bottomButtons.push(
        new ButtonBuilder()
            .setCustomId(`calc_building_buffs_${type}_${bldId}_${fromKey}_${toKey}_${userId}`)
            .setLabel(lc.buttons.buffs)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(getComponentEmoji(emojiMap, '1035')),
        new ButtonBuilder()
            .setCustomId(`calc_building_back_${userId}`)
            .setLabel(lc.buttons.back)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(getComponentEmoji(emojiMap, '1002'))
    );

    container.addActionRowComponents(new ActionRowBuilder().addComponents(...bottomButtons));

    return container;
}

/**
 * Builds the aggregated results container for all accumulated upgrade entries.
 * @param {{ type, bldId, fromKey, toKey, result }[]} entries
 * @param {object} buffs
 * @param {string} userId
 * @param {object} lang
 */
function buildResultsContainer(entries, buffs, userId, lang, activeState) {
    const lc             = lang.calculators.buildings;
    const buildingNames  = getBuildingNames(lang);
    const resourceLabels = getResourceLabels(lang);
    const { totalRes, totalSeconds, reducedSeconds, totalNumLevels, maxBuildingReqs } = aggregateEntries(entries);
    const buffActive     = hasAnyBuff(buffs);

    const lines = [lc.results.upgradePlan];

    // Per-entry upgrade summary
    lines.push(lc.results.buildingsList);
    for (const e of entries) {
        const bldName  = buildingNames[e.bldId] || e.bldId;
        const dataObj  = getDataObj(e.type);
        const fromDisp = dataObj[e.bldId] ? getLevelDisplay(e.fromKey, e.type, lang) : e.fromKey;
        const toDisp   = dataObj[e.bldId] ? getLevelDisplay(e.toKey,   e.type, lang) : e.toKey;
        lines.push(`  - ${bldName}: ${fromDisp} → ${toDisp}`);
    }

    // Resources (non-zero only)
    const nonZero = Object.entries(totalRes).filter(([, v]) => v > 0);
    if (nonZero.length > 0) {
        lines.push(lc.results.resourcesRequired);
        for (const [res, amt] of nonZero) lines.push(`  - ${resourceLabels[res] || res}: **${formatNumber(amt)}**`);
    }

    // Build time
    lines.push(lc.results.buildTime);
    lines.push(lc.results.original.replace('{time}', formatSeconds(totalSeconds)));
    if (buffActive) lines.push(lc.results.withBuffs.replace('{time}', formatSeconds(reducedSeconds)));

    // Building requirements
    appendRequirementLines(lines, maxBuildingReqs, buildingNames, lc.results.requirements, lc.results.requirementLevel, lang);

    // Applied buffs summary
    if (buffActive) {
        const buffParts = [];
        if (buffs.constructionSpeed > 0) buffParts.push(lc.results.buffs.constructionSpeed.replace('{pct}', buffs.constructionSpeed));
        if (buffs.flatSpeedBonus > 0)    buffParts.push(getFlatSpeedLabel(buffs.flatSpeedBonus, lang));
        if (buffs.petLevel > 0)          buffParts.push(lc.results.buffs.pet.replace('{n}', buffs.petLevel).replace('{pct}', PET_SPEED[buffs.petLevel]));
        if (buffs.zinmanLevel > 0)       buffParts.push(lc.results.buffs.zinman.replace('{n}', buffs.zinmanLevel).replace('{pct}', ZINMAN_REDUCE[buffs.zinmanLevel]));
        if (buffs.expertLevel > 0)       buffParts.push(lc.results.buffs.expert.replace('{n}', buffs.expertLevel).replace('{time}', formatSeconds(EXPERT_SECS[buffs.expertLevel])).replace('{levels}', totalNumLevels));
        lines.push(lc.results.buffsLine.replace('{parts}', buffParts.join('\n  - ')));
    }

    // Copy button — encodes all entries into the customId
    const copyId   = encodeResultsCustomId(entries, userId);
    const emojiMap = getEmojiMapForUser(userId);
    const copyBtn  = new ButtonBuilder()
        .setCustomId(copyId ?? `calc_bld_copy_overflow_${userId}`)
        .setLabel(lc.buttons.copy)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!copyId)
        .setEmoji(getComponentEmoji(emojiMap, '1021'));

    // Remove button — opens a modal to select entries to remove
    const { type: ct, bldId: cb, fromKey: cf, toKey: ck } = activeState || {};
    const removeBtn = new ButtonBuilder()
        .setCustomId(`calc_bld_remove_${ct || 'x'}_${cb || 'x'}_${cf || 'x'}_${ck || 'x'}_${userId}`)
        .setLabel(lc.buttons.remove)
        .setStyle(ButtonStyle.Danger);

    return new ContainerBuilder()
        .setAccentColor(0x2ecc71)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))
        .addActionRowComponents(new ActionRowBuilder().addComponents(copyBtn, removeBtn));
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * Bootstraps an interaction handler: verifies the button owner, extracts parts,
 * and resolves the user's current language.
 * Returns null (and defers the reply) if the user check fails.
 * @param {import('discord.js').Interaction} interaction
 * @returns {Promise<{ parts: string[], userId: string, lang: object } | null>}
 */
async function initHandler(interaction) {
    const parts  = interaction.customId.split('_');
    const userId = parts[parts.length - 1];
    if (!(await assertUserMatches(interaction, userId))) return null;
    const { lang } = getUserInfo(userId);
    return { parts, userId, lang };
}

/**
 * Handles the "Buildings" button on the /calculators panel.
 * CustomId: calc_main_buildings_{userId}
 */
async function handleBuildingsButton(interaction) {
    try {
        const ctx = await initHandler(interaction);
        if (!ctx) return;
        const { userId, lang } = ctx;

        if (!checkFeatureAccess('calculators', interaction)) {
            return await interaction.reply({ content: lang.common.noPermission, ephemeral: true });
        }

        const typeContainer = buildTypeSelectionContainer(userId, lang);
        const updatedComponents = updateComponentsV2AfterSeparator(interaction, [typeContainer]);
        await interaction.update({ components: updatedComponents, flags: MessageFlags.IsComponentsV2 });
    } catch (err) {
        await handleError(interaction, null, err, 'handleBuildingsButton');
    }
}

/**
 * Handles "Basic Buildings" or "Fire Crystal Buildings" type selection button.
 * Drops the original /calculators panel — from here the message has only 2 containers.
 * CustomId: calc_building_basic_{userId}  |  calc_building_fc_{userId}
 */
async function handleBuildingTypeSelection(interaction) {
    try {
        const ctx = await initHandler(interaction);
        if (!ctx) return;
        const { userId, lang } = ctx;

        if (!checkFeatureAccess('calculators', interaction)) {
            return await interaction.reply({ content: lang.common.noPermission, ephemeral: true });
        }

        const type = interaction.customId.includes('_basic_') ? 'b' : 'f';
        const controlsContainer = buildControlsContainer(type, 'x', 'x', 'x', 0, 0, userId, lang);

        // Drop the original /calculators panel — start fresh with just the controls
        await interaction.update({ components: [controlsContainer], flags: MessageFlags.IsComponentsV2 });
    } catch (err) {
        await handleError(interaction, null, err, 'handleBuildingTypeSelection');
    }
}

/**
 * Handles building selection from the select menu.
 * CustomId: calc_bld_select_{type}_{userId}
 */
async function handleBuildingSelect(interaction) {
    try {
        const ctx = await initHandler(interaction);
        if (!ctx) return;
        const { parts, userId, lang } = ctx;
        // parts: ['calc', 'bld', 'select', type, userId]
        const type = parts[3];
        const bldId = interaction.values[0];
        const existingResults = interaction.message.components.length > 1
            ? interaction.message.components.slice(1) : [];

        await interaction.update({
            components: [buildControlsContainer(type, bldId, 'x', 'x', 0, 0, userId, lang), ...existingResults],
            flags: MessageFlags.IsComponentsV2
        });
    } catch (err) {
        await handleError(interaction, null, err, 'handleBuildingSelect');
    }
}

/**
 * Handles from-level selection.
 * customId: calc_bld_from_{type}_{bldId}_{page}_{userId}
 */
async function handleBuildingFromLevelSelect(interaction) {
    try {
        const ctx = await initHandler(interaction);
        if (!ctx) return;
        const { parts, userId, lang } = ctx;
        // parts: ['calc', 'bld', 'from', type, bldId, page, userId]
        const type    = parts[3];
        const bldId   = parts[4];
        const fromKey = interaction.values[0];
        const existingResults = interaction.message.components.length > 1
            ? interaction.message.components.slice(1) : [];

        // fromKey shown as text in the header; preserve any accumulated results above
        await interaction.update({
            components: [buildControlsContainer(type, bldId, fromKey, 'x', 0, 0, userId, lang), ...existingResults],
            flags: MessageFlags.IsComponentsV2
        });
    } catch (err) {
        await handleError(interaction, null, err, 'handleBuildingFromLevelSelect');
    }
}

/**
 * Handles to-level selection — triggers calculation and shows results.
 * CustomId: calc_bld_to_{type}_{bldId}_{fromKey}_{page}_{userId}
 */
async function handleBuildingToLevelSelect(interaction) {
    try {
        const ctx = await initHandler(interaction);
        if (!ctx) return;
        const { parts, userId, lang } = ctx;
        // parts: ['calc', 'bld', 'to', type, bldId, fromKey, page, userId]
        const type    = parts[3];
        const bldId   = parts[4];
        const fromKey = parts[5];
        const toKey   = interaction.values[0];

        const buffs  = getUserBuffs(userId);
        const result = calculateUpgrade(getDataObj(type)[bldId], fromKey, toKey, buffs);

        if (!result) {
            return await interaction.reply({
                content: lang.calculators.buildings.errors.calcFailed,
                ephemeral: true
            });
        }

        // Decode existing entries from the single results container (if present),
        // then overwrite any existing entry for the same building, and append the new one.
        const existingEntries = getExistingEntries(interaction.message, buffs);
        const allEntries      = [...existingEntries.filter(e => e.bldId !== bldId), { type, bldId, fromKey, toKey, result }];

        await interaction.update({
            components: [
                buildControlsContainer(type, bldId, fromKey, toKey, 0, 0, userId, lang),
                buildResultsContainer(allEntries, buffs, userId, lang, { type, bldId, fromKey, toKey })
            ],
            flags: MessageFlags.IsComponentsV2
        });
    } catch (err) {
        await handleError(interaction, null, err, 'handleBuildingToLevelSelect');
    }
}

/**
 * Handles pagination for from-level select menu.
 * CustomId: calc_bld_fprev_{type}_{bldId}_{curPage}_{userId}
 *           calc_bld_fnext_{type}_{bldId}_{curPage}_{userId}
 */
async function handleBuildingFromLevelPage(interaction) {
    try {
        const ctx = await initHandler(interaction);
        if (!ctx) return;
        const { parts, userId, lang } = ctx;
        // parts: ['calc', 'bld', 'fprev'|'fnext', type, bldId, curPage, userId]
        const direction = parts[2]; // 'fprev' or 'fnext'
        const type      = parts[3];
        const bldId     = parts[4];
        const curPage   = parseInt(parts[5]) || 0;
        const newPage   = direction === 'fnext' ? curPage + 1 : Math.max(0, curPage - 1);
        const existingResults = interaction.message.components.length > 1
            ? interaction.message.components.slice(1) : [];

        await interaction.update({
            components: [buildControlsContainer(type, bldId, 'x', 'x', newPage, 0, userId, lang), ...existingResults],
            flags: MessageFlags.IsComponentsV2
        });
    } catch (err) {
        await handleError(interaction, null, err, 'handleBuildingFromLevelPage');
    }
}

/**
 * Handles pagination for to-level select menu.
 * CustomId: calc_bld_tprev_{type}_{bldId}_{fromKey}_{curPage}_{userId}
 *           calc_bld_tnext_{type}_{bldId}_{fromKey}_{curPage}_{userId}
 */
async function handleBuildingToLevelPage(interaction) {
    try {
        const ctx = await initHandler(interaction);
        if (!ctx) return;
        const { parts, userId, lang } = ctx;
        // parts: ['calc', 'bld', 'tprev'|'tnext', type, bldId, fromKey, curPage, userId]
        const direction = parts[2]; // 'tprev' or 'tnext'
        const type      = parts[3];
        const bldId     = parts[4];
        const fromKey   = parts[5];
        const curPage   = parseInt(parts[6]) || 0;
        const newPage   = direction === 'tnext' ? curPage + 1 : Math.max(0, curPage - 1);
        const existingResults = interaction.message.components.length > 1
            ? interaction.message.components.slice(1) : [];

        await interaction.update({
            components: [buildControlsContainer(type, bldId, fromKey, 'x', 0, newPage, userId, lang), ...existingResults],
            flags: MessageFlags.IsComponentsV2
        });
    } catch (err) {
        await handleError(interaction, null, err, 'handleBuildingToLevelPage');
    }
}

/**
 * Shows the buffs configuration modal.
 * Uses LabelBuilder (Discord.js v14 new modal API) for select menus inside modals.
 * Modal has 5 labels (max):
 *   1. VP / Double Time (combined flat-speed select)
 *   2. Pet (select Lv.1-5)
 *   3. Zinman (select Lv.1-5, resource reduction)
 *   4. Expert (select Lv.1-5, fixed time per upgrade)
 *   5. Construction Speed % (text input)
 * CustomId: calc_building_buffs_{type}_{bldId}_{fromKey}_{toKey}_{userId}
 */
async function handleBuildingBuffsButton(interaction) {
    try {
        const ctx = await initHandler(interaction);
        if (!ctx) return;
        const { parts, userId } = ctx;
        // parts: ['calc', 'building', 'buffs', type, bldId, fromKey, toKey, userId]
        const type    = parts[3];
        const bldId   = parts[4];
        const fromKey = parts[5];
        const toKey   = parts[6];

        const cur = getUserBuffs(userId);

        const modal = new ModalBuilder()
            .setCustomId(`calc_buffs_modal_${type}_${bldId}_${fromKey}_${toKey}_${userId}`)
            .setTitle('Calculator Buffs');

        // ── 1. VP / Double Time ───────────────────────────────────────────────
        const flatSpeedSelect = new StringSelectMenuBuilder()
            .setCustomId('flat_speed_bonus')
            .setPlaceholder('Select VP / Double Time')
            .setRequired(false)
            .addOptions(
                new StringSelectMenuOptionBuilder().setLabel('Off').setValue('0').setDefault(cur.flatSpeedBonus === 0),
                new StringSelectMenuOptionBuilder().setLabel('VP 10%').setValue('10').setDefault(cur.flatSpeedBonus === 10),
                new StringSelectMenuOptionBuilder().setLabel('VP 15%').setValue('15').setDefault(cur.flatSpeedBonus === 15),
                new StringSelectMenuOptionBuilder().setLabel('Double Time (+20%)').setValue('20').setDefault(cur.flatSpeedBonus === 20),
                new StringSelectMenuOptionBuilder().setLabel('VP 10% + Double Time (+30%)').setValue('30').setDefault(cur.flatSpeedBonus === 30),
                new StringSelectMenuOptionBuilder().setLabel('VP 15% + Double Time (+35%)').setValue('35').setDefault(cur.flatSpeedBonus === 35)
            );
        const flatSpeedLabel = new LabelBuilder()
            .setLabel('VP / Double Time Bonus')
            .setStringSelectMenuComponent(flatSpeedSelect);

        // ── 2. Pet ────────────────────────────────────────────────────────────
        const petSelect = new StringSelectMenuBuilder()
            .setCustomId('pet_level')
            .setPlaceholder('Select pet level')
            .setRequired(false)
            .addOptions(
                new StringSelectMenuOptionBuilder().setLabel('Off').setValue('0').setDefault(cur.petLevel === 0),
                new StringSelectMenuOptionBuilder().setLabel('Level 1 (+5% speed)').setValue('1').setDefault(cur.petLevel === 1),
                new StringSelectMenuOptionBuilder().setLabel('Level 2 (+7% speed)').setValue('2').setDefault(cur.petLevel === 2),
                new StringSelectMenuOptionBuilder().setLabel('Level 3 (+9% speed)').setValue('3').setDefault(cur.petLevel === 3),
                new StringSelectMenuOptionBuilder().setLabel('Level 4 (+12% speed)').setValue('4').setDefault(cur.petLevel === 4),
                new StringSelectMenuOptionBuilder().setLabel('Level 5 (+15% speed)').setValue('5').setDefault(cur.petLevel === 5)
            );
        const petLabel = new LabelBuilder()
            .setLabel('Frost Wing Pet (Build Speed)')
            .setStringSelectMenuComponent(petSelect);

        // ── 3. Zinman ─────────────────────────────────────────────────────────
        const zinmanSelect = new StringSelectMenuBuilder()
            .setCustomId('zinman_level')
            .setPlaceholder('Select Zinman level')
            .setRequired(false)
            .addOptions(
                new StringSelectMenuOptionBuilder().setLabel('Off').setValue('0').setDefault(cur.zinmanLevel === 0),
                new StringSelectMenuOptionBuilder().setLabel('Level 1 (3% resource reduction)').setValue('1').setDefault(cur.zinmanLevel === 1),
                new StringSelectMenuOptionBuilder().setLabel('Level 2 (6% resource reduction)').setValue('2').setDefault(cur.zinmanLevel === 2),
                new StringSelectMenuOptionBuilder().setLabel('Level 3 (9% resource reduction)').setValue('3').setDefault(cur.zinmanLevel === 3),
                new StringSelectMenuOptionBuilder().setLabel('Level 4 (12% resource reduction)').setValue('4').setDefault(cur.zinmanLevel === 4),
                new StringSelectMenuOptionBuilder().setLabel('Level 5 (15% resource reduction)').setValue('5').setDefault(cur.zinmanLevel === 5)
            );
        const zinmanLabel = new LabelBuilder()
            .setLabel('Zinman (Resource Reduction)')
            .setStringSelectMenuComponent(zinmanSelect);

        // ── 4. Expert ─────────────────────────────────────────────────────────
        const expertSelect = new StringSelectMenuBuilder()
            .setCustomId('expert_level')
            .setPlaceholder('Select Expert level')
            .setRequired(false)
            .addOptions(
                new StringSelectMenuOptionBuilder().setLabel('Off').setValue('0').setDefault(cur.expertLevel === 0),
                new StringSelectMenuOptionBuilder().setLabel('Level 1 (−2h per upgrade)').setValue('1').setDefault(cur.expertLevel === 1),
                new StringSelectMenuOptionBuilder().setLabel('Level 2 (−3h per upgrade)').setValue('2').setDefault(cur.expertLevel === 2),
                new StringSelectMenuOptionBuilder().setLabel('Level 3 (−4h per upgrade)').setValue('3').setDefault(cur.expertLevel === 3),
                new StringSelectMenuOptionBuilder().setLabel('Level 4 (−6h per upgrade)').setValue('4').setDefault(cur.expertLevel === 4),
                new StringSelectMenuOptionBuilder().setLabel('Level 5 (−8h per upgrade)').setValue('5').setDefault(cur.expertLevel === 5)
            );
        const expertLabel = new LabelBuilder()
            .setLabel('Expert (Fixed Time Reduction)')
            .setStringSelectMenuComponent(expertSelect);

        // ── 5. Construction Speed % ────────────────────────────────────────────
        const speedInput = new TextInputBuilder()
            .setCustomId('construction_speed')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g. 150')
            .setValue(cur.constructionSpeed > 0 ? String(cur.constructionSpeed) : '')
            .setRequired(false);
        const speedLabel = new LabelBuilder()
            .setLabel('Construction Speed %')
            .setDescription('Manual construction speed buff (e.g. 150 for 150%)')
            .setTextInputComponent(speedInput);

        modal.addLabelComponents(flatSpeedLabel, petLabel, zinmanLabel, expertLabel, speedLabel);

        await interaction.showModal(modal);
    } catch (err) {
        await handleError(interaction, null, err, 'handleBuildingBuffsButton');
    }
}

/**
 * Saves buffs from the modal and recalculates if a full selection exists.
 * CustomId: calc_buffs_modal_{type}_{bldId}_{fromKey}_{toKey}_{userId}
 */
async function handleBuildingBuffsModal(interaction) {
    try {
        const ctx = await initHandler(interaction);
        if (!ctx) return;
        const { parts, userId, lang } = ctx;
        // parts: ['calc', 'buffs', 'modal', type, bldId, fromKey, toKey, userId]
        const type    = parts[3];
        const bldId   = parts[4];
        const fromKey = parts[5];
        const toKey   = parts[6];

        // Read select values (returns array; take first element or default to '0')
        const flatSpeedValues = interaction.fields.getStringSelectValues('flat_speed_bonus');
        const petValues = interaction.fields.getStringSelectValues('pet_level');
        const zinmanValues = interaction.fields.getStringSelectValues('zinman_level');
        const expertValues = interaction.fields.getStringSelectValues('expert_level');
        const rawSpeed = interaction.fields.getTextInputValue('construction_speed').trim();

        const buffs = {
            flatSpeedBonus: parseInt(flatSpeedValues[0] ?? '0') || 0,
            petLevel: clamp5(parseInt(petValues[0] ?? '0')),
            zinmanLevel: clamp5(parseInt(zinmanValues[0] ?? '0')),
            expertLevel: clamp5(parseInt(expertValues[0] ?? '0')),
            constructionSpeed: Math.max(0, parseFloat(rawSpeed) || 0)
        };

        // Persist buffs
        userQueries.upsertBuffs(userId, JSON.stringify(buffs));

        const controlsContainer = buildControlsContainer(type, bldId, fromKey, toKey, 0, 0, userId, lang);
        const entries           = getExistingEntries(interaction.message, buffs);
        const components        = entries.length > 0
            ? [controlsContainer, buildResultsContainer(entries, buffs, userId, lang, { type, bldId, fromKey, toKey })]
            : [controlsContainer];

        await interaction.update({ components, flags: MessageFlags.IsComponentsV2 });
    } catch (err) {
        await handleError(interaction, null, err, 'handleBuildingBuffsModal');
    }
}

/**
 * Sends the upgrade summary as a DM (falls back to channel if DMs are closed).
 * CustomId: calc_bld_copy_{type}_{bldId}_{fromKey}_{toKey}_{userId}
 */
async function handleBuildingCopyButton(interaction) {
    try {
        const ctx = await initHandler(interaction);
        if (!ctx) return;
        const { userId, lang } = ctx;
        // parts: ['calc', 'bld', 'copy', encoded, userId]
        // encoded = {type(1)}{shortCode(2)}{fromKey}-{toKey}  e.g. 'bFu30-35'

        const buffs   = getUserBuffs(userId);
        const entries = decodeResultsEntries(interaction.customId, buffs);

        if (entries.length === 0) {
            return await interaction.reply({ content: lang.calculators.buildings.errors.noSummary, ephemeral: true });
        }

        const content = buildCopySummary(entries, buffs, lang);

        // Try DM first; fall back to channel reply if DMs are closed
        try {
            await interaction.user.send({ content });
            await interaction.reply({ content: lang.calculators.buildings.errors.dmSent, ephemeral: true });
        } catch {
            await interaction.reply({ content });
        }
    } catch (err) {
        await handleError(interaction, null, err, 'handleBuildingCopyButton');
    }
}

/**
 * Shows a modal with a multi-select to remove entries from the plan.
 * CustomId: calc_bld_remove_{type}_{bldId}_{fromKey}_{toKey}_{userId}
 */
async function handleRemoveButton(interaction) {
    try {
        const ctx = await initHandler(interaction);
        if (!ctx) return;
        const { parts, userId, lang } = ctx;
        // parts: ['calc', 'bld', 'remove', type, bldId, fromKey, toKey, userId]
        const type    = parts[3];
        const bldId   = parts[4];
        const fromKey = parts[5];
        const toKey   = parts[6];

        const buffs   = getUserBuffs(userId);
        const entries = getExistingEntries(interaction.message, buffs);

        if (entries.length === 0) {
            return await interaction.reply({ content: lang.calculators.buildings.errors.noSummary, ephemeral: true });
        }

        const lc = lang.calculators.buildings;
        const rm = lc.removeModal;
        const buildingNames = getBuildingNames(lang);

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('remove_entries')
            .setPlaceholder(rm.placeholder)
            .setMinValues(1)
            .setMaxValues(entries.length)
            .addOptions(entries.map((e, i) => {
                const name = buildingNames[e.bldId] || e.bldId;
                return new StringSelectMenuOptionBuilder()
                    .setLabel(name)
                    .setValue(String(i));
            }));

        const label = new LabelBuilder()
            .setLabel(rm.label)
            .setStringSelectMenuComponent(selectMenu);

        const modal = new ModalBuilder()
            .setCustomId(`calc_bld_rmmodal_${type}_${bldId}_${fromKey}_${toKey}_${userId}`)
            .setTitle(rm.title)
            .addLabelComponents(label);

        await interaction.showModal(modal);
    } catch (err) {
        await handleError(interaction, null, err, 'handleRemoveButton');
    }
}

/**
 * Processes removal of selected entries from the plan.
 * CustomId: calc_bld_rmmodal_{type}_{bldId}_{fromKey}_{toKey}_{userId}
 */
async function handleRemoveModal(interaction) {
    try {
        const ctx = await initHandler(interaction);
        if (!ctx) return;
        const { parts, userId, lang } = ctx;
        // parts: ['calc', 'bld', 'rmmodal', type, bldId, fromKey, toKey, userId]
        const type    = parts[3];
        const bldId   = parts[4];
        const fromKey = parts[5];
        const toKey   = parts[6];

        const buffs     = getUserBuffs(userId);
        const entries   = getExistingEntries(interaction.message, buffs);
        const toRemove  = new Set(interaction.fields.getStringSelectValues('remove_entries'));
        const remaining = entries.filter((_, i) => !toRemove.has(String(i)));

        const controlsContainer = buildControlsContainer(type, bldId, fromKey, toKey, 0, 0, userId, lang);
        const components = remaining.length > 0
            ? [controlsContainer, buildResultsContainer(remaining, buffs, userId, lang, { type, bldId, fromKey, toKey })]
            : [controlsContainer];

        await interaction.update({ components, flags: MessageFlags.IsComponentsV2 });
    } catch (err) {
        await handleError(interaction, null, err, 'handleRemoveModal');
    }
}

module.exports = {
    handleBuildingsButton,
    handleBuildingTypeSelection,
    handleBuildingSelect,
    handleBuildingFromLevelSelect,
    handleBuildingToLevelSelect,
    handleBuildingFromLevelPage,
    handleBuildingToLevelPage,
    handleBuildingBuffsButton,
    handleBuildingBuffsModal,
    handleBuildingCopyButton,
    handleRemoveButton,
    handleRemoveModal
};