'use strict'

const manifest = require('../package.json')

const supplied = process.argv[2]
  || (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : '')
if (!supplied) throw new Error('release tag is required')

const expected = `v${manifest.version}`
if (supplied !== expected) {
  throw new Error(`release tag ${supplied} does not match package version ${expected}`)
}

console.log(`release tag matches package version: ${supplied}`)
