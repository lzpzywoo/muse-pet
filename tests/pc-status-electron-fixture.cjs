// Synthetic runtime host; no persistent session, preload, credentials, or cloud navigation.
const { app, BrowserWindow } = require('electron')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  await win.loadURL('about:blank')
})
app.on('window-all-closed', () => app.quit())
