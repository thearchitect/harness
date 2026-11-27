# Privacy

harness is open source software you run yourself. The harness app (iOS, Android, web) talks only
to the hubs you run; we, the authors, operate no service it
connects to and collect no data from it.

- **What the app sends, and where**: your messages, files you hand to sessions, voice recordings
  and settings go to your hub, over the address you paired the app with. Voice recordings are
  transcribed by your hub with your own OpenAI account.
- **What the app keeps on the device**: the device token of your pairing (in the system's secure
  storage, or on web an HttpOnly cookie of your hub's address, which the page cannot read), and
  its log (below). The camera reads a pairing QR code only while you scan it; nothing of it is
  kept. No analytics, no crash reporting, no advertising identifiers.
- **Logs**: harness writes a full log so that what went wrong can be found: your hub keeps its
  own, its agents' and its clients' (the app and the TUI send theirs to it), and the app keeps a
  copy on the device (the browser's IndexedDB, a phone's app files). The log holds content: your
  messages, the models' answers, tools' output, what you type into a session's terminal, your
  actions in the app, its requests and errors. It never holds the values of secrets: secrets you
  give an agent (`ask_secret`), provider credentials, device tokens and pairing codes are masked
  wherever they would appear. Days older than `log.retentionDays` (3 by default) are removed, on
  the hub and on the device. The log stays on your machines; nothing of it is sent to us.
- **Model providers**: your hubs send prompts to the model providers you log in to on them, under
  those providers' terms.
- **Deleting your data**: everything lives on your hubs (`~/.harness`, the log in
  `~/.harness/log`); revoke a device with `harness hub device revoke`, remove the app to remove
  its token and its log.

Questions: open an issue in the harness repository.
