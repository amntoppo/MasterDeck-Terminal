/**
 * How a file tab shows a file: Markdown, highlighted code, plain text, or a sentence saying why
 * not (binary, too large …). The limits keep a tab from freezing the window or the bridge.
 */

export const FILE_MAX_BYTES = 1_000_000
export const FILE_MAX_LINES = 20_000
/** Lines of a diff drawn; the rest is cut with a note. */
export const DIFF_MAX_LINES = 5_000
/** Bytes looked at for a NUL to call a file binary. */
export const BINARY_SNIFF = 8000

export type FileView = { kind: 'markdown' } | { kind: 'code'; lang: string } | { kind: 'text' }

export type FileRefusal = 'binary' | 'too-large' | 'missing' | 'outside' | 'not-file'

// Extensions to highlight.js languages (all in `highlight.js/lib/common`, plus dockerfile).
const BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', json5: 'json',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin',
  swift: 'swift', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp', m: 'objectivec', mm: 'objectivec', php: 'php', pl: 'perl', pm: 'perl', lua: 'lua', r: 'r',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  css: 'css', scss: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', plist: 'xml', vue: 'xml',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', env: 'ini',
  sql: 'sql', graphql: 'graphql', gql: 'graphql', diff: 'diff', patch: 'diff',
  mk: 'makefile', dockerfile: 'dockerfile', vb: 'vbnet', wat: 'wasm',
}
const BY_NAME: Record<string, string> = {
  makefile: 'makefile', gnumakefile: 'makefile', dockerfile: 'dockerfile', containerfile: 'dockerfile',
  gemfile: 'ruby', rakefile: 'ruby', '.bashrc': 'bash', '.zshrc': 'bash', '.profile': 'bash',
  '.gitignore': 'ini', '.gitattributes': 'ini', '.editorconfig': 'ini', '.npmrc': 'ini',
}

export function viewKind(path: string): FileView {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1) : ''
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return { kind: 'markdown' }
  const lang = BY_NAME[name] ?? (ext ? BY_EXT[ext] : undefined)
  return lang ? { kind: 'code', lang } : { kind: 'text' }
}

/** Why a file is not shown, or null when it is fine. */
export function limitOf(f: { bytes: number; lines?: number; binary: boolean }): FileRefusal | null {
  if (f.binary) return 'binary'
  if (f.bytes > FILE_MAX_BYTES || (f.lines ?? 0) > FILE_MAX_LINES) return 'too-large'
  return null
}

export function messageFor(r: FileRefusal): string {
  switch (r) {
    case 'binary':
      return 'This is a binary file. It is not shown here.'
    case 'too-large':
      return `This file is too large to show here (over 1 MB or ${FILE_MAX_LINES.toLocaleString('en-US')} lines).`
    case 'missing':
      return 'This file is not there any more.'
    case 'outside':
      return "This path is outside the session's folder."
    case 'not-file':
      return 'This is not a file.'
  }
}
