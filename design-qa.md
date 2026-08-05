# Design QA

- References: `codex-clipboard-70f1074a-4cda-47db-97f6-fea26291c3ab.png`, `codex-clipboard-8b09f316-f095-4a45-beca-9b0c77b45180.png`
- Checked surface: 口袋房间标题栏通知按钮及通知弹窗关闭动画
- Notification button is positioned immediately before the room-type button.
- The transparent control uses a ringing bell for enabled notifications and a slashed bell for disabled notifications.
- Accessible name and `aria-pressed` update together with the visual state.
- The right-click menu uses “开启通知” and “关闭通知”.
- Desktop notification close, automatic timeout, navigation, and overflow paths use the exit animation.
- Enabling a member notification does not create a desktop confirmation popup.

final result: passed
