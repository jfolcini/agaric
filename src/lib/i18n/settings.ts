/**
 * i18n namespace: settings
 *
 * Flat dotted keys merged into the `en.translation` resource
 * by `src/lib/i18n/index.ts`. Do not import this file directly
 * from app code; use `t('namespace.key')` via the index.
 */

export const settings: Record<string, string> = {
  'settings.removeState': 'Remove state {{state}}',
  'settings.autostart.description': 'Start Agaric automatically when you sign into your computer.',
  'settings.autostart.label': 'Launch on login',
  'settings.autostart.toggleFailed': "Couldn't update launch-on-login setting",
  'settings.debugMode.label': 'Debug mode',
  'settings.debugMode.description':
    'Show technical error codes in notifications. Keep this off for everyday use; turn it on to capture the code when reporting a problem.',
  // #3308 — re-entry into the first-run welcome tour.
  'settings.showWelcomeTour.title': 'Show the welcome tour again',
  'settings.showWelcomeTour.description':
    'Re-open the first-run welcome window, including the option to create the sample pages.',
  'settings.showWelcomeTour.button': 'Show tour',
  'settings.showWelcomeTour.success': 'Welcome tour reopened',
  'settings.tabGeneral': 'General',
  'settings.tabSpaces': 'Spaces',
  'settings.spaces.description':
    'Spaces keep separate contexts, such as work and personal, apart. Pages, journals, tags and links never cross between spaces. Switch spaces from the top of the sidebar.',
  'settings.spaces.openOnLaunchLabel': 'Open on launch',
  'settings.spaces.openOnLaunchHelp':
    'The space this device opens in when Agaric starts. Last used keeps the space you were in.',
  'settings.spaces.lastUsed': 'Last used',
  'settings.tabProperties': 'Properties',
  'settings.tabAppearance': 'Appearance',
  'settings.tabEditor': 'Editor',
  'settings.editor.editModeLabel': 'Edit pages as',
  'settings.editor.editModeHelp':
    'Blocks edits one block at a time; Page edits the whole page as one document. A page’s header switches the page on screen (Ctrl+Shift+M).',
  'settings.editor.editModeBlocks': 'Blocks',
  'settings.editor.editModePage': 'Page',
  'settings.editor.emojiPickerLabel': 'Emoji picker',
  'settings.editor.emojiPickerHelp':
    'Type : followed by a shortcode (e.g. :joy) to insert an emoji inline. Turn off to type a literal colon with no popup.',
  'settings.editor.tabIndentLabel': 'Tab indents blocks',
  'settings.editor.tabIndentHelp':
    'Tab and Shift+Tab indent and outdent blocks. Turn off to keep Tab for moving focus and indent with Ctrl/Cmd+Shift+Arrow instead. Press Escape to leave the editor.',
  'settings.editor.revealMarkdownLabel': 'Show Markdown syntax around the cursor',
  'settings.editor.revealMarkdownHelp':
    "When the cursor is in formatted text, a heading or a link, show its Markdown syntax. Delete a marker to remove the formatting, lower a heading or unlink the text, and edit a link's URL in place.",
  // #1492 — external-image load policy (privacy-first default: Click).
  'settings.editor.externalImageLabel': 'External images',
  'settings.editor.externalImageHelp':
    'Loading an image from another website tells that site you opened the page. Choosing Load on a blocked image remembers its domain for next time. Local, pasted, and attachment images are never affected.',
  'settings.editor.externalImageAlways': 'Always load',
  'settings.editor.externalImageClick': 'Ask each time (recommended)',
  'settings.editor.externalImageNever': 'Never load',
  'settings.editor.externalImageUpdated': 'External image policy updated',
  'settings.editor.externalImageAllowedHosts': 'Allowed image domains',
  'settings.editor.externalImageRemoveHost': 'Remove {{host}}',
  'settings.editor.linkPreviewLabel': 'Fetch link previews on hover',
  'settings.editor.linkPreviewHelp':
    'Hovering or focusing an external link fetches its title and icon, which tells that site you have the link. When off, cached previews still show, and a link you paste or insert is still fetched once.',
  'settings.tabSync': 'Sync & devices',
  'settings.tabData': 'Data',
  // #5361 — a way into the History view, which stays a full page; a row in
  // Data since #5629.
  'settings.history.label': 'Browse and revert changes',
  'settings.history.description': 'See past changes to your notes and undo the ones you want.',
  'settings.history.openButton': 'Open edit history',
  // #5360 — the `status` id stays for `?settings=status`, deep links and `go-status`.
  'settings.tabStatus': 'App health',
  // #4555 — UI language. `System` follows the device language list; the
  // other two pin a locale. English and Español are deliberately NOT
  // translated per locale: a language picker names each language in that
  // language, so these values are the same in every catalog.
  'settings.languageLabel': 'Language',
  'settings.languageHelp':
    'System follows your device language. Anything not translated yet is shown in English.',
  'settings.languageSystem': 'System',
  'settings.languageEnglish': 'English',
  'settings.languageSpanish': 'Español',
  'settings.themeLabel': 'Theme',
  'settings.themeLight': 'Light',
  'settings.themeDark': 'Dark',
  'settings.themeSystem': 'System',
  'settings.themeSolarizedLight': 'Solarized Light',
  'settings.themeSolarizedDark': 'Solarized Dark',
  'settings.themeDracula': 'Dracula',
  'settings.themeOneDarkPro': 'One Dark Pro',
  'settings.fontSizeLabel': 'Note text size',
  'settings.fontSizeHelp': 'Only the text of your notes, not the rest of the app.',
  'settings.fontSizeSmall': 'Small',
  'settings.fontSizeMedium': 'Medium',
  'settings.fontSizeLarge': 'Large',
  'settings.zoomLabel': 'Zoom',
  'settings.zoomHelp': 'Scales the whole interface: sidebar, menus, dialogs and notes.',
  'settings.motionLabel': 'Animations',
  'settings.motionHelp':
    'One knob for animation speed. System follows your OS reduced-motion setting, Fast makes everything snappier, and Off disables animations.',
  'settings.motionSystem': 'System',
  'settings.motionFull': 'Full',
  'settings.motionFast': 'Fast',
  'settings.motionOff': 'Off',
  'settings.tooltipDelayLabel': 'Tooltip delay',
  'settings.tooltipDelayHelp':
    'How long to hover before a tooltip opens. Instant shows tooltips immediately; Fast shortens the wait; Default is the standard dwell.',
  'settings.tooltipDelayInstant': 'Instant',
  'settings.tooltipDelayFast': 'Fast',
  'settings.tooltipDelayDefault': 'Default',
  'settings.tabKeyboard': 'Keyboard',
  'settings.quickCapture.label': 'Quick capture (system-wide)',
  'settings.quickCapture.description':
    "Press this key combination from anywhere to drop a line into today's journal.",
  'settings.quickCapture.editButton': 'Edit shortcut',
  'settings.quickCapture.saveFailed':
    "Couldn't register shortcut. It may conflict with another app.",
  'quickCapture.dialogTitle': 'Quick capture',
  'quickCapture.captureInputLabel': 'Quick capture content',
  'quickCapture.placeholder': "What's on your mind?",
  'quickCapture.saveButton': 'Capture',
  'quickCapture.successToast': "Captured to today's journal",
  'quickCapture.failureToast': "Couldn't save quick capture",
  'settings.tabHelp': 'About',
  'settings.tabNotifications': 'Tasks & reminders',
  'notifications.description':
    'Get a native OS notification on the day a task is due, and send yourself a test to confirm they reach you.',
  'notifications.enableLabel': 'Remind me about due tasks',
  'notifications.enableDescription':
    'Each open task is announced once on its due date, at the reminder time below, while Agaric is running or minimized. Reminders are per device.',
  'notifications.reminderTimeLabel': 'Reminder time',
  'notifications.reminderTimeDescription':
    'Local time at which a task due today is announced. Opening Agaric later in the day still announces it once.',
  'notifications.settingsLoadFailed': 'Could not load reminder settings',
  'notifications.settingsSaveFailed': 'Could not save reminder settings',
  'notifications.permissionLabel': 'OS permission',
  'notifications.permissionDescription':
    'On Android 13+ a one-time permission grant is required. On desktop the grant is automatic — use the test below to confirm.',
  'notifications.requestPermissionButton': 'Request permission',
  'notifications.permissionGranted': 'Notification permission granted',
  'notifications.permissionDenied': 'Notification permission was not granted',
  'notifications.sendTestButton': 'Send test notification',
  'notifications.testDisabledHint': 'Enable notifications above to send a test.',
  'notifications.testTitle': 'Agaric test notification',
  'notifications.testBody': 'If you can see this, notifications are working.',
  'notifications.testSent': 'Test notification sent',
  'notifications.testFailed': 'Could not send the test notification',
  'bugReport.title': 'Report a bug',
  'bugReport.description':
    'Your report is never sent automatically. Review what will be shared, optionally attach logs, then open a prefilled GitHub issue.',
  'bugReport.fieldTitleLabel': 'Short title',
  'bugReport.fieldTitlePlaceholder': 'e.g. Editor crashes when I press Ctrl+Z',
  'bugReport.fieldDescriptionLabel': 'What went wrong?',
  'bugReport.fieldDescriptionPlaceholder':
    'What were you doing? What did you expect? What happened instead?',
  'bugReport.includeLogsLabel': 'Include diagnostic logs',
  'bugReport.includeLogsHint':
    'Saves a ZIP to your Downloads folder that you can attach to the GitHub issue.',
  'bugReport.redactLabel': 'Redact file paths and device ID',
  'bugReport.redactHint':
    'Replaces your home directory with ~ and blanks the device ID in every log line.',
  'bugReport.previewError': 'Failed to read log for preview',
  'bugReport.previewHint': 'This is exactly what will be placed in the GitHub issue body.',
  'bugReport.previewLabel': 'Preview {{filename}}',
  'bugReport.previewLoading': 'Loading preview…',
  'bugReport.previewTitle': 'Preview',
  'bugReport.previewTruncated': 'Showing first {{shown}} of {{total}} bytes…',
  'bugReport.logsListTitle': 'Log files included in the ZIP',
  'bugReport.logsListEmpty': 'No log files to include.',
  'bugReport.logsSize': '{{size}} bytes',
  'bugReport.confirmCheckbox': "I've reviewed what will be shared",
  'bugReport.viewFullLog': 'View full log',
  'bugReport.collapseLog': 'Show less',
  'bugReport.cancel': 'Cancel',
  'bugReport.copy': 'Copy report',
  'bugReport.copied': 'Report copied to clipboard',
  'bugReport.copyFailed': 'Failed to copy report',
  'bugReport.openIssue': 'Open in GitHub',
  'bugReport.openGitHubIssue': 'Open GitHub issue',
  'bugReport.downloadZip': 'Download zip',
  'bugReport.zipDownloadHint':
    'Saves {{fileName}} to your Downloads folder. Drag it into the GitHub issue once it opens.',
  'bugReport.zipDownloaded':
    'Saved {{fileName}} to Downloads. Now open the GitHub issue and attach it.',
  'bugReport.submitted': 'Bug report submitted. The GitHub issue is opening in a new tab.',
  'bugReport.loadMetadataFailed': 'Failed to collect bug-report metadata',
  'bugReport.readLogsFailed': 'Failed to read logs',
  'bugReport.buildZipFailed': 'Failed to build ZIP',
  // Surfaced when openUrl resolves false (Tauri shell errored AND
  // window.open was popup-blocked / returned null). The dialog stays open so
  // the user can retry or copy the issue URL from the clipboard fallback.
  'bugReport.browserOpenFailed':
    "Couldn't open your browser. The issue URL has been copied to the clipboard — paste it into your browser to open the GitHub issue.",
  'bugReport.browserOpenFailedNoClipboard':
    "Couldn't open your browser, and the URL couldn't be copied to the clipboard. Use the Copy report button and open GitHub manually.",
  'bugReport.reportCrashTitle': 'Report this crash',
  'settings.tabAgentAccess': 'Agent access',
  'agentAccess.description':
    'Let agents on this computer (Claude Desktop, Cursor, Continue, …) connect over local sockets. Read-only and read-write access are separate switches, both off by default.',
  'agentAccess.loadFailed': 'Failed to load MCP status',
  'agentAccess.roToggleLabel': 'Read-only access',
  'agentAccess.roToggleDescription':
    'Let agents search and read your notes over a local socket. Reading a journal date within a year of today may create that page; you can undo it from the activity feed.',
  'agentAccess.toggleOnSuccess': 'Read-only agent access enabled',
  'agentAccess.toggleOffSuccess': 'Read-only agent access disabled',
  'agentAccess.toggleFailed': 'Failed to toggle agent access',
  'agentAccess.socketPathLabel': 'Socket path',
  'agentAccess.socketPathCopied': 'Socket path copied',
  'agentAccess.copySocketPathLabel': 'Copy socket path',
  'agentAccess.copyFailed': 'Failed to copy to clipboard',
  'agentAccess.configLabel': 'Agent configuration',
  'agentAccess.configDescription':
    'Copy the appropriate snippet into your agent\u2019s configuration file.',
  'agentAccess.copyClaudeConfigButton': 'Copy Claude Desktop config',
  'agentAccess.claudeConfigCopied': 'Claude Desktop config copied',
  'agentAccess.copyClaudeCodeCommandsButton': 'Copy Claude Code commands',
  'agentAccess.claudeCodeCommandsCopied': 'Claude Code commands copied',
  'agentAccess.activityLabel': 'Recent activity',
  'agentAccess.activityEmpty':
    'No agent activity yet. When an agent connects, tool calls appear here.',
  'agentAccess.killSwitchLabel': 'Connections',
  'agentAccess.killSwitchDescriptionNone': 'No active connections.',
  'agentAccess.killSwitchDescription_one': '1 active connection.',
  'agentAccess.killSwitchDescription_other': '{{count}} active connections.',
  'agentAccess.killSwitchButton': 'Disconnect all',
  'agentAccess.disconnectSuccess': 'Disconnected all active sessions',
  'agentAccess.disconnectFailed': 'Failed to disconnect sessions',
  'agentAccess.confirmDisconnectTitle': 'Disconnect all sessions?',
  'agentAccess.confirmDisconnectDescription':
    'Every currently-connected agent will be dropped. They can reconnect immediately after.',
  'agentAccess.confirmDisconnectAction': 'Disconnect all',
  'agentAccess.rwToggleLabel': 'Read-write access',
  'agentAccess.rwToggleDescription':
    'Let agents read, search, create, edit, tag, and delete blocks over a separate local socket. Every write is reversible from the activity feed.',
  'agentAccess.rwToggleOnSuccess': 'Read-write agent access enabled',
  'agentAccess.rwToggleOffSuccess': 'Read-write agent access disabled',
  'agentAccess.rwSocketPathLabel': 'Read-write socket path',
  'agentAccess.rwSocketPathCopied': 'Read-write socket path copied',
  'agentAccess.copyRwSocketPathLabel': 'Copy read-write socket path',
  'agentAccess.rwKillSwitchLabel': 'Read-write connections',
  'agentAccess.rwKillSwitchDescriptionNone': 'No active read-write connections.',
  'agentAccess.rwKillSwitchDescription_one': '1 active read-write connection.',
  'agentAccess.rwKillSwitchDescription_other': '{{count}} active read-write connections.',
  'agentAccess.rwKillSwitchButton': 'Disconnect all read-write',
  'agentAccess.rwDisconnectSuccess': 'Disconnected all active read-write sessions',
  'agentAccess.rwDisconnectFailed': 'Failed to disconnect read-write sessions',
  'agentAccess.rwConfirmDisconnectTitle': 'Disconnect all read-write sessions?',
  'agentAccess.rwConfirmDisconnectDescription':
    'Every currently-connected read-write agent will be dropped. They can reconnect immediately after.',
  'agentAccess.rwConfirmDisconnectAction': 'Disconnect all read-write',
  'agentAccess.rwEnabledWarning': 'Agents can create, edit, and delete blocks while this is on.',
  'agentAccess.undoAgentOp.ariaLabel': 'Undo this agent action',
  'agentAccess.undoAgentOp.tooltip': 'Undo this agent action',
  'agentAccess.undoAgentOp.buttonText': 'Undo',
  'agentAccess.undoAgentOp.success': 'Agent action undone',
  'agentAccess.undoAgentOp.failed': 'Could not undo agent action',
  'agentAccess.undoAgentOp.nonReversible': 'This agent action cannot be undone',
  'agentAccess.revertSession.button': 'Revert session',
  'agentAccess.revertSession.headerLabel_one': '{{count}} agent action',
  'agentAccess.revertSession.headerLabel_other': '{{count}} agent actions',
  'agentAccess.revertSession.buttonAriaLabel_one': 'Revert this agent session ({{count}} action)',
  'agentAccess.revertSession.buttonAriaLabel_other':
    'Revert this agent session ({{count}} actions)',
  'agentAccess.revertSession.confirmTitle': 'Revert session?',
  'agentAccess.revertSession.confirmDescription_one':
    'This will undo {{count}} agent action in this session. Continue?',
  'agentAccess.revertSession.confirmDescription_other':
    'This will undo {{count}} agent actions in this session. Continue?',
  'agentAccess.revertSession.confirmAction': 'Revert session',
  'agentAccess.revertSession.success_one': 'Session reverted ({{count}} action)',
  'agentAccess.revertSession.success_other': 'Session reverted ({{count}} actions)',
  'agentAccess.revertSession.failed': 'Could not revert session',
  'agentAccess.revertSession.nonReversible': 'One or more actions in this session cannot be undone',
  'agentAccess.agents.title': 'Agents',
  'agentAccess.agents.description':
    'Each agent has its own token, access and spaces. Give each client its own agent.',
  'agentAccess.agents.pendingEnforcement':
    'Agent configs take effect once Agaric enforces agent tokens, in an upcoming update.',
  'agentAccess.agents.loadFailed': 'Failed to load agents',
  'agentAccess.agents.add': 'Add agent',
  'agentAccess.agents.empty': 'No agents yet',
  'agentAccess.agents.emptyDescription':
    "Add one agent per client, then replace that client's agaric-ro and agaric-rw entries with the agent's config.",
  'agentAccess.agents.modeReadOnly': 'Read only',
  'agentAccess.agents.modeReadWrite': 'Read and write',
  'agentAccess.agents.allSpaces': 'All spaces',
  'agentAccess.agents.noSpacesLeft': 'No spaces left',
  'agentAccess.agents.lastUsed': 'Last used {{when}}',
  'agentAccess.agents.neverUsed': 'Never used',
  'agentAccess.agents.copyDesktopButton': 'Copy Claude Desktop config',
  'agentAccess.agents.copyDesktopAria': 'Copy Claude Desktop config for {{name}}',
  'agentAccess.agents.copyCodeButton': 'Copy Claude Code command',
  'agentAccess.agents.copyCodeAria': 'Copy Claude Code command for {{name}}',
  'agentAccess.agents.codeCommandCopied': 'Claude Code command copied',
  'agentAccess.agents.revoke': 'Revoke',
  'agentAccess.agents.revokeAria': 'Revoke {{name}}',
  'agentAccess.agents.revokeTitle': 'Revoke {{name}}?',
  'agentAccess.agents.revokeDescription':
    "{{name}}'s token stops working. To give a client access again, add a new agent and copy its config.",
  'agentAccess.agents.revokeSuccess': 'Agent revoked',
  'agentAccess.agents.revokeFailed': "Couldn't revoke the agent",
  'agentAccess.agents.createTitle': 'Add agent',
  'agentAccess.agents.createDescription':
    'Choose what the agent may do and which spaces it may use. You can copy its config once it is added.',
  'agentAccess.agents.nameLabel': 'Name',
  'agentAccess.agents.namePlaceholder': 'Claude Desktop',
  'agentAccess.agents.modeLabel': 'Access',
  'agentAccess.agents.readOnlyNote':
    'A read-only agent changes nothing, except that opening a journal day within a year of today may create that page.',
  'agentAccess.agents.allSpacesCheckbox': 'All spaces, including new ones',
  'agentAccess.agents.spacesLegend': 'Spaces',
  'agentAccess.agents.cancel': 'Cancel',
  'agentAccess.agents.create': 'Add',
  'agentAccess.agents.created': 'Agent added',
  'agentAccess.agents.createFailed': "Couldn't add the agent",
  'agentAccess.agents.duplicateName': 'An agent named {{name}} already exists',
  'agentAccess.agents.invalidName':
    'Use a name of up to 128 characters, without control characters',
  // #1108 — grouped tab navigation. Shallow sections lower the altitude of
  // experimental/niche tabs so they no longer sit as flat peers of the core
  // ones (and remove the horizontal-overflow wheel workaround).
  'settings.groupWorkspace': 'Workspace',
  'settings.groupIntegrations': 'Integrations',
  'settings.groupData': 'Data & sync',
  'settings.groupHelp': 'Help',
  'settings.weekStartLabel': 'Week starts on',
  'settings.weekStartMonday': 'Monday',
  'settings.weekStartSunday': 'Sunday',
  'settings.weekStartUpdated': 'Week now starts on {{day}}',
  'settings.journalDateFormatLabel': 'Journal date format',
  'settings.journalDateFormatHelp':
    'How journal titles are shown. Pages are always stored as YYYY-MM-DD, so changing this never affects existing journals.',
  'settings.journalDateFormatLocale': 'Localized (e.g. Wed, Jun 17 2026)',
  'settings.journalDateFormatIso': 'YYYY-MM-DD (e.g. 2026-06-17)',
  'settings.journalDateFormatLong': 'Month D, YYYY (e.g. June 17, 2026)',
  'settings.journalDateFormatSlash': 'DD/MM/YYYY (e.g. 17/06/2026)',
  'settings.journalDateFormatWeekday': 'Ddd, Mmm D (e.g. Wed, Jun 17)',
  'settings.journalDateFormatUpdated': 'Journal dates now display as {{example}}',
  'settings.valueClamped': 'Value clamped to {{min}}–{{max}}',
}
