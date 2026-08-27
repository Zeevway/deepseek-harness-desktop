const fs = require('node:fs')
const path = require('node:path')
const { app, safeStorage } = require('electron')

const [userDataArgument, workspaceArgument] = process.argv.slice(-2)
const userData = path.resolve(userDataArgument)
const workspace = path.resolve(workspaceArgument)

app.whenReady().then(() => {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Electron safeStorage is unavailable')
  }
  fs.mkdirSync(userData, { recursive: true })
  fs.mkdirSync(workspace, { recursive: true })
  const encryptedApiKey = safeStorage.encryptString('sk-packaged-smoke-test').toString('base64')
  fs.writeFileSync(path.join(userData, 'desktop-config.json'), `${JSON.stringify({
    version: 1,
    workspace,
    encryptedApiKey,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8')
  app.quit()
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
