const https = require('https');
const crypto = require('crypto');
const {
    ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, FileBuilder, FileUploadBuilder,
    LabelBuilder, MessageFlags, ModalBuilder, TextDisplayBuilder, escapeMarkdown
} = require('discord.js');
const { getUserInfo, assertUserMatches } = require('../utility/commonFunctions');
const { acquireUpdateLock, releaseUpdateLock } = require('../Settings/updateCoordinator');
const { LIMITS, PluginUploadError, inspectPluginArchiveAsync, cleanupInspection, cleanupExpiredInspections } = require('./pluginArchive');
const { createBackToPluginsButton, createPluginsComponents } = require('./plugins');

const sessions = new Map();
const CONFIRMATION_MS = 5 * 60000;
const MAX_SESSIONS = 3;
try { cleanupExpiredInspections(); } catch (error) {
    console.warn('[PLUGINS] Upload cache cleanup deferred:', error.code || error.name);
}
const text = (value, max = 120) => escapeMarkdown(String(value).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max));
const format = (value, fields) => value.replace(/\{(\w+)\}/g, (match, key) => String(fields[key] ?? match));

function downloadZip(address, deadline = Date.now() + 20000, redirects = 0) {
    let url;
    try { url = new URL(address); } catch { return Promise.reject(new PluginUploadError('download')); }
    if (url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) ||
        (url.port && url.port !== '443') || url.username || url.password || redirects > 3 || Date.now() >= deadline) {
        return Promise.reject(new PluginUploadError('download'));
    }
    return new Promise((resolve, reject) => {
        let redirecting = false;
        const finish = (error, data) => { clearTimeout(timeout); error ? reject(error) : resolve(data); };
        const req = https.get(url, res => {
            res.on('error', () => { if (!redirecting) finish(new PluginUploadError('download')); });
            res.on('aborted', () => { if (!redirecting) finish(new PluginUploadError('download')); });
            if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                let next;
                try {
                    if (typeof res.headers.location !== 'string') throw new Error('Missing redirect');
                    next = new URL(res.headers.location, url).href;
                } catch { finish(new PluginUploadError('download')); req.destroy(); return; }
                redirecting = true;
                res.destroy();
                downloadZip(next, deadline, redirects + 1).then(data => finish(null, data), finish);
                return;
            }
            if (res.statusCode !== 200 || Number(res.headers['content-length']) > LIMITS.archive) {
                finish(new PluginUploadError(res.statusCode === 200 ? 'archiveLimit' : 'download'));
                req.destroy();
                return;
            }
            let size = 0;
            const chunks = [];
            res.on('data', chunk => {
                size += chunk.length;
                if (size > LIMITS.archive) { finish(new PluginUploadError('archiveLimit')); req.destroy(); }
                else chunks.push(chunk);
            });
            res.on('end', () => finish(null, Buffer.concat(chunks)));
        });
        const timeout = setTimeout(() => req.destroy(new PluginUploadError('download')), Math.max(1, deadline - Date.now()));
        req.on('error', error => { if (!redirecting) finish(error instanceof PluginUploadError ? error : new PluginUploadError('download')); });
    });
}

function dispose(session) {
    session.state = 'disposed';
    clearTimeout(session.timeout);
    sessions.delete(session.token);
    if (session.inspection) try { cleanupInspection(session.inspection); } catch (error) {
        console.warn('[PLUGINS] Could not remove upload staging:', error.code || error.name);
    }
}

async function authorized(interaction, ownerId) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    if (!(await assertUserMatches(interaction, ownerId, lang))) return null;
    if (!adminData?.is_owner) {
        await interaction.reply({ content: lang.common.noPermission, flags: MessageFlags.Ephemeral });
        return null;
    }
    return lang;
}

function container(session, lang, content, color = 0x9b59b6, row) {
    const view = new ContainerBuilder().setAccentColor(color);
    const components = createPluginsComponents({ user: { id: session.userId } }, lang, [view]);
    const mainLength = components[0].toJSON().components.reduce((length, component) => length + (component.content?.length || 0), 0);
    view.addTextDisplayComponents(new TextDisplayBuilder().setContent(content.slice(0, 4000 - mainLength)));
    if (row) view.addActionRowComponents(row);
    return { components,
        attachments: [], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}

function preview(session, lang) {
    const t = lang.plugins.upload;
    const info = session.inspection;
    const m = info.manifest;
    const compatibility = info.compatibility.bot || info.compatibility.node
        ? `bot: ${text(info.compatibility.bot || t.undeclared)}; Node.js: ${text(info.compatibility.node || t.undeclared)}`
        : t.undeclared;
    const lines = [t.title, t.thirdParty,
        `**${t.name}:** ${text(m.name)}`, `**${t.author}:** ${text(m.author || t.unknown)}`,
        `**${t.version}:** ${text(m.version)}`, `**${t.description}:** ${text(typeof m.description === 'string' ? m.description : t.none, 400)}`,
        `**${t.compatibility}:** ${compatibility}`, format(t.runtime, { bot: info.botVersion, node: info.nodeVersion }),
        format(t.files, { count: info.files.length, size: (info.expandedBytes / 1048576).toFixed(1) }),
        `SHA-256: \`${info.digest}\``, `\n${t.riskNotice}`, t.dependenciesNotice,
        info.restartRequired ? t.restartNotice : t.hotLoadNotice, t.expires, `\n**${t.checks}**`];
    if (info.blockers.length) {
        lines.push(t.blocked);
        for (const issue of info.blockers.slice(0, 3)) lines.push(`- ${t.errors[issue.code]}${issue.file ? ` (${text(issue.file.slice(0, 90))})` : ''}`);
    } else lines.push(t.validationPassed);
    for (const issue of info.findings.slice(0, 3)) lines.push(`- ${t.risks[issue.code]} (${text(issue.file.slice(0, 90))}${issue.line ? `:${issue.line}` : ''})`);
    if (info.findings.length > 3 || info.blockers.length > 3) lines.push(t.moreFindings);
    if (!info.findings.length) lines.push(t.noFindings);
    lines.push(t.reportAttached);
    const row = new ActionRowBuilder();
    if (!info.blockers.length) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Danger).setLabel(t.confirm)
        .setCustomId(`plugins_upload_confirm_${session.token}_${session.userId}`));
    row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel(t.cancel)
        .setCustomId(`plugins_upload_cancel_${session.token}_${session.userId}`));
    const report = [t.thirdParty, `SHA-256: ${info.digest}`, t.riskNotice, t.dependenciesNotice,
        ...info.blockers.map(issue => `${t.blocked} ${t.errors[issue.code]} ${issue.file}`),
        ...info.findings.map(issue => `${t.risks[issue.code]} ${issue.file}:${issue.line || '-'}`)].join('\n');
    const view = container(session, lang, lines.join('\n'), info.blockers.length ? 0xe74c3c : 0xe67e22, row);
    view.components[2].addFileComponents(new FileBuilder().setURL('attachment://plugin-risk-report.txt'));
    view.files = [new AttachmentBuilder(Buffer.from(report), { name: 'plugin-risk-report.txt' })];
    return view;
}

async function handlePluginUpload(interaction) {
    const lang = await authorized(interaction, interaction.customId.split('_').at(-1));
    if (!lang) return;
    const t = lang.plugins.upload;
    if ([...sessions.values()].some(session => session.userId === interaction.user.id)) {
        return interaction.reply({ content: t.busy, flags: MessageFlags.Ephemeral });
    }
    if (sessions.size >= MAX_SESSIONS) return interaction.reply({ content: t.capacity, flags: MessageFlags.Ephemeral });
    const session = { token: crypto.randomBytes(16).toString('hex'), userId: interaction.user.id,
        guildId: interaction.guildId, channelId: interaction.channelId, state: 'awaiting-file', expiresAt: Date.now() + CONFIRMATION_MS };
    sessions.set(session.token, session);
    session.timeout = setTimeout(() => {
        if (session.state === 'installing' || session.state === 'installed') return;
        dispose(session);
        if (session.interaction) session.interaction.editReply(container(session, lang, t.expired, 0x95a5a6)).catch(() => {});
    }, CONFIRMATION_MS);
    session.timeout.unref?.();
    const file = new FileUploadBuilder().setCustomId('plugin_zip').setRequired(true).setMinValues(1).setMaxValues(1);
    const modal = new ModalBuilder().setCustomId(`plugins_upload_file_${session.token}_${session.userId}`).setTitle(t.modalTitle)
        .addLabelComponents(new LabelBuilder().setLabel(t.fileLabel).setDescription(t.fileHelp).setFileUploadComponent(file));
    try { await interaction.showModal(modal); } catch (error) { dispose(session); throw error; }
}

async function getSession(interaction) {
    const parts = interaction.customId.split('_');
    const lang = await authorized(interaction, parts.at(-1));
    if (!lang) return null;
    const session = sessions.get(parts.at(-2));
    if (!session || session.userId !== interaction.user.id || session.guildId !== interaction.guildId ||
        session.channelId !== interaction.channelId || Date.now() >= session.expiresAt ||
        (parts[2] !== 'file' && (!session.messageId || session.messageId !== interaction.message?.id))) {
        await interaction.reply({ content: lang.plugins.upload.expired, flags: MessageFlags.Ephemeral });
        return null;
    }
    return { session, lang };
}

async function handlePluginUploadFile(interaction) {
    const context = await getSession(interaction);
    if (!context) return;
    const { session, lang } = context;
    const t = lang.plugins.upload;
    if (session.state !== 'awaiting-file') return interaction.reply({ content: t.busy, flags: MessageFlags.Ephemeral });
    session.state = 'inspecting';
    try {
        const files = interaction.fields.getUploadedFiles('plugin_zip');
        const file = files?.first();
        if (files?.size !== 1 || !file?.name?.toLowerCase().endsWith('.zip')) throw new PluginUploadError('invalidZip');
        if (file.size > LIMITS.archive) throw new PluginUploadError('archiveLimit');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        session.interaction = interaction;
        session.messageId = (await interaction.editReply(container(session, lang, t.inspecting))).id;
        const buffer = await downloadZip(file.url);
        if (!sessions.has(session.token) || Date.now() >= session.expiresAt) throw new PluginUploadError('expired');
        session.inspection = await inspectPluginArchiveAsync(buffer);
        if (sessions.get(session.token) !== session || Date.now() >= session.expiresAt) throw new PluginUploadError('expired');
        session.state = 'previewing';
        const message = await interaction.editReply(preview(session, lang));
        if (sessions.get(session.token) !== session || Date.now() >= session.expiresAt) throw new PluginUploadError('expired');
        session.messageId = message.id;
        session.state = 'preview';
    } catch (error) {
        dispose(session);
        if (session.navigatedAway) return;
        const content = t.errors[error?.code] || t.errors.inspectionFailed;
        if (interaction.deferred) await interaction.editReply(container(session, lang, content, 0xe74c3c));
        else await interaction.reply({ ...container(session, lang, content, 0xe74c3c), flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    }
}

async function handlePluginUploadConfirm(interaction) {
    const context = await getSession(interaction);
    if (!context) return;
    const { session, lang } = context;
    const t = lang.plugins.upload;
    if (sessions.get(session.token) !== session || session.state !== 'preview' || session.inspection.blockers.length) return interaction.reply({ content: t.errors.blocked, flags: MessageFlags.Ephemeral });
    const lock = acquireUpdateLock('third-party plugin installation');
    if (!lock.acquired) return interaction.reply({ content: t.updateBusy, flags: MessageFlags.Ephemeral });
    session.state = 'installing';
    try {
        await interaction.deferUpdate();
        await interaction.editReply(container(session, lang, t.installing));
        if (!getUserInfo(interaction.user.id).adminData?.is_owner) throw new PluginUploadError('permission');
        if (sessions.get(session.token) !== session || session.state !== 'installing') throw new PluginUploadError('expired');
        if (typeof global.pluginManager?.installUploaded !== 'function') throw new PluginUploadError('unavailable');
        const result = await global.pluginManager.installUploaded(session.inspection);
        if (!result?.success || !result.loaded) throw new PluginUploadError('loadFailed');
        session.state = 'installed';
        await interaction.editReply(container(session, lang, format(t.success, { name: text(result.name) }) + '\n' +
            (result.restartRequired ? t.restartNotice : t.hotLoadNotice), 0x2ecc71,
        new ActionRowBuilder().addComponents(createBackToPluginsButton(session.userId, lang.plugins))));
    } catch (error) {
        // A reply failure after a successful load must not misreport the installation itself.
        if (session.state !== 'installed') {
            await interaction.editReply(container(session, lang, t.errors[error?.code] || t.errors.loadFailed, 0xe74c3c));
        } else {
            await interaction.followUp({ ...container(session, lang, format(t.success, { name: text(session.inspection.manifest.name) }) + '\n' +
                (session.inspection.restartRequired ? t.restartNotice : t.hotLoadNotice), 0x2ecc71),
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral }).catch(() => {});
        }
    } finally {
        releaseUpdateLock(lock.token);
        dispose(session);
    }
}

async function handlePluginUploadCancel(interaction) {
    const context = await getSession(interaction);
    if (!context) return;
    const { session, lang } = context;
    if (sessions.get(session.token) !== session || session.state !== 'preview') return interaction.reply({ content: lang.plugins.upload.busy, flags: MessageFlags.Ephemeral });
    dispose(session);
    await interaction.update(container(session, lang, lang.plugins.upload.cancelled, 0x95a5a6,
        new ActionRowBuilder().addComponents(createBackToPluginsButton(session.userId, lang.plugins))));
}

function dismissPluginUploadOnNavigation(interaction) {
    if (!((interaction.customId.startsWith('plugins_') && !interaction.customId.startsWith('plugins_upload_')) ||
        interaction.customId.startsWith('back_to_panel_'))) return;
    for (const session of sessions.values()) {
        if (session.userId !== interaction.user.id || session.guildId !== interaction.guildId ||
            session.channelId !== interaction.channelId || !session.messageId || session.messageId !== interaction.message?.id ||
            session.state === 'installing' || session.state === 'installed') continue;
        session.navigatedAway = true;
        dispose(session);
    }
}

module.exports = { handlePluginUpload, handlePluginUploadFile, handlePluginUploadConfirm, handlePluginUploadCancel,
    dismissPluginUploadOnNavigation };
