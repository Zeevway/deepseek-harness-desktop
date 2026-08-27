'use strict'

const fs = require('node:fs')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const releaseDirectory = path.join(projectRoot, 'release')

if (path.dirname(releaseDirectory) !== projectRoot || path.basename(releaseDirectory) !== 'release') {
  throw new Error(`refusing to clean unexpected path: ${releaseDirectory}`)
}

fs.rmSync(releaseDirectory, { recursive: true, force: true })
fs.mkdirSync(releaseDirectory, { recursive: true })
console.log(`clean release directory: ${releaseDirectory}`)
