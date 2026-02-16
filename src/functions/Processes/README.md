# Process Management System - Complete Guide

## Overview

This is a sophisticated **SQLite-based process management system** designed for Discord bots that need to handle long-running, asynchronous operations with priority queuing, rate limiting, and crash recovery.

### What It Solves

- **Long-running operations** that can't block the bot (player data fetching, alliance refreshes)
- **Rate limiting** from external APIs (automatic pausing/resuming)
- **Priority management** (notifications > add players > gift codes > refreshes)
- **Crash recovery** (bot restarts don't lose progress)
- **Resource management** (prevents multiple operations from running simultaneously)

### System Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  createProcess  │───▶│  queueManager   │───▶│ executeProcess  │
│                 │    │                 │    │                 │
│ • Create SQLite │    │ • Priority      │    │ • Execute by    │
│   records       │    │   queuing       │    │   action type   │
│ • Set priority  │    │ • Preemption    │    │ • Rate limiting │
│ • Progress      │    │ • Auto-start    │    │ • Error handling│
│   tracking      │    │                 │    │                 │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│ processRecovery │    │   SQLite DB     │    │   Discord Bot   │
│                 │    │                 │    │                 │
│ • Crash recovery│    │ • Process data  │    │ • User commands │
│ • Admin confirm │    │ • Progress      │    │ • Progress      │
│ • Auto-resume   │    │ • Queue status  │    │   embeds        │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

---

## Core Components

### 1. **createProcesses.js** - Process Creation & Management

#### Purpose
Creates and manages process records in SQLite database with progress tracking.

#### Key Functions

```javascript
// Create a new process
const result = await createProcess({
    admin_id: '123456789',
    alliance_id: 'alliance_001',
    player_ids: 'fid1,fid2,fid3',
    action: 'addplayer'
});

// Get process info
const process = await getProcessById(42);

// Update progress
await updateProcessProgress(42, {
    pending: ['fid4', 'fid5'],
    done: ['fid1', 'fid2'],
    failed: ['fid3'],
    existing: []
});

// Update status
await updateProcessStatus(42, 'completed');
```

#### Process Priorities

```javascript
const PROCESS_PRIORITIES = {
    NOTIFICATIONS: 1,    // Highest priority
    ADD_PLAYER: 2,
    REDEEM_GIFTCODE: 3,
    REFRESH: 4,
    AUTO_REFRESH: 5       // Lowest priority
};
```

#### Process Status Flow

```
QUEUED ───▶ ACTIVE ───▶ COMPLETED
    │           │
    │           ├───▶ PAUSED ───▶ ACTIVE (resume)
    │           │       │
    │           │       └───▶ FAILED (timeout)
    │
    └───▶ FAILED (error)
```

### 2. **queueManager.js** - Priority Queue Management

#### Purpose
Manages process execution queue with priority-based scheduling and preemption.

#### Key Features

- **Priority Queuing**: Lower numbers = higher priority
- **Preemption**: Higher priority processes can pause lower priority ones
- **Auto-Start**: Automatically starts next process when current completes
- **Rate Limit Handling**: Pauses processes during API rate limits

#### Queue Operations

```javascript
// Add process to queue and start if possible
await queueManager.manageQueue({
    process_id: 42,
    priority: 2,
    action: 'addplayer'
});

// Start next process in queue
const nextProcess = await queueManager.startNextProcess();

// Get queue statistics
const stats = await queueManager.getQueueStats();
// Returns: { queued: 3, active: 1, paused: 0, total: 4 }
```

#### Preemption Logic

```javascript
// If new process has higher priority (lower number)
if (newPriority < activePriority) {
    // Pause current process
    await updateProcessStatus(activeProcessId, 'paused');
    await setProcessPreemption(activeProcessId, newProcessId);
    
    // Start higher priority process
    await updateProcessStatus(newProcessId, 'active');
}
```

### 3. **executeProcesses.js** - Process Execution Engine

#### Purpose
Executes processes based on their action type with error handling and preemption checks.

#### Supported Actions

```javascript
const ACTIONS = {
    'addplayer': executeAddPlayer,        // Fetch player data from API
    'refresh': executeRefresh,            // Refresh alliance data
    'redeem_giftcode': executeRedeemGiftcode, // Redeem gift codes
    'notifications': executeNotifications,    // Send notifications
    'auto_refresh': executeAutoRefresh    // Automated refreshes
};
```

#### Execution Flow

```javascript
async executeProcess(processInfo) {
    // 1. Get process data from SQLite
    const processData = await getProcessById(processId);
    
    // 2. Execute based on action type
    switch (processData.action) {
        case 'addplayer':
            await this.executeAddPlayer(processId);
            break;
        // ... other actions
    }
    
    // 3. Mark as completed
    await queueManager.completeProcess(processId);
}
```

#### Preemption Checks

```javascript
// Check for preemption before/after each major operation
const preemptionCheck = await this.checkForPreemption(processId);
if (preemptionCheck.shouldStop) {
    // Process was paused by higher priority or stopped
    return; // Exit cleanly without error
}
```

### 4. **processRecovery.js** - Crash Recovery System

#### Purpose
Handles bot restarts and crashes, ensuring no progress is lost.

#### Recovery Scenarios

1. **Clean Restart**: Bot stopped normally, resume queued processes
2. **Crash During Execution**: Process was active, needs admin confirmation
3. **Rate Limited**: Process paused for API limits, auto-resume when ready
4. **Preempted**: Process paused for higher priority, resume when available

#### Recovery Process

```javascript
// On bot startup
await processRecovery.initialize(client);

// 1. Reset crashed active processes to queued
const resetCount = await resetCrashedProcesses();

// 2. Handle crashed processes (send admin confirmations)
for (const process of crashedActiveProcesses) {
    await handleCrashedProcess(process);
}

// 3. Auto-start processes if no confirmations needed
if (crashedActiveProcesses.length === 0) {
    await queueManager.startNextProcess();
}
```

#### Admin Confirmation System

When a process crashes mid-execution, the system:
1. Sends DM to admin with process status
2. Shows resume/cancel buttons
3. Auto-resumes after 5 minutes if no response
4. Updates progress embeds in real-time

---

## Process Lifecycle

### 1. Creation Phase

```javascript
// User initiates action (e.g., add players)
const result = await createProcess({
    admin_id: userId,
    alliance_id: allianceId,
    player_ids: playerIds.join(','),
    action: 'addplayer'
});

// Process created with status: QUEUED
// Priority assigned based on action type
```

### 2. Queue Management Phase

```javascript
// Queue manager decides execution
if (no active processes) {
    // Start immediately
    status = ACTIVE
    executeProcess()
} else if (higher priority) {
    // Preempt current, start new
    current.status = PAUSED
    new.status = ACTIVE
} else {
    // Queue for later
    status = QUEUED
}
```

### 3. Execution Phase

```javascript
// Execute based on action
switch (action) {
    case 'addplayer':
        // Fetch player data from API
        // Handle rate limiting
        // Update progress
        break;
}

// Handle errors, preemption, completion
```

### 4. Completion/Recovery Phase

```javascript
// On completion
await updateProcessStatus(processId, 'completed');
await queueManager.startNextProcess();

// On crash/restart
await processRecovery.initialize(client);
```

---

## Database Schema

### Processes Table

```sql
CREATE TABLE processes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,              -- 'addplayer', 'refresh', etc.
    alliance_id TEXT NOT NULL,         -- Target alliance
    status TEXT DEFAULT 'queued',      -- queued/active/paused/completed/failed
    priority INTEGER NOT NULL,         -- 1=highest, 5=lowest
    data TEXT,                         -- JSON: { player_ids: "fid1,fid2" }
    progress TEXT,                     -- JSON: { pending: [], done: [], failed: [] }
    created_by TEXT NOT NULL,          -- Admin Discord ID
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resume_after INTEGER,              -- Timestamp for rate limit resume
    preempted_by INTEGER               -- Process ID that preempted this one
);
```

### Progress JSON Structure

```json
{
    "pending": ["fid1", "fid2", "fid3"],     // Not yet processed
    "done": ["fid4", "fid5"],                // Successfully completed
    "failed": ["fid6"],                      // Failed to process
    "existing": ["fid7"],                    // Already in database
    "guild_id": "123456789",                 // For embed updates
    "channel_id": "987654321",
    "message_id": "111222333"                // Progress embed message
}
```

---

## Configuration

### Priority Levels

```javascript
const PROCESS_PRIORITIES = {
    NOTIFICATIONS: 1,    // Immediate user feedback
    ADD_PLAYER: 2,       // User-initiated data fetching
    REDEEM_GIFTCODE: 3,  // User rewards
    REFRESH: 4,          // Background data updates
    AUTO_REFRESH: 5      // Automated maintenance
};
```

### Rate Limiting

```javascript
const API_CONFIG = {
    RATE_LIMIT_DELAY: 60000,    // 60 seconds
    RETRY_DELAY: 3000,          // 3 seconds
    MAX_RETRIES: 3
};
```

### Recovery Settings

```javascript
const RECOVERY_CONFIG = {
    AUTO_RESUME_TIMEOUT: 5 * 60 * 1000,  // 5 minutes
    CLEANUP_AGE: 24 * 60 * 60 * 1000     // 24 hours
};
```

---

## Usage Examples

### Adding Players (Most Common Use Case)

```javascript
// 1. Create process
const result = await createProcess({
    admin_id: '123456789',
    alliance_id: 'alliance_001',
    player_ids: '40393986,40393987,40393988',
    action: 'addplayer'
});

// 2. Queue manager handles execution
await queueManager.manageQueue(result);

// 3. Process executes (fetches from API, updates database)
// 4. Progress embed updates in real-time
// 5. Completion notification sent
```

### Handling Rate Limits

```javascript
// During API call
if (response.status === 429) {
    // Pause process for rate limit
    const resumeTime = Date.now() + API_CONFIG.RATE_LIMIT_DELAY;
    await queueManager.pauseForRateLimit(processId, resumeTime);
    
    // Start next process while waiting
    await queueManager.startNextProcess();
}
```

### Crash Recovery

```javascript
// Bot restarts
await processRecovery.initialize(client);

// System automatically:
// 1. Finds interrupted processes
// 2. Sends admin confirmations for active processes
// 3. Resumes queued processes
// 4. Updates progress embeds
```

---

## Monitoring & Statistics

### Queue Statistics

```javascript
const stats = await queueManager.getQueueStats();
// Returns:
// {
//   queued: 3,
//   active: 1,
//   paused: 0,
//   total: 4,
//   queuedByPriority: { 1: 0, 2: 2, 3: 1, 4: 0, 5: 0 },
//   activeByPriority: { 2: 1 },
//   pausedByPriority: {}
// }
```

### Process Status

```javascript
const process = await getProcessById(42);
// Returns full process data with progress
```

### Recovery Status

```javascript
const recoveryStats = await processRecovery.getRecoveryStatus();
// Returns recovery system health
```

---

## API Reference

### createProcesses.js

```javascript
// Core functions
createProcess(processData) → { process_id, status, priority, action }
getProcessById(processId) → ProcessObject | null
updateProcessStatus(processId, status) → boolean
updateProcessProgress(processId, progress) → boolean
deleteProcess(processId) → boolean

// Queue functions
getProcessesByStatus(status) → ProcessArray
getNextQueuedProcess() → ProcessObject | null
getActiveProcesses() → ProcessArray
getPausedProcessesReadyToResume() → ProcessArray

// Utility functions
setProcessResumeTime(processId, timestamp) → boolean
setProcessPreemption(processId, preemptedBy) → boolean
hasHigherPriorityQueued(currentPriority) → boolean
cleanupOldProcesses(maxAgeMs) → boolean
resetCrashedProcesses() → number
```

### queueManager.js

```javascript
// Queue management
manageQueue(processInfo) → QueueResult
startNextProcess() → ProcessInfo | null
completeProcess(processId) → ProcessInfo | null
pauseForRateLimit(processId, resumeTime) → boolean

// Statistics
getQueueStats() → StatsObject
getQueuePosition(processId) → number
getQueuedProcesses() → ProcessArray
```

### executeProcesses.js

```javascript
// Execution
executeProcess(processInfo) → boolean
executeByAction(processData) → void
failProcess(processId, error) → void
checkForPreemption(processId) → boolean

// Statistics
getExecutionStats() → StatsObject
```

### processRecovery.js

```javascript
// Recovery
initialize(client) → void
recoverProcesses() → void
triggerManualRecovery() → StatsObject
getRecoveryStatus() → StatusObject

// Admin interactions
handleProcessResume(interaction) → void
handleProcessCancel(interaction) → void
```

---

## Error Handling

### Process Execution Errors

```javascript
try {
    await executeProcess(processInfo);
} catch (error) {
    if (error.message === 'RATE_LIMIT') {
        // Handle rate limiting
        await queueManager.pauseForRateLimit(processId, resumeTime);
    } else {
        // Fatal error (preemption is handled internally via return values)
        await failProcess(processId, error);
    }
}
```

### Database Errors

```javascript
// All database operations include automatic logging
systemLogQueries.addLog('error', 'Operation failed', {
    processId,
    error: error.message,
    stack: error.stack
});
```

### Recovery Errors

```javascript
// Recovery system has fallback mechanisms
// - Auto-retry initialization
// - Manual recovery triggers
// - Admin notifications for stuck processes
```

---

## Security & Permissions

### Admin-Only Operations

- Process creation requires admin permissions
- Recovery confirmations sent only to process creators
- Owner-only access for critical operations

### Data Validation

- Process data validated before creation
- Player IDs sanitized and filtered
- API responses validated before database updates

---

## Best Practices

### 1. Process Creation

```javascript
// Always validate input
if (!admin_id || !alliance_id || !player_ids) {
    throw new Error('Missing required fields');
}

// Use proper priorities
const priority = PROCESS_PRIORITIES[action.toUpperCase()] || 5;
```

### 2. Error Handling

```javascript
// Always wrap in try-catch
try {
    await executeProcess(processInfo);
} catch (error) {
    await systemLogQueries.addLog('error', error.message, {
        processId,
        stack: error.stack
    });
}
```

### 3. Progress Updates

```javascript
// Update progress frequently for UI feedback
await updateProcessProgress(processId, {
    pending: remainingIds,
    done: completedIds,
    failed: failedIds
});
```

### 4. Resource Management

```javascript
// Clean up old processes regularly
await cleanupOldProcesses(24 * 60 * 60 * 1000); // 24 hours
```

---

## Real-World Usage

### Discord Bot Integration

```javascript
// In command handler
client.on('interactionCreate', async (interaction) => {
    if (interaction.commandName === 'addplayers') {
        // Create process
        const result = await createProcess({
            admin_id: interaction.user.id,
            alliance_id: interaction.options.getString('alliance'),
            player_ids: interaction.options.getString('player_ids'),
            action: 'addplayer'
        });
        
        // Send initial response
        await interaction.reply({
            content: `Process created! ID: ${result.process_id}`,
            ephemeral: true
        });
        
        // Queue manager handles the rest automatically
    }
});
```

### Progress Embed Updates

```javascript
// In execution function
const embed = createProgressEmbed(processData, stats);
if (embedMessage) {
    await embedMessage.edit({ embeds: [embed] });
}
```

---

## System Flow Summary

1. **User Command** → Create process record in SQLite
2. **Queue Manager** → Decide when to execute based on priority
3. **Process Executor** → Run the actual operation with progress tracking
4. **Recovery System** → Handle crashes and ensure no data loss
5. **Completion** → Clean up and start next process

**Result**: A robust, scalable system that handles complex operations reliably with excellent user experience through real-time progress updates and automatic recovery.

---

## Support

For issues or questions:
1. Check system logs in database
2. Use `getQueueStats()` for debugging
3. Manual recovery with `triggerManualRecovery()`
4. Check process status with `getProcessById()`