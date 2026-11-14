// Prints what the bot has learned as a Mermaid Diagram
// Run node src/showGraph.js (verified knowledge)
// Run node src/showGraph.js --all (include unverified hypothesis)
// Paste output into https://mermaid.live to see the graph

const { Memory } = require('./memory')

const memory = new Memory()
const all = process.argv.includes('--all')
const methods = memory.db.prepare(`SELECT * FROM methods ${all ? '' : 'WHERE verified = 1'}`).all()
const inputs = memory.db.prepare('SELECT item, count FROM method_inputs WHERE method_id = ?')

const id = (name) => name.replace(/[^a-zA-Z0-9_]/g, '_')
const lines = ['graph LR']
for (const m of methods) {
  const style = m.verified ? '-->' : '-.->'
  if (m.kind === 'mine') {
    const tool = m.tool ? ` with ${m.tool}` : ''
    lines.push(`  ${id('block_' + m.source_block)}[/"${m.source_block} block"/] ${style}|"mine${tool}"| ${id(m.output)}`)
  } else {
    for (const i of inputs.all(m.id)) {
      const at = m.station ? ` @${m.station}` : ''
      lines.push(`  ${id(i.item)} ${style}|"x${i.count}${at}"| ${id(m.output)}`)
    }
  }
}
console.log(lines.join('\n'))

const stats = memory.db.prepare(`SELECT
  (SELECT COUNT(*) FROM methods WHERE verified = 1) AS verified,
  (SELECT COUNT(*) FROM methods WHERE verified = 0) AS hypotheses,
  (SELECT COUNT(*) FROM episodes) AS episodes`).get()
console.error(`\n${stats.verified} verified methods, ${stats.hypotheses} untested hypotheses, ${stats.episodes} episodes logged`)