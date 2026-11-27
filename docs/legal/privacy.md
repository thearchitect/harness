# Privacy

harness is open source software you run yourself. The harness app (iOS, Android, web) talks only
to the hubs you run; we, the authors, operate no service it
connects to and collect no data from it.

- **What the app sends, and where**: your messages, files you hand to sessions, voice recordings
  and settings go to your hub, over the address you paired the app with. Voice recordings are
  transcribed by your hub with your own OpenAI account.
- **What the app keeps on the device**: the device token of your pairing (in the system's secure
  storage, or on web an HttpOnly cookie of your hub's address, which the page cannot read). The
  camera reads a pairing QR code only while you scan it; nothing of it is kept. No analytics, no crash reporting, no advertising
  identifiers.
- **Model providers**: your hubs send prompts to the model providers you log in to on them, under
  those providers' terms.
- **Deleting your data**: everything lives on your hubs (`~/.harness`); revoke a device
  with `harness hub device revoke`, remove the app to remove its token.

Questions: open an issue in the harness repository.
