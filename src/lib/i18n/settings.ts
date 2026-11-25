/**
 * i18n namespace: settings
 *
 * Flat dotted keys merged into the `en.translation` resource
 * by `src/lib/i18n/index.ts`. Do not import this file directly
 * from app code; use `t('namespace.key')` via the index.
 */

export const settings: Record<string, string> = {
  // Translators: Not currently shown in the app. Screen-reader label of a remove (×) button for
  // a task state in a list of states; {{state}} = a task-state keyword such as DOING.
  'settings.removeState': 'Remove state {{state}}',

  // Translators: Settings › General: the "Launch on login" switch row (label and the description
  // under it), and the error toast (brief pop-up) when the switch cannot be changed.
  'settings.autostart.description': 'Start Agaric automatically when you sign into your computer.',
  'settings.autostart.label': 'Launch on login',
  'settings.autostart.toggleFailed': "Couldn't update launch-on-login setting",

  // Translators: Settings › About: the "Debug mode" switch row and its description.
  'settings.debugMode.label': 'Debug mode',
  'settings.debugMode.description':
    'Show technical error codes in the error messages of dialogs and panels, such as a failed pairing. Keep this off for everyday use; turn it on to capture the code when reporting a problem.',

  // Translators: Settings › About: row that reopens the first-run welcome window (title,
  // description, button).
  // #3308 — re-entry into the first-run welcome tour.
  'settings.showWelcomeTour.title': 'Show the welcome tour again',
  'settings.showWelcomeTour.description':
    'Re-open the first-run welcome window, including the option to create the sample pages.',
  'settings.showWelcomeTour.button': 'Show tour',

  // Translators: Settings tab names, listed in the Settings side rail (a dropdown on phones);
  // keep them short. Spaces = separate workspaces such as Work and Personal.
  'settings.tabGeneral': 'General',
  'settings.tabSpaces': 'Spaces',

  // Translators: Settings › Spaces: intro text, then the "Open on launch" dropdown row (which
  // space the app opens in) and its first option, "Last used" (the space you were in last).
  'settings.spaces.description':
    'Spaces keep separate contexts, such as work and personal, apart. Pages, journals, tags and links never cross between spaces. Switch spaces from the top of the sidebar.',
  'settings.spaces.openOnLaunchLabel': 'Open on launch',
  'settings.spaces.openOnLaunchHelp':
    'The space this device opens in when Agaric starts. Last used keeps the space you were in.',
  'settings.spaces.lastUsed': 'Last used',

  // Translators: Settings tab names (side rail; keep short). Properties = typed fields attached
  // to blocks; Editor = options of the text editor.
  'settings.tabProperties': 'Properties',
  'settings.tabAppearance': 'Appearance',
  'settings.tabEditor': 'Editor',

  // Translators: Settings › Editor: "Edit pages as" dropdown, its description and its options:
  // "Blocks" (one block at a time) and "Page" (the whole page as one document); use the same
  // words as the edit-mode switch in the page header. Ctrl+E is a key combination; keep it.
  'settings.editor.editModeLabel': 'Edit pages as',
  'settings.editor.editModeHelp':
    'Blocks edits one block at a time; Page edits the whole page as one document. A page’s header switches the page on screen (Ctrl+E).',
  'settings.editor.editModeBlocks': 'Blocks',
  'settings.editor.editModePage': 'Page',

  // Translators: Settings › Editor: on/off switch rows, each a label and the description under
  // it. ":" and ":joy" are characters the user types; keep them. Tab, Shift+Tab, Ctrl/Cmd and
  // Escape are keys.
  'settings.editor.emojiPickerLabel': 'Emoji picker',
  'settings.editor.emojiPickerHelp':
    'Type : followed by a shortcode (e.g. :joy) to insert an emoji inline. Turn off to type a literal colon with no popup.',
  'settings.editor.tabIndentLabel': 'Tab indents blocks',
  'settings.editor.tabIndentHelp':
    'Tab and Shift+Tab indent and outdent blocks. Turn off to keep Tab for moving focus and indent with Ctrl/Cmd+Shift+Arrow instead. Press Escape to leave the editor.',
  'settings.editor.revealMarkdownLabel': 'Show Markdown syntax around the cursor',
  'settings.editor.revealMarkdownHelp':
    'When the cursor is in formatted text, a heading or a link, show its Markdown syntax; beside a page, tag or block-reference chip, show its brackets for reading only. Delete a marker to remove the formatting, lower a heading or unlink the text.',

  // Translators: Settings › Editor: "External images" dropdown (images loaded from other
  // websites): label, description, its three options, the heading over remembered domains, and
  // the screen-reader label of each domain chip's remove button ({{host}} = a domain like
  // "example.com"). "Load" in the description is the button shown on a blocked image; use the
  // same word.
  // #1492 — external-image load policy (privacy-first default: Click).
  'settings.editor.externalImageLabel': 'External images',
  'settings.editor.externalImageHelp':
    'Loading an image from another website tells that site you opened the page. Choosing Load on a blocked image remembers its domain for next time. Local, pasted, and attachment images are never affected.',
  'settings.editor.externalImageAlways': 'Always load',
  'settings.editor.externalImageClick': 'Ask each time (recommended)',
  'settings.editor.externalImageNever': 'Never load',
  'settings.editor.externalImageAllowedHosts': 'Allowed image domains',
  'settings.editor.externalImageRemoveHost': 'Remove {{host}}',

  // Translators: Settings › Editor: on/off switch row for link previews (the title and icon of a
  // web link, shown on hover).
  'settings.editor.linkPreviewLabel': 'Fetch link previews on hover',
  'settings.editor.linkPreviewHelp':
    'Hovering or focusing an external link fetches its title and icon, which tells that site you have the link. When off, cached previews still show, and a link you paste or insert is still fetched once.',

  // Translators: Settings tab names (side rail; keep short). "Sync & devices" = syncing between
  // your own paired devices; "Data" = import, export and edit history.
  'settings.tabSync': 'Sync & devices',
  'settings.tabData': 'Data',

  // Translators: Settings › Data: row that opens the History view (the list of past edits, with
  // revert): label, description, button.
  // #5361 — a way into the History view, which stays a full page; a row in
  // Data since #5629.
  'settings.history.label': 'Browse and revert changes',
  'settings.history.description': 'See past changes to your notes and undo the ones you want.',
  'settings.history.openButton': 'Open edit history',

  // Translators: Settings tab name (side rail; keep short): the integrity check and the status
  // of background tasks.
  // #5360 — the `status` id stays for `?settings=status`, deep links and `go-status`.
  'settings.tabStatus': 'App health',

  // Translators: Settings › General: Language dropdown: label, description, and its "System"
  // option (follow the device language). The other options are language names, not here.
  // #4555 — UI language. `System` follows the device language list; the
  // other options name each language in itself (`LOCALES` in `locales.ts`),
  // so they are not catalog keys.
  'settings.languageLabel': 'Language',
  'settings.languageHelp': 'System follows your device language.',
  'settings.languageSystem': 'System',

  // Translators: Settings › Appearance: Theme dropdown (color scheme) and its options. "System" =
  // follow the device's light/dark setting. Solarized, Dracula and One Dark Pro are names of
  // popular color schemes; keep the names, translate only "Light" / "Dark".
  'settings.themeLabel': 'Theme',
  'settings.themeLight': 'Light',
  'settings.themeDark': 'Dark',
  'settings.themeSystem': 'System',
  'settings.themeSolarizedLight': 'Solarized Light',
  'settings.themeSolarizedDark': 'Solarized Dark',
  'settings.themeDracula': 'Dracula',
  'settings.themeOneDarkPro': 'One Dark Pro',

  // Translators: Settings › Appearance: "Note text size" dropdown: label, description, options.
  'settings.fontSizeLabel': 'Note text size',
  'settings.fontSizeHelp': 'Only the text of your notes, not the rest of the app.',
  'settings.fontSizeSmall': 'Small',
  'settings.fontSizeMedium': 'Medium',
  'settings.fontSizeLarge': 'Large',

  // Translators: Settings › Appearance: Custom CSS row (your own stylesheet): label and
  // description, screen-reader label of the text box, and a button that opens the online list
  // of style tokens. Keep "agaric://settings/safe-mode" as written: it is an address to type.
  'settings.customCssLabel': 'Custom CSS',
  'settings.customCssHelp':
    'Your own stylesheet, applied after the app’s. Only the documented tokens are kept from release to release; selectors, class names and the page structure can change. If it hides the app, open agaric://settings/safe-mode to turn it off.',
  'settings.customCssTextLabel': 'Custom CSS stylesheet',
  'settings.customCssDocs': 'Token reference',

  // Translators: Settings › Appearance (computers only): Zoom dropdown that scales the whole app;
  // label and description. Its options are percentages.
  'settings.zoomLabel': 'Zoom',
  'settings.zoomHelp': 'Scales the whole interface: sidebar, menus, dialogs and notes.',

  // Translators: Settings › Appearance: Animations dropdown: label, description, options.
  // "System" follows the device's reduced-motion setting; "Full", "Fast", "Off" are speeds.
  'settings.motionLabel': 'Animations',
  'settings.motionHelp':
    'One knob for animation speed. System follows your OS reduced-motion setting, Fast makes everything snappier, and Off disables animations.',
  'settings.motionSystem': 'System',
  'settings.motionFull': 'Full',
  'settings.motionFast': 'Fast',
  'settings.motionOff': 'Off',

  // Translators: Settings › Appearance: "Tooltip delay" dropdown (how long to hover before a hint
  // bubble appears): label, description, options. "Default" = the standard delay.
  'settings.tooltipDelayLabel': 'Tooltip delay',
  'settings.tooltipDelayHelp':
    'How long to hover before a tooltip opens. Instant shows tooltips immediately; Fast shortens the wait; Default is the standard dwell.',
  'settings.tooltipDelayInstant': 'Instant',
  'settings.tooltipDelayFast': 'Fast',
  'settings.tooltipDelayDefault': 'Default',

  // Translators: Settings tab name (side rail; keep short): keyboard shortcuts.
  'settings.tabKeyboard': 'Keyboard',

  // Translators: Settings › Keyboard, first row: the system-wide Quick capture key combination
  // (works from any app). Label, description (also the subtitle of the Quick capture window
  // on computers), edit button, and the error toast when the system refuses the combination.
  'settings.quickCapture.label': 'Quick capture (system-wide)',
  'settings.quickCapture.description':
    "Press this key combination from anywhere to drop a line into today's journal.",
  'settings.quickCapture.editButton': 'Edit shortcut',
  'settings.quickCapture.saveFailed':
    "Couldn't register shortcut. It may conflict with another app.",

  // Translators: Quick capture window (small dialog that adds one line to today's journal):
  // title, subtitle on phones, screen-reader label and placeholder of the text box, the submit
  // button (a verb), and the toasts after saving or failing.
  'quickCapture.dialogTitle': 'Quick capture',
  'quickCapture.descriptionTouch': "Jot a line down; it lands in today's journal.",
  'quickCapture.captureInputLabel': 'Quick capture content',
  'quickCapture.placeholder': "What's on your mind?",
  'quickCapture.saveButton': 'Capture',
  'quickCapture.successToast': "Captured to today's journal",
  'quickCapture.failureToast': "Couldn't save quick capture",
  // Translators: Error toast when an agaric://capture link (an address that opens Quick capture
  // with some text) carries more text than fits.
  'quickCapture.linkTooLong':
    "The link's text is longer than a block can hold, so Quick Capture did not open.",

  // Translators: Settings tab names (side rail; keep short). "About" = app version, updates and
  // bug report; "Tasks & reminders" = notifications for tasks that are due.
  'settings.tabHelp': 'About',
  'settings.tabNotifications': 'Tasks & reminders',

  // Translators: Settings › Tasks & reminders: intro text, the "Remind me about due tasks" switch
  // row, and the "Reminder time" row (a time-of-day input); each a label and its description.
  'notifications.description':
    'Get a native OS notification on the day a task is due, and send yourself a test to confirm they reach you.',
  'notifications.enableLabel': 'Remind me about due tasks',
  'notifications.enableDescription':
    'Each open task is announced once on its due date, at the reminder time below, while Agaric is running or minimized. Reminders are per device.',
  'notifications.reminderTimeLabel': 'Reminder time',
  'notifications.reminderTimeDescription':
    'Local time at which a task due today is announced. Opening Agaric later in the day still announces it once.',

  // Translators: Error toasts of the Tasks & reminders tab.
  'notifications.settingsLoadFailed': 'Could not load reminder settings',
  'notifications.settingsSaveFailed': 'Could not save reminder settings',

  // Translators: Settings › Tasks & reminders: OS permission section (the system's permission to
  // show notifications): heading, description, button, and the toasts after asking.
  'notifications.permissionLabel': 'OS permission',
  'notifications.permissionDescription':
    'On Android 13+ a one-time permission grant is required. On desktop the grant is automatic — use the test below to confirm.',
  'notifications.requestPermissionButton': 'Request permission',
  'notifications.permissionGranted': 'Notification permission granted',
  'notifications.permissionDenied': 'Notification permission was not granted',

  // Translators: Settings › Tasks & reminders: test button, the hint shown while it is disabled,
  // the test notification itself (title and body, shown by the operating system), and toasts.
  'notifications.sendTestButton': 'Send test notification',
  'notifications.testDisabledHint': 'Enable notifications above to send a test.',
  'notifications.testTitle': 'Agaric test notification',
  'notifications.testBody': 'If you can see this, notifications are working.',
  'notifications.testSent': 'Test notification sent',
  'notifications.testFailed': 'Could not send the test notification',

  // Translators: "Report a bug" dialog (opened from Settings › About or a crash screen): title
  // and subtitle. It prepares an issue on GitHub (the code-hosting website; keep the name).
  'bugReport.title': 'Report a bug',
  'bugReport.description':
    'Your report is never sent automatically. Review what will be shared, optionally attach logs, then open a prefilled GitHub issue.',

  // Translators: Bug report dialog form: the title and description fields (label and
  // placeholder each), then two switches with a hint under each. ZIP = a compressed archive.
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

  // Translators: Bug report dialog: error inside the log-preview window when a log cannot be read.
  'bugReport.previewError': 'Failed to read log for preview',
  // Translators: Note under the "Preview" heading of the report text.
  'bugReport.previewHint': 'This is exactly what will be placed in the GitHub issue body.',
  // Translators: Screen-reader label of the eye button on each log file; {{filename}} = a log
  // file name like "agaric.log".
  'bugReport.previewLabel': 'Preview {{filename}}',
  // Translators: Log-preview window: loading text; the "Preview" heading (also that window's
  // title); notice that only the start of the log is shown ({{shown}}, {{total}} = numbers).
  'bugReport.previewLoading': 'Loading preview…',
  'bugReport.previewTitle': 'Preview',
  'bugReport.previewTruncated': 'Showing first {{shown}} of {{total}} bytes…',

  // Translators: Bug report dialog: list of log files to attach: heading, empty message, and each
  // file's size ({{size}} = a number).
  'bugReport.logsListTitle': 'Log files included in the ZIP',
  'bugReport.logsListEmpty': 'No log files to include.',
  'bugReport.logsSize': '{{size}} bytes',

  // Translators: Bug report dialog: required checkbox before the report can be sent.
  'bugReport.confirmCheckbox': "I've reviewed what will be shared",

  // Translators: Log-preview window: link buttons that expand the shortened log, or shorten it.
  'bugReport.viewFullLog': 'View full log',
  'bugReport.collapseLog': 'Show less',

  // Translators: Bug report dialog buttons. "Cancel" also closes the log-preview window; "Open in
  // GitHub" shows when no logs are attached, "Open GitHub issue" when they are; "Download zip"
  // saves the logs.
  'bugReport.cancel': 'Cancel',
  'bugReport.copy': 'Copy report',
  'bugReport.copied': 'Report copied to clipboard',
  'bugReport.copyFailed': 'Failed to copy report',
  'bugReport.openIssue': 'Open in GitHub',
  'bugReport.openGitHubIssue': 'Open GitHub issue',
  'bugReport.downloadZip': 'Download zip',

  // Translators: Bug report dialog: hint under the log list, and the toasts after saving the ZIP
  // or opening the issue; {{fileName}} = e.g. "agaric-bug-report-2026-06-17.zip".
  'bugReport.zipDownloadHint':
    'Saves {{fileName}} to your Downloads folder. Drag it into the GitHub issue once it opens.',
  'bugReport.zipDownloaded':
    'Saved {{fileName}} to Downloads. Now open the GitHub issue and attach it.',
  'bugReport.submitted': 'Bug report submitted. The GitHub issue is opening in a new tab.',

  // Translators: Bug report dialog: error toasts. "Copy report" is the dialog's button of that
  // name.
  'bugReport.loadMetadataFailed': 'Failed to collect bug-report metadata',
  'bugReport.readLogsFailed': 'Failed to read logs',
  'bugReport.buildZipFailed': 'Failed to build ZIP',
  // Surfaced when openUrl resolves false (the Tauri opener errored AND
  // window.open was popup-blocked / returned null). The dialog stays open so
  // the user can retry or copy the issue URL from the clipboard fallback.
  'bugReport.browserOpenFailed':
    "Couldn't open your browser. The issue URL has been copied to the clipboard — paste it into your browser to open the GitHub issue.",
  'bugReport.browserOpenFailedNoClipboard':
    "Couldn't open your browser, and the URL couldn't be copied to the clipboard. Use the Copy report button and open GitHub manually.",

  // Translators: Button on the crash screen shown when part of the app fails; opens the bug
  // report dialog.
  'bugReport.reportCrashTitle': 'Report this crash',

  // Translators: Settings tab name (side rail; keep short): letting AI assistant apps on this
  // computer read or edit your notes.
  'settings.tabAgentAccess': 'Agent access',

  // Translators: Settings › Agent access: intro text on computers, then on phones. "Agents" = AI
  // assistant apps; Claude Desktop, Cursor and Continue are product names; a "socket" is a
  // local connection point.
  'agentAccess.description':
    'Let agents on this computer (Claude Desktop, Cursor, Continue, …) connect over a local socket. Off by default.',
  // #6520 — the socket is in the app's own storage, which no other app on Android or iOS can reach.
  'agentAccess.descriptionMobile':
    "No app on this device can reach Agaric's agent socket yet, so agents cannot connect here. Set them up in Agaric on your computer; what they write reaches this device by sync.",

  // Translators: Error shown in the Agent access tab. MCP (Model Context Protocol) is a technical
  // name; keep it.
  'agentAccess.loadFailed': 'Failed to load MCP status',

  // Translators: Agent access: main on/off switch (label and description) and the toasts after
  // switching. "Agents list" is the Agents section further down the tab.
  'agentAccess.toggleLabel': 'Let agents connect',
  'agentAccess.toggleDescription':
    'Each agent connects with its own token, from the Agents list, and gets only the access and spaces you gave it. A client without one is refused.',
  'agentAccess.toggleOnSuccess': 'Agent access enabled',
  'agentAccess.toggleOffSuccess': 'Agent access disabled',
  'agentAccess.toggleFailed': 'Failed to toggle agent access',

  // Translators: Agent access: notice when another copy of the agaric-mcp program, which the app
  // did not put there, may shadow the app's own; agaric-mcp is a program name, keep it. {{path}} is a
  // file path.
  'agentAccess.foreignPathBridge':
    'Another agaric-mcp is on your PATH at {{path}}, so scripts and agents may run it instead of this app’s. Remove it and restart Agaric to put the current one there.',

  // Translators: Agent access: field showing the socket file path, its copy button (tooltip and
  // screen-reader label), and toasts after copying; "Claude Desktop" is a product name.
  'agentAccess.socketPathLabel': 'Socket path',
  'agentAccess.socketPathCopied': 'Socket path copied',
  'agentAccess.copySocketPathLabel': 'Copy socket path',
  'agentAccess.copyFailed': 'Failed to copy to clipboard',
  'agentAccess.claudeConfigCopied': 'Claude Desktop config copied',

  // Translators: Agent access: "Recent activity" log of what agents did: heading (also its
  // screen-reader name) and empty message.
  'agentAccess.activityLabel': 'Recent activity',
  'agentAccess.activityEmpty':
    'No agent activity yet. When an agent connects, tool calls appear here.',

  // Translators: Agent access: "Connections" section: heading, how many agents are connected now
  // (None / one / {{count}} = 2 or more), the "Disconnect all" button, its toasts, and the
  // confirmation dialog (title, body, confirm button).
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

  // Translators: Recent activity: undo button on one agent action: screen-reader label, tooltip,
  // the short text shown beside its icon on touch screens, and the toasts after undoing.
  'agentAccess.undoAgentOp.ariaLabel': 'Undo this agent action',
  'agentAccess.undoAgentOp.tooltip': 'Undo this agent action',
  'agentAccess.undoAgentOp.buttonText': 'Undo',
  'agentAccess.undoAgentOp.success': 'Agent action undone',
  'agentAccess.undoAgentOp.failed': 'Could not undo agent action',
  'agentAccess.undoAgentOp.nonReversible': 'This agent action cannot be undone',

  // Translators: Recent activity: header of one agent session (one connection's run of actions)
  // with its count and a "Revert session" button (undo all of them), then the confirmation
  // dialog and toasts. {{count}} = number of actions; _one / _other are singular and plural.
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

  // Translators: Agent access: "Agents" section, one row per AI app given its own access key
  // ("token"): heading, description, load error, "Add agent" button, and empty state.
  // agaric-ro and agaric-rw are literal entry names in an app's config; keep them.
  'agentAccess.agents.title': 'Agents',
  'agentAccess.agents.description':
    'Each agent has its own token, access and spaces. Give each client its own agent.',
  'agentAccess.agents.loadFailed': 'Failed to load agents',
  'agentAccess.agents.add': 'Add agent',
  'agentAccess.agents.empty': 'No agents yet',
  'agentAccess.agents.emptyDescription':
    "Add one agent per client, then replace that client's agaric-ro and agaric-rw entries with the agent's config.",

  // Translators: Agent row details: access badge (also the options of the Access toggle in the
  // Add agent dialog), which spaces it may use, and when it was last used ({{when}} = a
  // relative time like "5m ago" or "just now").
  'agentAccess.agents.modeReadOnly': 'Read only',
  'agentAccess.agents.modeReadWrite': 'Read and write',
  'agentAccess.agents.allSpaces': 'All spaces',
  // Translators: Every space this agent was given has since been deleted.
  'agentAccess.agents.noSpacesLeft': 'No spaces left',
  'agentAccess.agents.lastUsed': 'Last used {{when}}',
  'agentAccess.agents.neverUsed': 'Never used',

  // Translators: Agent row buttons: copy the setup for the Claude Desktop app or the Claude Code
  // command (product names), and revoke (tooltip, also the confirm button); {{name}} = the
  // agent's name. Then the revoke confirmation dialog and its toasts.
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

  // Translators: "Add agent" dialog: title, subtitle, Name field (the placeholder is an example
  // product name; keep it), Access toggle and its note, space checkboxes, buttons ("Add" =
  // submit), toasts and inline errors ({{name}} = the typed agent name).
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

  // Translators: Group headings in the Settings side rail (and in the phone dropdown), each
  // above several tabs.
  // #1108 — grouped tab navigation. Shallow sections lower the altitude of
  // experimental/niche tabs so they no longer sit as flat peers of the core
  // ones (and remove the horizontal-overflow wheel workaround).
  'settings.groupWorkspace': 'Workspace',
  'settings.groupIntegrations': 'Integrations',
  'settings.groupData': 'Data & sync',
  'settings.groupHelp': 'Help',

  // Translators: Settings › General: "Week starts on" dropdown and its two options.
  'settings.weekStartLabel': 'Week starts on',
  'settings.weekStartMonday': 'Monday',
  'settings.weekStartSunday': 'Sunday',

  // Translators: Settings › General: "Journal template" row: a dropdown of the space's template
  // pages (or None) that a new journal day is copied from, an Open button for the one set, and a
  // button that creates a new journal template page.
  'settings.journalTemplateLabel': 'Journal template',
  'settings.journalTemplateHelp': 'A new day in this space starts as a copy of this page.',
  'settings.journalTemplateNone': 'None',
  'settings.journalTemplateOpen': 'Open',

  // Translators: Settings › General: "Journal date format" dropdown. Each option shows a pattern
  // and an example; the order of the parts is fixed (only month and weekday names follow the
  // app language), so keep that order.
  'settings.journalDateFormatLabel': 'Journal date format',
  'settings.journalDateFormatHelp':
    'How journal titles are shown. Pages are always stored as YYYY-MM-DD, so changing this never affects existing journals.',
  'settings.journalDateFormatLocale': 'Localized (e.g. Wed, Jun 17 2026)',
  'settings.journalDateFormatIso': 'YYYY-MM-DD (e.g. 2026-06-17)',
  'settings.journalDateFormatLong': 'Month D, YYYY (e.g. June 17, 2026)',
  'settings.journalDateFormatSlash': 'DD/MM/YYYY (e.g. 17/06/2026)',
  'settings.journalDateFormatWeekday': 'Ddd, Mmm D (e.g. Wed, Jun 17)',

  // Translators: Note under the "Deadline warning" number in Settings › Tasks & reminders when the
  // value typed was out of range and was clamped; {{min}} and {{max}} are numbers (e.g. 0 and 90).
  'settings.valueClamped': 'Value clamped to {{min}}–{{max}}',
}
