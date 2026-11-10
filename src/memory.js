// holds everything the bot learns
// survives restarts, deaths, and new game seeds
// items are nodes, needs-relations are edges
// hyperedge graph

// The long-term memory will be stored in one SQLite file (data/memory.db)
// Knowledge graph (kept across seeds):
// items = nodes; moethods = ways to get item, craft, or mine
// method_inputs = the edges

const path = require('path')
const fs = require('fs')
const Database = require('better-sqlite3')

const SCHEMA = `
CREATE TABLE IF NOT EXISTS  items (
name TEXT PRIMARY KEY,
first_seen TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS methods (
id INTEGER PRIMARY KEY,
output TEXT NOT NULL REFERENCES items(name),
output_count INTEGER NOT NULL DEFAULT 1,
kind TEXT NOT NULL CHECK (kind IN ('craft', 'mine')),
source_block TEXT,
station TEXT,
tool TEXT,
tool_any TEXT,
signature TEXT NOT NULL UNIQUE,
verified INTEGER NOT NULL DEFAULT 0,
successes INTEGER NOT NULL DEFAULT 0,
failures INTEGER NOT NULL DEFAULT 0,
avg_ms REAL,
last_error TEXT,
learned_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS methods_by_output ON methods(output);

CREATE TABLE IF NOT EXISTS method_inputs (
method_id INTEGER NOT NULL REFERENCES methods(id) ON DELETE CASCADE,
item TEXT NOT NULL REFERENCES items(name),
count INTEGER NOT NULL,
PRIMARY KEY (method_id, item)
);

CREATE TABLE IF NOT EXISTS episodes (
id INTEGER PRIMARY KEY,
seed TEXT,
goal TEXT NOT NULL,
success INTEGER NOT NULL,
chain_json TEXT NOT NULL,
ms INTEGER,
created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS milestones (
id INTEGER PRIMARY KEY,
seed TEXT NOT NULL,
name TEXT NOT NULL,
game_time INTEGER,
real_ms INTEGER,
created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS lessons (
id INTEGER PRIMARY KEY,
situation TEXT NOT NULL,
lesson TEXT NOT NULL,
created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS world (
id INTEGER PRIMARY KEY,
seed TEXT NOT NULL,
kind TEXT NOT NULL,
name TEXT,
x INTEGER, y INTEGER, z INTEGER
);
`

class Memory {
    constructor (file = path.join(__dirname, '..', 'data', 'memory.db')) {
        fs.mkdirSync(path.dirname(file), {recursive: true})
        this.db = new Database(file)
        this.db.pragma('journal_mode = WAL')
        this.db.pragma('foreign_keys = ON')
        this.db.exec(SCHEMA)
    }

    // nodes
    addItem(name) {
        this.db.prepare('INSERT OR IGNORE INTO items(name) VALUES (?)').run(name)
    }

    // methods (graph)
    // signature is a text fingerprint of a method, so the same recipe doesn't get stored twice
    static signature ({kind, output, sourceBlock, station, inputs = [] }) {
        const ins = inputs.map((i) => `${i.item}*${i.count}`).sort().join('+')
        return [kind, output, sourceBlock || '', station || '', ins].join('|')
    }

    // adds method if it is new
    addMethod ({kind, output, outputCount = 1, sourceBlock = null, station = null, inputs = []}) {
        const signature = Memory.signature({kind, output, sourceBlock, station, inputs})
        const existing = this.db.prepare('SELECT id FROM methods WHERE signature = ?').get(signature)
        if (existing) return existing.id

        const insert = this.db.transaction(() => {
            this.addItem(output)
            const {lastInsertRowid} = this.db.prepare(`INSERT INTO methods(output, output_count, kind, source_block, station, signature)
                VALUES (?, ?, ?, ?, ?, ?)`).run(output, outputCount, kind, sourceBlock, station, signature)
                for (const i of inputs) {
                    this.addItem(i.item)
                    this.db.prepare('INSERT INTO method_inputs(method_id, item, count) VALUES (?, ?, ?)')
                    .run(lastInsertRowid, i.item, i.count)
                }
                return Number(lastInsertRowid)
        })
        return insert()
    }

    // Every known way to get an item, best first
    getMethods (item) {
        const rows = this.db.prepare('SELECT * FROM methods WHERE output = ?').all(item)
        const inputsFor = this.db.prepare('SELECT item, count FROM method_inputs WHERE method_id = ?')
        for ( const m of rows) {
            m.inputs = inputsFor.all(m.id)
            m.tool_any = m.tool_any ? JSON.parse(m.tool_any) : null
            m.score = Memory.score(m)
        }
        return rows.sort((a, b) => b.score - a.score || (a.avg_ms ?? 1e9) - (b.avg_ms ?? 1e9))
    }

    // success rate with a small prior, plus a bonus for proven methods
    // prior means a brand=new method starts at 0.5 instead of 0 or 1
    static score (m) {
        return (m.successes + 1) / (m.successes + m.failures + 2) + (m.verified ? 0.5 : 0)
    }

    record (methodId, success, ms, error = null) {
        
    }
}