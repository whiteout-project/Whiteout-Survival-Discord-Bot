# Universal Pagination System - Complete Guide

## Table of Contents
1. [What Problem Does This Solve?](#what-problem-does-this-solve)
2. [How It Works](#how-it-works)
3. [Implementation Guide](#implementation-guide)
4. [Code Examples](#code-examples)
5. [Quick Reference](#quick-reference)

---

## What Problem Does This Solve?

### Before: Inconsistent Pagination Everywhere

**4 different pagination patterns** across your files:

```javascript
// editAdmin.js - Pre-calculated page (WRONG!)
.setCustomId(`edit_admin_prev_${userId}_${page - 1}`)

// viewAdmin.js - Mixed approach
.setCustomId(`view_admin_next_${userId}_${page + 1}_${selectedId}`)

// movePlayers.js - Current page (CORRECT!)
.setCustomId(`move_players_source_prev_${userId}_${currentPage}`)

// Each file had different parsing logic (20-50 lines per file)
```

### After: One Universal Pattern

```javascript
// ALL FILES USE THIS:
const paginationRow = createUniversalPaginationButtons({
    feature: 'feature_name',
    userId: interaction.user.id,
    currentPage: page,
    totalPages: total,
    lang: lang
});

const { userId, newPage } = parsePaginationCustomId(interaction.customId, 0);
```

**Benefits:**
-  Consistent format everywhere
-  Automatic page calculation
-  60-70% less code
-  Fix once, works everywhere
-  Supports all use cases (simple, complex, with context)

---

## How It Works

### 1. Custom ID Format (Universal Standard)

```
{feature}_{subtype?}_{direction}_{userId}_{contextData...}_{currentPage}
```

**Examples:**
```
edit_admin_next_123456_2
↑          ↑    ↑      ↑
feature    dir  userId page

move_players_source_prev_123456_1
↑           ↑      ↑    ↑      ↑
feature     sub    dir  userId page

move_players_player_next_123456_5_10_3
↑           ↑      ↑    ↑      ↑ ↑  ↑
feature     sub    dir  userId │ │  page
                               │ └─ destId (context)
                               └─── sourceId (context)
```

### 2. The Two Functions

#### Function 1: `createUniversalPaginationButtons()`
**Purpose:** Creates prev/next buttons with consistent format

**Input:**
```javascript
{
    feature: 'edit_admin',      // Required: Feature name
    subtype: 'source',          // Optional: Sub-feature
    userId: '123456',           // Required: User ID
    currentPage: 2,             // Required: Current page (0-indexed)
    totalPages: 10,             // Required: Total pages
    lang: langObject,           // Required: Language object
    contextData: [id1, id2]     // Optional: Extra data
}
```

**Output:**
```javascript
ActionRowBuilder with buttons OR null (if totalPages <= 1)
```

**What it does:**
1. Validates input parameters
2. Builds custom IDs: `{feature}_{subtype?}_{direction}_{userId}_{context...}_{currentPage}`
3. Creates prev button (disabled if page = 0)
4. Creates next button (disabled if page = totalPages - 1)
5. Returns ActionRowBuilder with both buttons
6. Returns `null` if only 1 page (no pagination needed)

#### Function 2: `parsePaginationCustomId()`
**Purpose:** Extracts all data from button custom ID

**Input:**
```javascript
parsePaginationCustomId(
    'move_players_player_next_123456_5_10_3',  // Custom ID
    2                                          // Context data count
)
```

**Output:**
```javascript
{
    feature: 'move_players',
    subtype: 'player',
    direction: 'next',
    userId: '123456',
    currentPage: 3,
    newPage: 4,              // ← AUTOMATICALLY CALCULATED!
    contextData: ['5', '10']
}
```

**What it does:**
1. Splits custom ID by `_`
2. Extracts feature, subtype (if exists), direction, userId
3. Extracts context data (if any)
4. Gets current page from last part
5. **Calculates new page**: `currentPage ± 1` based on direction
6. Returns all parsed data

---

## Implementation Guide

### Step 1: Import the Helper

```javascript
// Add this to the top of your file
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../Pagination/universalPagination');
```

### Step 2: Replace Button Creation Code

#### Pattern A: Simple Pagination (No Context)
**Use Case:** view_alliances, view_gift_codes, editAdmin

**Before (20+ lines):**
```javascript
const paginationRow = new ActionRowBuilder();

if (page > 0) {
    paginationRow.addComponents(
        new ButtonBuilder()
            .setCustomId(`edit_admin_prev_${interaction.user.id}_${page - 1}`)
            .setLabel(lang.buttons.pagination.previousPage)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('⬅️')
    );
}

if (page < totalPages - 1) {
    paginationRow.addComponents(
        new ButtonBuilder()
            .setCustomId(`edit_admin_next_${interaction.user.id}_${page + 1}`)
            .setLabel(lang.buttons.pagination.nextPage)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('️')
    );
}

const components = [actionRow];
if (paginationRow.components.length > 0) {
    components.push(paginationRow);
}
```

**After (6 lines):**
```javascript
const paginationRow = createUniversalPaginationButtons({
    feature: 'edit_admin',
    userId: interaction.user.id,
    currentPage: page,
    totalPages: totalPages,
    lang: lang
});

const components = [actionRow];
if (paginationRow) {
    components.push(paginationRow);
}
```

#### Pattern B: With Subtype
**Use Case:** move_players_source, remove_players_alliance

**Example:**
```javascript
const paginationRow = createUniversalPaginationButtons({
    feature: 'move_players',
    subtype: 'source',       // ← Added subtype
    userId: interaction.user.id,
    currentPage: page,
    totalPages: totalPages,
    lang: lang
});

// Creates: move_players_source_next_123456_2
```

#### Pattern C: With Single Context
**Use Case:** view_admin (with selected admin), view_logs (with targetId)

**Example:**
```javascript
const paginationRow = createUniversalPaginationButtons({
    feature: 'view_admin',
    userId: interaction.user.id,
    currentPage: page,
    totalPages: totalPages,
    lang: lang,
    contextData: [selectedAdminId || 'none']  // ← Added context
});

// Creates: view_admin_prev_123456_adminId_5
```

#### Pattern D: With Multiple Context
**Use Case:** move_players_player (sourceId + destId)

**Example:**
```javascript
const paginationRow = createUniversalPaginationButtons({
    feature: 'move_players',
    subtype: 'player',
    userId: interaction.user.id,
    currentPage: page,
    totalPages: totalPages,
    lang: lang,
    contextData: [sourceAllianceId, destAllianceId]  // ← Multiple context
});

// Creates: move_players_player_next_123456_5_10_3
```

### Step 3: Replace Parsing Code in Handlers

#### Pattern A: No Context

**Before (3-5 lines):**
```javascript
const customIdParts = interaction.customId.split('_');
const expectedUserId = customIdParts[3];
const newPage = parseInt(customIdParts[4]);
```

**After (1 line):**
```javascript
const { userId: expectedUserId, newPage } = parsePaginationCustomId(interaction.customId, 0);
```

#### Pattern B: With Subtype

**Before (5-8 lines):**
```javascript
const customIdParts = interaction.customId.split('_');
const subtype = customIdParts[2];  // source/dest/player
const direction = customIdParts[3];
const expectedUserId = customIdParts[4];
const currentPage = parseInt(customIdParts[5]);
const newPage = direction === 'next' ? currentPage + 1 : currentPage - 1;
```

**After (1 line):**
```javascript
const { userId: expectedUserId, newPage, subtype } = parsePaginationCustomId(interaction.customId, 0);
```

#### Pattern C: With Single Context

**Before (4-6 lines):**
```javascript
const customIdParts = interaction.customId.split('_');
const expectedUserId = customIdParts[3];
const selectedAdminId = customIdParts[4] === 'none' ? null : customIdParts[4];
const newPage = parseInt(customIdParts[5]);
```

**After (2 lines):**
```javascript
const { userId: expectedUserId, newPage, contextData } = parsePaginationCustomId(interaction.customId, 1);
const selectedAdminId = contextData[0] === 'none' ? null : contextData[0];
```

#### Pattern D: With Multiple Context

**Before (7-10 lines):**
```javascript
const customIdParts = interaction.customId.split('_');
const direction = customIdParts[3];
const expectedUserId = customIdParts[4];
const sourceAllianceId = parseInt(customIdParts[5]);
const destAllianceId = parseInt(customIdParts[6]);
const currentPage = parseInt(customIdParts[7]);
const newPage = direction === 'next' ? currentPage + 1 : currentPage - 1;
```

**After (3 lines):**
```javascript
const { userId: expectedUserId, newPage, contextData } = parsePaginationCustomId(interaction.customId, 2);
const sourceAllianceId = parseInt(contextData[0]);
const destAllianceId = parseInt(contextData[1]);
```

---

## Code Examples

### Complete Example 1: editAdmin.js Migration

```javascript
// ============================================
// IMPORTS (Add this)
// ============================================
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../Pagination/universalPagination');

// ============================================
// IN showEditAdminPage() FUNCTION
// ============================================
async function showEditAdminPage(interaction, allAdmins, page = 0, userLang = 'en', isReply = true) {
    const lang = languages[userLang] || languages['en'];
    
    // Pagination logic
    const itemsPerPage = 5;
    const totalPages = Math.ceil(allAdmins.length / itemsPerPage);
    const startIndex = page * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const adminsOnPage = allAdmins.slice(startIndex, endIndex);

    // Create admin select menu
    const adminSelect = new StringSelectMenuBuilder()
        .setCustomId(`admin_select_edit_${interaction.user.id}`)
        .setPlaceholder(lang.selectAdmin.placeholder)
        .addOptions(
            adminsOnPage.map(admin => ({
                label: admin.username || admin.user_id,
                value: admin.user_id,
                description: lang.selectAdmin.description
            }))
        );

    const actionRow = new ActionRowBuilder().addComponents(adminSelect);

    //  NEW: Create pagination buttons (replaces 20+ lines)
    const paginationRow = createUniversalPaginationButtons({
        feature: 'edit_admin',
        userId: interaction.user.id,
        currentPage: page,
        totalPages: totalPages,
        lang: lang
    });

    const components = [actionRow];
    if (paginationRow) {
        components.push(paginationRow);
    }

    // Create embed and send...
    const embed = new EmbedBuilder()
        .setTitle(lang.embeds.editAdmin.title)
        .setDescription(lang.embeds.editAdmin.description)
        .setColor(0x3498db);

    if (isReply) {
        await interaction.reply({ embeds: [embed], components, ephemeral: true });
    } else {
        await interaction.update({ embeds: [embed], components });
    }
}

// ============================================
// IN handleEditAdminPagination() FUNCTION
// ============================================
async function handleEditAdminPagination(interaction) {
    const adminData = adminQueries.getAdmin(interaction.user.id);
    const userLang = adminData.language || 'en';
    const lang = languages[userLang] || languages['en'];

    try {
        //  NEW: Parse pagination data (replaces 3-5 lines)
        const { userId: expectedUserId, newPage } = parsePaginationCustomId(interaction.customId, 0);
        
        // Security check
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        if (!adminData || !adminData.is_owner) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Get admins and show page
        const allAdmins = adminQueries.getAllAdmins().filter(admin => 
            admin.user_id !== interaction.user.id && !admin.is_owner
        );

        await showEditAdminPage(interaction, allAdmins, newPage, userLang, false);

    } catch (error) {
        console.error('Error handling edit admin pagination:', error);
        // Error handling...
    }
}
```

### Complete Example 2: movePlayers.js (Complex with Context)

```javascript
// ============================================
// SOURCE ALLIANCE SELECTION (Simple Subtype)
// ============================================
async function showSourceAllianceSelection(interaction, page = 0) {
    const alliances = allianceQueries.getAllAlliances();
    
    const itemsPerPage = 10;
    const totalPages = Math.ceil(alliances.length / itemsPerPage);
    const startIndex = page * itemsPerPage;
    const alliancesOnPage = alliances.slice(startIndex, startIndex + itemsPerPage);

    // Create alliance select menu...
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`move_players_source_select_${interaction.user.id}`)
        .setPlaceholder('Select source alliance')
        .addOptions(/* ... */);

    const actionRow = new ActionRowBuilder().addComponents(selectMenu);

    //  Create pagination with subtype
    const paginationRow = createUniversalPaginationButtons({
        feature: 'move_players',
        subtype: 'source',
        userId: interaction.user.id,
        currentPage: page,
        totalPages: totalPages,
        lang: lang
    });

    const components = [actionRow];
    if (paginationRow) {
        components.push(paginationRow);
    }

    // Send...
}

// ============================================
// PLAYER SELECTION (Complex with Multiple Context)
// ============================================
async function showPlayerSelection(interaction, sourceId, destId, page = 0) {
    const players = playerQueries.getPlayersByAlliance(sourceId);
    
    const itemsPerPage = 10;
    const totalPages = Math.ceil(players.length / itemsPerPage);
    const startIndex = page * itemsPerPage;
    const playersOnPage = players.slice(startIndex, startIndex + itemsPerPage);

    // Create player select menu...
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`move_players_player_select_${interaction.user.id}_${sourceId}_${destId}`)
        .setPlaceholder('Select players to move')
        .addOptions(/* ... */);

    const actionRow = new ActionRowBuilder().addComponents(selectMenu);

    //  Create pagination with multiple context data
    const paginationRow = createUniversalPaginationButtons({
        feature: 'move_players',
        subtype: 'player',
        userId: interaction.user.id,
        currentPage: page,
        totalPages: totalPages,
        lang: lang,
        contextData: [sourceId, destId]  // Both IDs passed as context
    });

    const components = [actionRow];
    if (paginationRow) {
        components.push(paginationRow);
    }

    // Send...
}

// ============================================
// PAGINATION HANDLER (Works for ALL subtypes)
// ============================================
async function handleMovePlayersPagination(interaction) {
    try {
        //  Parse with context count = 2 (for player subtype)
        const parsed = parsePaginationCustomId(interaction.customId, 2);
        const { userId: expectedUserId, newPage, subtype, contextData } = parsed;

        // Security check
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Handle based on subtype
        if (subtype === 'source') {
            await showSourceAllianceSelection(interaction, newPage);
        } else if (subtype === 'dest') {
            const sourceId = parseInt(contextData[0]);
            await showDestAllianceSelection(interaction, sourceId, newPage);
        } else if (subtype === 'player') {
            const sourceId = parseInt(contextData[0]);
            const destId = parseInt(contextData[1]);
            await showPlayerSelection(interaction, sourceId, destId, newPage);
        }

    } catch (error) {
        console.error('Error handling move players pagination:', error);
        // Error handling...
    }
}
```

---

## Quick Reference

### Function Signatures

```javascript
// Creating buttons
createUniversalPaginationButtons({
    feature: string,           // Required: 'edit_admin', 'move_players', etc.
    subtype: string | null,    // Optional: 'source', 'player', etc.
    userId: string,            // Required: User who can interact
    currentPage: number,       // Required: Current page (0-indexed)
    totalPages: number,        // Required: Total pages
    lang: Object,              // Required: Language object
    contextData: Array         // Optional: [id1, id2, ...]
}) → ActionRowBuilder | null   // will return buttons when there is enough pages

// Parsing custom ID
parsePaginationCustomId(
    customId: string,          // The button's custom ID
    contextDataCount: number   // How many context items to expect (0, 1, 2, ...)
) → {
    feature: string,
    subtype: string | null,
    direction: 'prev' | 'next',
    userId: string,
    currentPage: number,
    newPage: number,           // ← Auto-calculated!
    contextData: Array
}
```

### Use Case → Context Count Map

```javascript
// No context (simple pagination)
parsePaginationCustomId(customId, 0)
// Examples: edit_admin, remove_admin, view_alliances

// Single context
parsePaginationCustomId(customId, 1)
// Examples: view_admin (selectedAdminId), view_logs (targetId)

// Two context items
parsePaginationCustomId(customId, 2)
// Examples: move_players_player (sourceId, destId)

// Three or more context items
parsePaginationCustomId(customId, 3)
// Examples: custom complex scenarios
```

### Code Reduction Summary

| Task | Before | After | Reduction |
|------|--------|-------|-----------|
| Simple pagination | 20-25 lines | 6 lines | 70% |
| With subtype | 30-35 lines | 8 lines | 75% |
| With single context | 25-30 lines | 8 lines | 70% |
| With multiple context | 45-50 lines | 12 lines | 75% |
| Parsing (simple) | 3-5 lines | 1 line | 80% |
| Parsing (complex) | 7-10 lines | 3 lines | 70% |

### Files to Update (Priority Order)

**Priority 1 - Simple (Start Here):**
-  `editAdmin.js` - No context
-  `removeAdmin.js` - No context
-  `viewAlliances.js` - No context
-  `editPriority.js` - No context

**Priority 2 - With Context:**
-  `viewAdmin.js` - Single context (selectedAdminId)
-  `editAlliance.js` - Single context
-  `deleteAlliance.js` - Single context

**Priority 3 - Complex:**
-  `movePlayers.js` - Multiple subtypes + multiple context
-  `addPlayer.js` - With subtype
-  `removePlayers.js` - With subtype

---

## Summary: Why This Works

### The Universal Pattern Solves:
1. **Inconsistency** - Same format everywhere
2. **Complexity** - Automatic page calculation
3. **Duplication** - Single source of truth
4. **Maintenance** - Fix once, works everywhere
5. **Errors** - Built-in validation and edge case handling

### What You Get:
 **60-75% less code** per file
 **Consistent custom IDs** across all features
 **Automatic page calculation** (no math errors)
 **Flexible** (supports all scenarios)
 **Maintainable** (update one file, fix everywhere)
 **Safe** (built-in validation)

### Remember:
1. **Import** the helper functions
2. **Replace** button creation with `createUniversalPaginationButtons()`
3. **Replace** parsing with `parsePaginationCustomId()`
4. **Test** each file after migration
5. **Celebrate** cleaner, better code!

---

**That's it! You now have everything you need to implement universal pagination across your entire bot.** 
