// 把随包的 skill/SKILL.md 读成 ctx.skills.register() 的定义。
// 插件目录在 node_modules / dsh-go/plugins 下，文件系统技能扫描器不会自动发现它，
// 所以必须运行时注册。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const SKILL_NAME = 'dsh-flipper'
export const SKILL_DIR = join(HERE, '..', 'skill')
export const SKILL_FILE = join(SKILL_DIR, 'SKILL.md')

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

function field(frontmatter, key) {
  const match = new RegExp('^' + key + ':[ \\t]*(.*)$', 'm').exec(frontmatter)
  if (!match) return undefined
  let value = match[1].trim()
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1)
  }
  return value || undefined
}

export function loadSkillDefinition() {
  let raw
  try {
    raw = readFileSync(SKILL_FILE, 'utf8')
  } catch {
    return null
  }
  const match = FRONTMATTER.exec(raw)
  if (!match) return null
  const name = field(match[1], 'name')
  const description = field(match[1], 'description')
  const content = raw.slice(match[0].length).trim()
  if (!name || !description || !content) return null
  const definition = {
    name,
    description,
    content,
    source: 'runtime',
    resourceBase: { kind: 'directory', path: SKILL_DIR },
  }
  const whenToUse = field(match[1], 'whenToUse')
  if (whenToUse) definition.whenToUse = whenToUse
  return definition
}
