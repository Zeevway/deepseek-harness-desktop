'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const {
  collectPackageClosure,
  findPackageDirectory,
} = require('./package-closure.cjs')

const MAX_LICENSE_DOCUMENT_BYTES = 2 * 1024 * 1024
const LICENSE_FILE_PATTERN = /^(?:licen[cs]e|copying|notice|copyright)(?:$|[._-])/iu
const README_FILE_PATTERN = /^readme(?:$|[._-])/iu

function normalizedPath(filename) {
  const resolved = fs.realpathSync(path.resolve(filename))
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved
}

function packageIdentity(manifest) {
  if (!manifest || typeof manifest.name !== 'string' || manifest.name.trim() === ''
    || typeof manifest.version !== 'string' || manifest.version.trim() === '') {
    throw new Error('production package name and version are required')
  }
  return `${manifest.name}@${manifest.version}`
}

function licenseExpression(manifest) {
  const value = typeof manifest?.license === 'string'
    ? manifest.license
    : manifest?.license?.type
  if (typeof value !== 'string' || value.trim() === ''
    || /^(?:UNKNOWN|UNLICENSED)$/iu.test(value.trim())) {
    throw new Error(`production package has no declared license: ${packageIdentity(manifest)}`)
  }
  return value.trim()
}

function repositoryUrl(manifest) {
  const raw = typeof manifest?.repository === 'string'
    ? manifest.repository
    : manifest?.repository?.url
  if (typeof raw !== 'string' || raw.trim() === '') return null

  let value = raw.trim()
  if (/^github:/iu.test(value)) value = `https://github.com/${value.slice('github:'.length)}`
  else if (/^git@github\.com:/iu.test(value)) {
    value = `https://github.com/${value.slice('git@github.com:'.length)}`
  } else if (/^git\+https:/iu.test(value)) value = value.slice('git+'.length)
  else if (/^git:\/\/github\.com\//iu.test(value)) {
    value = `https://github.com/${value.slice('git://github.com/'.length)}`
  }
  return value.replace(/\.git$/iu, '').replace(/\/$/u, '')
}

function authorValue(author) {
  if (typeof author === 'string' && author.trim()) return author.trim()
  if (!author || typeof author !== 'object') return ''
  const name = typeof author.name === 'string' ? author.name.trim() : ''
  const email = typeof author.email === 'string' ? author.email.trim() : ''
  return name && email ? `${name} <${email}>` : name
}

function dependencyRequests(manifest) {
  const requests = new Map()
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    requests.set(name, { name, range, required: true })
  }
  for (const [name, range] of Object.entries(manifest.optionalDependencies ?? {})) {
    requests.set(name, { name, range, required: false })
  }
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    const required = manifest.peerDependenciesMeta?.[name]?.optional !== true
    const previous = requests.get(name)
    requests.set(name, {
      name,
      range,
      required: previous?.required === true || required,
    })
  }
  return [...requests.values()]
}

function readLock(projectRoot) {
  const filename = path.join(projectRoot, 'package-lock.json')
  if (!fs.existsSync(filename)) return { packages: {} }
  return JSON.parse(fs.readFileSync(filename, 'utf8'))
}

function collectProductionInventory(projectRootValue, projectManifest, extras = []) {
  const projectRoot = path.resolve(projectRootValue)
  const closure = collectPackageClosure(projectRoot, Object.keys(projectManifest.dependencies ?? {}))
  if (closure.missing.length || closure.incompatible.length) {
    throw new Error(`cannot inventory an incomplete production dependency tree: ${JSON.stringify({
      missing: closure.missing,
      incompatible: closure.incompatible,
    })}`)
  }

  const lock = readLock(projectRoot)
  const occurrences = closure.packages.map((entry) => ({
    ...entry,
    componentType: 'library',
    direct: false,
    additionalLicenseFiles: [],
  }))
  for (const extra of extras) {
    const directory = path.resolve(extra.directory)
    const manifest = extra.manifest ?? JSON.parse(
      fs.readFileSync(path.join(directory, 'package.json'), 'utf8'),
    )
    occurrences.push({
      directory,
      relativeDirectory: extra.relativeDirectory
        ?? path.relative(projectRoot, directory).split(path.sep).join('/'),
      manifest,
      componentType: extra.componentType ?? 'library',
      direct: extra.direct !== false,
      additionalLicenseFiles: [...(extra.additionalLicenseFiles ?? [])],
    })
  }

  const occurrencesByDirectory = new Map()
  const packagesByIdentity = new Map()
  for (const occurrence of occurrences) {
    const identity = packageIdentity(occurrence.manifest)
    const directoryKey = normalizedPath(occurrence.directory)
    if (occurrencesByDirectory.has(directoryKey)) {
      throw new Error(`duplicate production package directory: ${occurrence.directory}`)
    }
    occurrencesByDirectory.set(directoryKey, occurrence)

    const license = licenseExpression(occurrence.manifest)
    const repository = repositoryUrl(occurrence.manifest)
    let record = packagesByIdentity.get(identity)
    if (!record) {
      record = {
        identity,
        name: occurrence.manifest.name,
        version: occurrence.manifest.version,
        manifest: occurrence.manifest,
        componentType: occurrence.componentType,
        license,
        repository,
        occurrences: [],
        integrities: new Set(),
      }
      packagesByIdentity.set(identity, record)
    } else if (record.license !== license) {
      throw new Error(`conflicting licenses for duplicate production package: ${identity}`)
    }
    if (!record.repository && repository) record.repository = repository
    if (occurrence.componentType === 'framework') record.componentType = 'framework'
    record.occurrences.push(occurrence)

    const integrity = lock.packages?.[occurrence.relativeDirectory]?.integrity
    if (typeof integrity === 'string' && integrity) record.integrities.add(integrity)
  }

  const packages = [...packagesByIdentity.values()].sort((left, right) => (
    left.identity.localeCompare(right.identity, 'en')
  ))
  for (const record of packages) {
    if (record.integrities.size > 1) {
      throw new Error(`conflicting integrity values for duplicate production package: ${record.identity}`)
    }
    record.integrity = [...record.integrities][0] ?? ''
    delete record.integrities
  }

  const dependencies = new Map(packages.map(({ identity }) => [identity, new Set()]))
  for (const occurrence of closure.packages) {
    const source = packagesByIdentity.get(packageIdentity(occurrence.manifest))
    for (const request of dependencyRequests(occurrence.manifest)) {
      const targetDirectory = findPackageDirectory(request.name, occurrence.directory, projectRoot)
      if (!targetDirectory) {
        if (request.required) {
          throw new Error(`${source.identity} has an unresolved production dependency: ${request.name}`)
        }
        continue
      }
      const targetOccurrence = occurrencesByDirectory.get(normalizedPath(targetDirectory))
      if (!targetOccurrence) {
        throw new Error(`${source.identity} resolved outside the production closure: ${request.name}`)
      }
      const targetIdentity = packageIdentity(targetOccurrence.manifest)
      if (targetIdentity !== source.identity) dependencies.get(source.identity).add(targetIdentity)
    }
  }

  const rootDependencies = new Set()
  for (const name of Object.keys(projectManifest.dependencies ?? {})) {
    const directory = findPackageDirectory(name, projectRoot, projectRoot)
    if (!directory) throw new Error(`root production dependency is unresolved: ${name}`)
    const occurrence = occurrencesByDirectory.get(normalizedPath(directory))
    if (!occurrence) throw new Error(`root dependency is outside the production closure: ${name}`)
    rootDependencies.add(packageIdentity(occurrence.manifest))
  }
  for (const occurrence of occurrences) {
    if (occurrence.direct) rootDependencies.add(packageIdentity(occurrence.manifest))
  }

  return {
    packages,
    dependencies,
    rootDependencies,
    occurrenceCount: occurrences.length,
  }
}

function purlForPackage(name, version) {
  const encodedName = name.startsWith('@')
    ? `${encodeURIComponent(name.split('/')[0])}/${encodeURIComponent(name.split('/')[1])}`
    : encodeURIComponent(name)
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`
}

function licenseField(expression) {
  if (/\s(?:AND|OR|WITH)\s|[()]/u.test(expression)) return [{ expression }]
  return [{ license: { id: expression } }]
}

function integrityHash(integrity) {
  const match = /^(sha(?:256|384|512))-([A-Za-z0-9+/]+={0,2})$/u.exec(integrity)
  if (!match) return null
  let content
  try {
    content = Buffer.from(match[2], 'base64').toString('hex')
  } catch {
    return null
  }
  if (!content) return null
  return { alg: match[1].toUpperCase().replace('SHA', 'SHA-'), content }
}

function componentForPackage(record, existing) {
  const component = existing ? structuredClone(existing) : {
    type: record.componentType,
    name: record.name,
    version: record.version,
    scope: 'required',
    description: typeof record.manifest.description === 'string'
      ? record.manifest.description
      : undefined,
    author: authorValue(record.manifest.author) || undefined,
    purl: purlForPackage(record.name, record.version),
    licenses: licenseField(record.license),
    externalReferences: record.repository?.startsWith('https://')
      ? [{ type: 'vcs', url: record.repository }]
      : [],
  }
  component['bom-ref'] = record.identity
  component.type = record.componentType
  component.name = record.name
  component.version = record.version
  component.scope = 'required'
  if (!component.purl) component.purl = purlForPackage(record.name, record.version)
  if (!Array.isArray(component.licenses) || component.licenses.length === 0) {
    component.licenses = licenseField(record.license)
  }
  const hash = integrityHash(record.integrity)
  if (hash && (!Array.isArray(component.hashes) || component.hashes.length === 0)) {
    component.hashes = [hash]
  }
  for (const key of ['description', 'author']) {
    if (component[key] === undefined) delete component[key]
  }
  return component
}

function validateSbomCoverage(sbom, inventory) {
  const rootRef = sbom.metadata?.component?.['bom-ref']
  if (typeof rootRef !== 'string' || !rootRef) throw new Error('SBOM root component is missing')
  const expected = new Set(inventory.packages.map(({ identity }) => identity))
  const components = new Map()
  for (const component of sbom.components ?? []) {
    const ref = component?.['bom-ref']
    if (typeof ref !== 'string' || components.has(ref)) {
      throw new Error(`SBOM contains an invalid or duplicate component reference: ${ref}`)
    }
    components.set(ref, component)
  }
  if (components.size !== expected.size
    || [...expected].some((identity) => !components.has(identity))) {
    throw new Error('SBOM components do not exactly cover the production closure')
  }

  const nodes = new Map()
  for (const node of sbom.dependencies ?? []) {
    if (!node || typeof node.ref !== 'string' || nodes.has(node.ref)
      || !Array.isArray(node.dependsOn)) {
      throw new Error('SBOM dependency graph contains an invalid or duplicate node')
    }
    nodes.set(node.ref, node.dependsOn)
  }
  if (!nodes.has(rootRef) || [...expected].some((identity) => !nodes.has(identity))) {
    throw new Error('SBOM dependency graph is missing a root or production package node')
  }
  const validTargets = new Set([rootRef, ...expected])
  for (const [ref, targets] of nodes) {
    if (!validTargets.has(ref)
      || new Set(targets).size !== targets.length
      || targets.some((target) => !expected.has(target))) {
      throw new Error(`SBOM dependency graph contains an invalid edge from ${ref}`)
    }
  }
  return true
}

function buildProductionSbom(baseSbom, inventory) {
  if (!baseSbom || typeof baseSbom !== 'object' || Array.isArray(baseSbom)) {
    throw new TypeError('base SBOM is invalid')
  }
  const rootRef = baseSbom.metadata?.component?.['bom-ref']
  if (typeof rootRef !== 'string' || !rootRef) throw new Error('base SBOM root component is missing')

  const existing = new Map()
  for (const component of baseSbom.components ?? []) {
    if (typeof component?.name !== 'string' || typeof component?.version !== 'string') continue
    const identity = `${component.name}@${component.version}`
    if (!existing.has(identity)) existing.set(identity, component)
  }
  const components = inventory.packages.map((record) => (
    componentForPackage(record, existing.get(record.identity))
  ))
  const dependencies = [{
    ref: rootRef,
    dependsOn: [...inventory.rootDependencies].sort((left, right) => left.localeCompare(right, 'en')),
  }]
  for (const record of inventory.packages) {
    dependencies.push({
      ref: record.identity,
      dependsOn: [...inventory.dependencies.get(record.identity)]
        .sort((left, right) => left.localeCompare(right, 'en')),
    })
  }
  dependencies.sort((left, right) => left.ref.localeCompare(right.ref, 'en'))

  const sbom = {
    ...structuredClone(baseSbom),
    components,
    dependencies,
  }
  validateSbomCoverage(sbom, inventory)
  return sbom
}

function normalizeLicenseText(value) {
  return value.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').trim().concat('\n')
}

function readLicenseDocument(filename, source) {
  const stat = fs.lstatSync(filename)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0
    || stat.size > MAX_LICENSE_DOCUMENT_BYTES) return null
  const buffer = fs.readFileSync(filename)
  if (buffer.includes(0)) return null
  const content = normalizeLicenseText(buffer.toString('utf8'))
  if (content.length < 20) return null
  return {
    content,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
    source,
  }
}

function extractReadmeLicense(value) {
  const lines = value.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').split('\n')
  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (/^#{1,6}\s+licen[cs]e\s*#*\s*$/iu.test(lines[index])) {
      start = index + 1
      break
    }
    if (/^licen[cs]e\s*$/iu.test(lines[index]) && /^[-=]{3,}\s*$/u.test(lines[index + 1] ?? '')) {
      start = index + 2
      break
    }
  }
  if (start < 0) return ''
  let end = lines.length
  for (let index = start; index < lines.length; index += 1) {
    if (/^#{1,6}\s+\S/u.test(lines[index])
      || (index > start && /^\S.*$/u.test(lines[index])
        && /^[-=]{3,}\s*$/u.test(lines[index + 1] ?? ''))) {
      end = index
      break
    }
  }
  const content = normalizeLicenseText(lines.slice(start, end).join('\n'))
  if (content.length < 200
    || !/(?:permission|redistribution|licensed under|copyright|warrant)/iu.test(content)) return ''
  return content
}

function directLicenseDocuments(record) {
  const documents = new Map()
  const add = (document) => {
    if (document && !documents.has(document.sha256)) documents.set(document.sha256, document)
  }

  for (const occurrence of record.occurrences) {
    const names = fs.readdirSync(occurrence.directory).sort((left, right) => left.localeCompare(right, 'en'))
    for (const name of names.filter((value) => LICENSE_FILE_PATTERN.test(value))) {
      add(readLicenseDocument(
        path.join(occurrence.directory, name),
        `${record.identity}/${name}`,
      ))
    }
    if (documents.size === 0) {
      for (const name of names.filter((value) => README_FILE_PATTERN.test(value))) {
        const filename = path.join(occurrence.directory, name)
        const stat = fs.lstatSync(filename)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_LICENSE_DOCUMENT_BYTES) continue
        const content = extractReadmeLicense(fs.readFileSync(filename, 'utf8'))
        if (!content) continue
        add({
          content,
          sha256: crypto.createHash('sha256').update(content).digest('hex'),
          source: `${record.identity}/${name}#license`,
        })
      }
    }
    for (const extra of occurrence.additionalLicenseFiles) {
      const filename = path.resolve(extra)
      add(readLicenseDocument(
        filename,
        `${record.identity}/${path.relative(occurrence.directory, filename).split(path.sep).join('/')}`,
      ))
    }
  }
  return [...documents.values()].sort((left, right) => left.sha256.localeCompare(right.sha256, 'en'))
}

function repositoryKey(record) {
  return record.repository ? `${record.repository.toLocaleLowerCase('en-US')}\n${record.license}` : ''
}

function validateLicenseCoverage(result, inventory) {
  const expected = new Set(inventory.packages.map(({ identity }) => identity))
  const packages = new Map(result.packages.map((entry) => [`${entry.name}@${entry.version}`, entry]))
  if (packages.size !== result.packages.length || packages.size !== expected.size
    || [...expected].some((identity) => !packages.has(identity))) {
    throw new Error('license inventory does not exactly cover the production closure')
  }
  const notices = new Map(result.notices.map((notice) => [notice.id, notice]))
  for (const [identity, entry] of packages) {
    if (!['direct', 'repository', 'declared-only'].includes(entry.licenseTextStatus)
      || !entry.license || /^(?:UNKNOWN|UNLICENSED)$/iu.test(entry.license)
      || !Array.isArray(entry.noticeIds)
      || entry.noticeIds.some((id) => !notices.has(id))) {
      throw new Error(`license inventory entry is incomplete: ${identity}`)
    }
    if (entry.licenseTextStatus === 'declared-only' && entry.noticeIds.length !== 0) {
      throw new Error(`declared-only package unexpectedly references a notice: ${identity}`)
    }
    if (entry.licenseTextStatus !== 'declared-only' && entry.noticeIds.length === 0) {
      throw new Error(`package license text status has no notice: ${identity}`)
    }
  }
  for (const notice of notices.values()) {
    if (!notice.content || !Array.isArray(notice.packages) || notice.packages.length === 0
      || !Array.isArray(notice.sources) || notice.sources.length === 0
      || notice.packages.some((identity) => !packages.has(identity))) {
      throw new Error(`license notice is incomplete: ${notice.id}`)
    }
  }
  return true
}

function buildLicenseInventory(inventory) {
  const directByIdentity = new Map()
  const documentsByRepository = new Map()
  for (const record of inventory.packages) {
    const documents = directLicenseDocuments(record)
    directByIdentity.set(record.identity, documents)
    const key = repositoryKey(record)
    if (!key || documents.length === 0) continue
    if (!documentsByRepository.has(key)) documentsByRepository.set(key, new Map())
    const repositoryDocuments = documentsByRepository.get(key)
    for (const document of documents) repositoryDocuments.set(document.sha256, document)
  }

  const notices = new Map()
  const packages = []
  for (const record of inventory.packages) {
    const direct = directByIdentity.get(record.identity)
    const inherited = direct.length === 0
      ? [...(documentsByRepository.get(repositoryKey(record))?.values() ?? [])]
      : []
    const documents = direct.length > 0 ? direct : inherited
    const status = direct.length > 0 ? 'direct' : (inherited.length > 0 ? 'repository' : 'declared-only')
    const noticeIds = []
    for (const document of documents) {
      const id = `sha256-${document.sha256}`
      let notice = notices.get(id)
      if (!notice) {
        notice = {
          id,
          sha256: document.sha256,
          content: document.content,
          packages: new Set(),
          sources: new Set(),
        }
        notices.set(id, notice)
      } else if (notice.content !== document.content) {
        throw new Error(`license notice hash collision: ${id}`)
      }
      notice.packages.add(record.identity)
      notice.sources.add(document.source)
      noticeIds.push(id)
    }
    packages.push({
      name: record.name,
      version: record.version,
      license: record.license,
      repository: record.repository,
      licenseTextStatus: status,
      noticeIds: [...new Set(noticeIds)].sort((left, right) => left.localeCompare(right, 'en')),
    })
  }

  const result = {
    schemaVersion: 2,
    packages,
    notices: [...notices.values()].map((notice) => ({
      ...notice,
      packages: [...notice.packages].sort((left, right) => left.localeCompare(right, 'en')),
      sources: [...notice.sources].sort((left, right) => left.localeCompare(right, 'en')),
    })).sort((left, right) => left.id.localeCompare(right.id, 'en')),
  }
  validateLicenseCoverage(result, inventory)
  return result
}

function formatThirdPartyNotices(inventory) {
  const lines = [
    'THIRD-PARTY SOFTWARE LICENSE NOTICES',
    '',
    'This file covers the unique production dependency identities shipped by the application.',
    'Identical license texts are included once and mapped to every package that uses them.',
    '',
    'PACKAGE INDEX',
    '',
  ]
  for (const entry of inventory.packages) {
    const repository = entry.repository ? ` | ${entry.repository}` : ''
    lines.push(`${entry.name}@${entry.version} | ${entry.license} | ${entry.licenseTextStatus}${repository}`)
  }

  const declaredOnly = inventory.packages.filter(({ licenseTextStatus }) => (
    licenseTextStatus === 'declared-only'
  ))
  lines.push('', 'DECLARED-ONLY PACKAGES', '')
  if (declaredOnly.length === 0) lines.push('None.')
  else {
    lines.push('The published npm package contained no complete license text, and no matching')
    lines.push('text was available from another shipped package in the same repository.')
    lines.push('The package manifest declaration and source repository are recorded below.', '')
    for (const entry of declaredOnly) {
      lines.push(`${entry.name}@${entry.version} | ${entry.license} | ${entry.repository ?? 'repository not declared'}`)
    }
  }

  lines.push('', 'LICENSE TEXTS')
  for (const notice of inventory.notices) {
    lines.push(
      '',
      '='.repeat(80),
      `Notice: ${notice.id}`,
      `Packages: ${notice.packages.join(', ')}`,
      `Sources: ${notice.sources.join(', ')}`,
      '-'.repeat(80),
      notice.content.trimEnd(),
    )
  }
  return `${lines.join('\n')}\n`
}

module.exports = {
  buildLicenseInventory,
  buildProductionSbom,
  collectProductionInventory,
  extractReadmeLicense,
  formatThirdPartyNotices,
  licenseExpression,
  packageIdentity,
  repositoryUrl,
  validateLicenseCoverage,
  validateSbomCoverage,
}
