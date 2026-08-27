import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

const [, , dshEntry, ...dshArgs] = process.argv

if (!dshEntry || !isAbsolute(dshEntry) || !existsSync(dshEntry)) {
  console.error('desktop runner: dsh entry is missing or invalid')
  process.exit(2)
}

let input = ''
let inputClosed = false

function requestShutdown() {
  const handled = process.emit('SIGTERM', 'SIGTERM')
  if (!handled) process.exit(0)
}

function requestShutdownFromInputClose() {
  if (inputClosed) return
  inputClosed = true
  requestShutdown()
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  const lines = input.split(/\r?\n/u)
  input = lines.pop() ?? ''
  for (const line of lines) {
    if (line.trim() === 'shutdown') requestShutdown()
  }
})
process.stdin.once('end', requestShutdownFromInputClose)
process.stdin.once('close', requestShutdownFromInputClose)

process.argv = [process.execPath, dshEntry, ...dshArgs]

await import(pathToFileURL(dshEntry).href)
