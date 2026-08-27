'use strict'

const fs = require('node:fs')
const path = require('node:path')
const asar = require('@electron/asar')
const manifest = require('../package.json')
const lock = require('../package-lock.json')
const {
  collectPackageClosure,
  findPackageDirectory,
  parsePackageRelativeDirectory,
} = require('./package-closure.cjs')
const { verifyPackagedProjectFiles } = require('./packaged-source-integrity.cjs')

const projectRoot = path.resolve(__dirname, '..')
const releaseRoot = path.join(projectRoot, 'release')
const expectedHarnessVersion = manifest.dependencies['@deepseek-ai/dsh']
const expectedArgument = process.argv.find((argument) => argument.startsWith('--expected='))
const expectedArchitecture = expectedArgument?.slice('--expected='.length)
if (expectedArchitecture && !['x64', 'arm64'].includes(expectedArchitecture)) {
  throw new Error(`unsupported expected architecture: ${expectedArchitecture}`)
}
const expectedArchitectures = process.argv.includes('--all')
  ? ['x64', 'arm64']
  : [expectedArchitecture || 'x64']
const buildDirectories = expectedArchitectures.map((architecture) => path.join(
  releaseRoot,
  architecture === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked',
))

function findBuildOnlyUnpackedFiles(directory) {
  const matches = []
  const queue = [directory]
  while (queue.length > 0) {
    const current = queue.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name)
      if (entry.isDirectory()) queue.push(filename)
      else if (entry.isFile() && (entry.name.endsWith('.map')
        || /\.d\.(?:ts|mts|cts)$/u.test(entry.name))) {
        matches.push(path.relative(directory, filename))
        if (matches.length >= 20) return matches
      }
    }
  }
  return matches
}

for (const directory of buildDirectories) {
  if (!fs.existsSync(directory)) {
    throw new Error(`expected packaged application directory is missing: ${directory}`)
  }
}

const unpackedAnchors = [
  '@deepseek-ai/dsh',
  'commander',
  'isexe',
  'mime-db',
  'mime-types',
  'pnpm',
  'retry',
  'which',
]
const lockedVersions = new Map()
for (const [relativeDirectory, metadata] of Object.entries(lock.packages ?? {})) {
  if (!relativeDirectory.startsWith('node_modules/') || !metadata.version) continue
  const packageName = parsePackageRelativeDirectory(relativeDirectory).packages.at(-1).name
  if (!lockedVersions.has(packageName)) lockedVersions.set(packageName, new Set())
  lockedVersions.get(packageName).add(metadata.version)
}

function readPeMachine(executable) {
  const image = fs.readFileSync(executable)
  if (image.length < 0x40 || image.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error(`invalid PE executable: ${executable}`)
  }
  const peOffset = image.readUInt32LE(0x3c)
  if (peOffset + 6 > image.length || image.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error(`invalid PE header: ${executable}`)
  }
  return image.readUInt16LE(peOffset + 4)
}

for (const buildDirectory of buildDirectories) {
  const targetArchitecture = path.basename(buildDirectory) === 'win-arm64-unpacked' ? 'arm64' : 'x64'
  const executableName = `${manifest.build.win?.executableName || manifest.build.productName}.exe`
  const executable = path.join(buildDirectory, executableName)
  const expectedPeMachine = targetArchitecture === 'arm64' ? 0xaa64 : 0x8664
  const actualPeMachine = readPeMachine(executable)
  if (actualPeMachine !== expectedPeMachine) {
    throw new Error(
      `${path.basename(buildDirectory)} Electron architecture mismatch: expected 0x${expectedPeMachine.toString(16)}, got 0x${actualPeMachine.toString(16)}`,
    )
  }
  const resources = path.join(buildDirectory, 'resources')
  const unpackedRoot = path.join(resources, 'app.asar.unpacked')
  const appAsar = path.join(resources, 'app.asar')
  const sourceIntegrity = verifyPackagedProjectFiles({
    projectRoot,
    appAsar,
    buildFiles: manifest.build.files,
  })
  const packagedClosure = collectPackageClosure(unpackedRoot, ['@deepseek-ai/dsh', 'pnpm'])
  const missing = [...new Set(packagedClosure.missing.map(({ name, from }) => (
    `${name} from ${path.relative(unpackedRoot, from) || '.'}`
  )))]
  const mismatched = []
  const incompatible = packagedClosure.incompatible.map(({ name, version, range, from }) => (
    `${name}@${version} does not satisfy ${range} from ${path.relative(unpackedRoot, from) || '.'}`
  ))
  const mixedHarnessVersions = []

  for (const entry of packagedClosure.packages) {
    const packaged = entry.manifest
    if (!lockedVersions.get(packaged.name)?.has(packaged.version)) {
      mismatched.push(`${packaged.name}@${packaged.version} is not present in package-lock.json`)
    }
    if ((packaged.name === '@deepseek-ai/dsh' || packaged.name?.startsWith('@deepseek-ai/dsh-'))
      && packaged.version !== expectedHarnessVersion) {
      mixedHarnessVersions.push(`${packaged.name}@${packaged.version}`)
    }
  }

  for (const packageName of unpackedAnchors) {
    const directory = findPackageDirectory(packageName, unpackedRoot, unpackedRoot)
    if (!directory) {
      missing.push(`${packageName} top-level anchor`)
      continue
    }
    const packaged = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
    const expectedVersion = manifest.dependencies[packageName]
    if (packaged.version !== expectedVersion) {
      mismatched.push(`${packageName} top-level anchor (expected ${expectedVersion}, got ${packaged.version})`)
    }
  }

  const nativePackages = [
    `@img/sharp-win32-${targetArchitecture}`,
    `@koromix/koffi-win32-${targetArchitecture}`,
    `@vscode/ripgrep-win32-${targetArchitecture}`,
    `node-addon-require-builtin-win32-${targetArchitecture}-msvc`,
  ]
  for (const packageName of nativePackages) {
    const packaged = packagedClosure.packages.find((entry) => entry.manifest.name === packageName)
    const expectedVersion = lock.packages?.[`node_modules/${packageName}`]?.version
    if (!packaged) missing.push(`${packageName} target-native dependency`)
    else if (!expectedVersion || packaged.manifest.version !== expectedVersion) {
      mismatched.push(
        `${packageName} target-native dependency (expected ${expectedVersion || 'locked version'}, got ${packaged.manifest.version})`,
      )
    }
  }

  const runner = path.join(unpackedRoot, 'src', 'harness-runner.mjs')
  if (!fs.existsSync(runner)) missing.push('src/harness-runner.mjs')

  const buildOnlyFiles = findBuildOnlyUnpackedFiles(unpackedRoot)
  if (buildOnlyFiles.length > 0) {
    throw new Error(
      `build-only source maps or declarations were unpacked in ${path.basename(buildDirectory)}: ${buildOnlyFiles.join(', ')}`,
    )
  }

  if (missing.length) {
    throw new Error(`packaged runtime dependencies are missing from ${path.basename(buildDirectory)}: ${missing.join(', ')}`)
  }
  if (incompatible.length) {
    throw new Error(`packaged runtime dependency ranges are incompatible: ${incompatible.join(', ')}`)
  }
  if (mismatched.length) {
    throw new Error(`packaged runtime dependencies do not match the locked closure: ${mismatched.join(', ')}`)
  }
  if (mixedHarnessVersions.length) {
    throw new Error(`mixed packaged Harness versions: ${mixedHarnessVersions.join(', ')}`)
  }

  const updaterManifest = JSON.parse(
    asar.extractFile(
      appAsar,
      path.join('node_modules', 'electron-updater', 'package.json'),
    ).toString('utf8'),
  )
  if (updaterManifest.version !== manifest.dependencies['electron-updater']) {
    throw new Error(`packaged electron-updater mismatch: ${updaterManifest.version}`)
  }

  const unpackedUpdater = path.join(unpackedRoot, 'node_modules', 'electron-updater')
  if (fs.existsSync(unpackedUpdater)) {
    throw new Error('electron-updater should remain inside app.asar')
  }

  console.log(
    `packaged dependencies ok: ${path.basename(buildDirectory)}, ${packagedClosure.packages.length} runtime packages, ${sourceIntegrity.verifiedFileCount} project files`,
  )
}
