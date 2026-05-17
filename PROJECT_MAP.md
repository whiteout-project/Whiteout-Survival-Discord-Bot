# Whiteout Survival Discord Bot — Project Map

## Overview

Discord.js v14 bot for managing Whiteout Survival game data. Uses Components v2, better-sqlite3, node-cron, i18n JSON.

## Directory Structure

```
src/
├── commands/          # Slash command definitions
│   ├── panel.js       # /panel — main admin/user panel
│   └── inspect.js     # /inspect — player inspect command
├── events/            # Discord.js event handlers
├── functions/         # Feature modules
│   ├── Alliance/      # Alliance CRUD, refresh, priority, assignment
│   ├── Attendance/    # Session-based manual attendance marking
│   ├── Calculators/   # Buildings & War Academy calculators
│   ├── GiftCode/      # Gift code management, redeem, auto-redeem
│   ├── Notification/  # Scheduled notifications, templates, mentions
│   ├── Pagination/    # Pagination utilities
│   ├── Panel/         # Back-to-panel button
│   ├── Players/       # Player CRUD, history, export, ID channels
│   ├── Plugin/        # Plugin system (install/delete/access)
│   ├── Processes/     # Priority queue with crash recovery
│   ├── Settings/      # Admin management, permissions, backup, emojis, i18n
│   ├── Support/       # Support panel & report generation
│   └── utility/       # Database, common functions, emoji helpers, access checks
├── handlers/          # Interaction handler registries
│   ├── buttons_handler.js    # Button interaction dispatcher (regex registry)
│   ├── dropmenu_handlers.js  # Select menu dispatcher (string/user/role/channel)
│   └── forms_handlers.js     # Modal submit dispatcher
├── i18n/              # Localisation (en.json, fr.json)
├── model/             # Data models
└── index.js           # Bot entry point
```

## Attendance Feature (Session/Event-Based Marking)

### Files
| File | Purpose |
|------|---------|
| `functions/Attendance/attendance.js` | Main panel + button factory |
| `functions/Attendance/marking.js` | Session creation, event type selection, player toggle marking |
| `functions/Attendance/viewReport.js` | Report viewer (by session) |
| `functions/utility/database.js` | `attendance_sessions` + `attendance_records` tables, queries |
| `functions/Settings/admin/permissions.js` | `ATTENDANCE_MANAGEMENT` bit (1<<5) |

### Tables
- **attendance_sessions** — `id` (UUID), `alliance_id`, `session_name`, `event_type`, `event_subtype`, `event_date`, `created_by`, `created_at`
- **attendance_records** — `session_id` → sessions, `player_id`, `player_name`, `status` (present/absent/not_recorded), `points`, `marked_by`, `marked_at`

### Handler Registrations
- **Button patterns** (5): `attendance_management_`, `attendance_mark_done_`, `attendance_mark_toggle_`, `attendance_mark_`, `attendance_view_reports_`
- **Select menu** (5): `attendance_mark_event_`, `attendance_mark_legion_`, `attendance_mark_select_`, `attendance_report_session_`, `attendance_report_select_` (all string)
- **Modal** (1): `attendance_session_modal_`

### Flow
1. Admin opens Attendance panel → clicks "Mark Attendance"
2. Selects alliance → modal: session name + optional date
3. Selects event type (Foundry, Canyon Clash, Crazy Joe, Bear Trap, Castle Battle, Frostdragon Tyrant, Other)
4. For Foundry/Canyon Clash: selects legion (Legion 1 / Legion 2)
5. Player list shown with toggle buttons (green=present, red=absent)
6. Click "Done" to save
7. Reports viewed per session with present/absent counts

## Key Patterns
- **Components v2** — `ContainerBuilder`, `TextDisplayBuilder`, `SeparatorBuilder`, `ActionRowBuilder`, `ButtonBuilder`
- **Permissions** — Bitmask via `hasPermission(adminData, FULL_ACCESS, PERMISSION_BIT)`
- **i18n** — `lang = getUserInfo(userId).lang`, keys in `en.json` / `fr.json`
- **Database** — Synchronous better-sqlite3 with WAL mode, prepared statements
- **Error handling** — `handleError(interaction, lang, error, context)` for all user-facing errors

## Pending Work
- None — attendance feature fully wired and registered
