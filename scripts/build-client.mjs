#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const index = process.argv.indexOf('--runtime')
if (index < 0 || !process.argv[index + 1]) throw new Error('Usage: node scripts/build-client.mjs --runtime /path/to/compatible-harness-source')
const runtime = resolve(process.argv[index + 1])
const catalog = JSON.parse(readFileSync(join(root, 'UPSTREAM.json'), 'utf8'))
for (const [owner, original] of Object.entries(catalog.packages)) {
  if (!original.startsWith('packages/client/')) continue
  const target = join(root, 'plugins', owner)
  const packageJson = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
  const modules = join(target, 'node_modules')
  const created = !existsSync(modules)
  if (created) symlinkSync(join(runtime, original, 'node_modules'), modules, 'dir')
  const config = join(target, '.build.config.ts')
  const preset = pathToFileURL(join(runtime, 'packages/client/tsdown.client.ts')).href
  writeFileSync(config, `import { clientBundle } from ${JSON.stringify(preset)}\nexport default clientBundle(${JSON.stringify(packageJson.name)}, ['lib/types/index.js'])({}).map(config => ({ ...config, tsconfig: ${JSON.stringify(join(runtime, original, 'tsconfig.json'))} }))\n`)
  try {
    const result = spawnSync(process.execPath, [join(runtime, 'node_modules/tsdown/dist/run.mjs'), '--config', config], { cwd: target, stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`Build failed for ${owner}`)
    for (const entry of readdirSync(join(target, 'lib'))) {
      const artifact = join(target, 'lib', entry)
      if (entry.endsWith('.map')) rmSync(artifact)
      else if (entry.endsWith('.js')) {
        const clean = readFileSync(artifact, 'utf8').split('\n').filter(line => !line.includes('//# sourceMappingURL=') && !(line.includes('//#region') && (line.includes(runtime) || line.includes(root)))).join('\n')
        writeFileSync(artifact, clean)
      }
    }
  } finally {
    rmSync(config, { force: true })
    if (created) rmSync(modules)
  }
}
