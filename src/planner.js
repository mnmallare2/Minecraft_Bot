// planner.js
// The recursive goal resolver
// Need X, therefore search for X in memory
// get X's inputs first -> do it -> write down what happened
// When memory doesn't know how to do an action, discover() writes them down
// HYPOTHESES (unverified methods). a method is verified through knowledge after it works

const TOOL_ORDER = ['wooden_', 'stone_', 'iron_', 'diamond_', 'golden_', 'netherite_']
const MAX_DEPTH = 12
const FAR_AWAY = 40
const UNKNOWN = 100

class Planner {
    constructor (bot, mcData, prim, memory, {seed = 'unknown'} = {}) {
        this.bot = bot
        this.mcData = mcData
        this.prim = prim
        this.memory = memory
        this.seed = seed
        this.chain = []
        this.nearbyCache = new Map()
    }

    // public entry point
    async obtain(item, count = 1) {
        const start = Date.now()
        this.chain = []
        let success = false

        // plan with what is around the bot
        // if nothing works, the bot will explore (walk around) (up to 4 rounds)
        for (let round = 0; round < 4 && !success; round ++) {
            if (round > 0 ) {
                this.note(0, item, `round ${round}: nothing workable nearby, exploring`)
                await this.prim.explore(60)
            }
            this.nearbyCache.clear()
            success = await this._obtain(item, count, 0, new Set())
        }
        const ms = Date.now() - start
        this.memory.logEpisode({seed: this.seed, goal: `${item} x${count}`, success, chain: this.chain, ms})
        return {success, ms, steps: this.chain.length}
    }

    // the recursive step
    async _obtain(item, count, depth, stack) {
        if (this.prim.count(item) >= count) return true
        if (depth > MAX_DEPTH) return this.note(depth, item, 'gave up: too deep', false)
        // stack holds the items we're already cashing higher up, without it, a recipe loop would recursve forever
        if (stack.has(item)) return this.note(depth, item, 'skip: already working on this higher up', false)

        stack.add(item)
        try {
            this.note(depth, item, `need ${count} (have ${this.prim.count(item)})`)
            this.discover(item)
            const methods = this.rank(this.memory.getMethods(item))
            if (methods.length === 0) return this.note(depth, item, 'no idea how to get this', false)

            for (const method of methods.slice(0, 4)) {
                let m = method
                for (let attempt = 0; attempt < 2; attempt++) {
                    const res = await this.tryMethod(m, item, count, depth, stack)
                    if (res.ok) return true
                    if (!res.retry) break
                    m = this.memory.getMethods(item).find((x) => x.id === m.id) // reload: we learned something
                }
            }
            return this.note(depth, item, 'every method failed', false)
        } finally {
            stack.delete(item)
        }
    }

    async tryMethod(m, item, count, depth, stack) {
        const t0 = Date.now()
        this.note(depth, item, `try: ${this.describe(m)}`)
        let res

        if (m.kind === 'mine') {
            // Do we need a tool first?
            if (m.tool_any && !this.prim.hasAny(m.tool_any)) {
                const gotTool = await this._obtain(m.tool, 1, depth + 1, stack)
                if (!gotTool) return {ok: false}
        }
        res = await this.prim.collect(m.source_block, item, count, {explore: false})

        // Learning from a mistake: we broke the block but nothing dropped.
        if (!res.ok && res.reason === 'no_drop' && !m.tool) {
            const learned = this.learnToolRequirement(m)
            this.memory.record(m.id, false, Date.now() - t0, `${res.reason}: ${res.detail}`)
            if (learned) {
                this.note(depth, item, `LEARNED: ${m.source_block} needs a ${learned} or better`)
                return {ok: false, retry: true}
            }
            return {ok: false}
        }
    } else {
        const have = this.prim.count(item)
        const times = Math.ceil((count-have)/m.output_count)

        // Station FIRST: building a crafting table eats planks, and we don't want it to eat the planks we just gathered for this recipe
        if (m.station) {
            const stationOk = await this.ensureStation(m.station, depth+1, stack)
            if (!stationOk) return {ok: false}
        }

        // Gather the inputs
        // Getting one input can use up another needed, so check up to 3 times
        for (let pass = 0; pass < 3; pass++) {
            const short = m.inputs.filter((i) => this.prim.count(i.item) < i.count * times)
            if (short.length === 0) break
            for (const input of short) {
                const ok = await this._obtain(input.item, input.count * times, depth+1, stack)
                if (!ok) return {ok: false} // not this method's fault: don't count it against the mthod
            }
        }
        res = await this.prim.craft(item, m.inputs, times, m.station)
    }

    const ms = Date.now() - t0
    this.memory.record(m.id, res.ok, ms, res.ok ? null : `${res.reason}: ${res.detail}`)
    this.note(depth, item, res.ok ? `done in ${(ms/1000).toFixed(1)}s` : `failed: ${res.reason} ${res.detail}`, res.ok)
    return res
    }

    // stations
    async ensureStation(station, depth, stack) {
        if (this.prim.findBlocks(station, 32, 1).length > 0) return true
        if (!(await this._obtain(station, 1, depth, stack))) return false
        const res = await this.prim.placeNear(station)
        if (!res.ok) return this.note(depth, station, `could not place: ${res.reason}`, false)
        this.memory.remember(this.seed, 'station', station, res.block.position)
        this.nearbyCache.delete(station)
        this.note(depth, station, 'placed')
        return true
    }

    // Learning
    // Turn "I know nothing" into hypothesis, using the game's data
    // Using recipe book, block look
    // All start unverified until a success verifies them
    discover (item) {
        if (this.memory.getMethods(item).length > 0) return
        const def = this.mcData.itemsByName[item]
        if (!def) return

        for (const r of  this.bot.recipesAll(def.id, null, true).slice(0,16)) {
            const inputs = {}
            for (const d of r.delta) {
                if (d.count >= 0) continue
                const name = this.mcData.items[d.id].name
                inputs[name] = (inputs[name] || 0) - d.count
            }
            this.memory.addMethod({
                kind: 'craft',
                output: item,
                outputCount: r.result.count,
                station: r.requiresTable ? 'crafting_table' : null,
                inputs: Object.entries(inputs).map(([name, n]) => ({item: name, count: n}))
            })
        }
        for (const block of this.mcData.blocksArray) {
            const drops = (block.drops || []).map((d) => (typeof d === 'number' ? d : d?.drop?.id ?? d?.drop))
            if (drops.includes(def.id)) {
                this.memory.addMethod({kind: 'mine', output: item, sourceBlock: block.name})
            }
        }
    }

    learnToolRequirement (m) {
        const block = this.mcData.blocksByName[m.source_block]
        if (!block || !block.harvestTools) return null
        const tools = Object.keys(block.harvestTools).map((id) => this.mcData.items[id].name)
        const tier = (name) => {
            const i = TOOL_ORDER.findIndex((p) => name.startsWith(p))
            return i === -1 ? 99 : i
        }
        tools.sort((a, b) => tier(a) - tier(b))
        this.memory.setTool(m.id, tools[0], tools)
        return tools[0]
    }

    // Choosing between methods
    // Cheapest first
    // Estimated cost in the current world, minus a bonus for methods that have worked before
    rank (methods) {
        const memo = new Map()
        const scored = methods.map((m) => ({m, cost: this.estimateMethod(m, 0, memo) - 3 * m.score}))
        return scored.sort((a, b) => a.cost - b.cost).map((s) => s.m)
    }

    estimateItem( item, depth, memo) {
        if (this.prim.count(item) > 0) return 0
        if (memo.has(item)) return memo.get(item)
        if (depth > 6) return UNKNOWN
        memo.set(item, UNKNOWN) // guards against cycles
        this.discover(item)
        const methods = this.memory.getMethods(item)
        const cost = methods.length ? Math.min(...methods.map((m) => this.estimateMethod(m, depth + 1, memo))) : UNKNOWN
        memo.set(item, cost)
        return cost
    }

    estimateMethod(m, depth, memo) {
        if (m.kind === 'mine') {
            const toolCost = m.tool_any && !this.prim.hasAny(m.tool_any) ? this.estimateItem(m.tool, depth, memo) : 0
            return (this.isNearby(m.source_block) ? 1 : FAR_AWAY) + toolCost
        }
        let cost = 1
        for (const i of m.inputs) cost += this.estimateItem(i.item, depth, memo)
        if (m.station && !this.isNearby(m.station)) cost += this.estimateItem(m.station, depth, memo)
            return cost
    }

    isNearby(blockName) {
        const hit = this.nearbyCache.get(blockName)
        if (hit && Date.now() - hit.at < 30000) return hit.value
        const value = this.prim.findBlocks(blockName, 48, 1).length > 0
        this.nearbyCache.set(blockName, {value, at: Date.now()})
        return value
    }

    // logging
    describe (m) {
        if (m.kind === 'mine') return `mine ${m.source_block}${m.tool ? ` with ${m.tool}+` : ''}`
        const ins = m.inputs.map((i) => `${i.count} ${i.item}`).join(' + ')
        return `craft from ${ins}${m.station ? ` at ${m.station}` : ''}`
  }

    note (depth, item, text, ok = null) {
        this.chain.push({ depth, item, text, ok, t: Date.now() })
        console.log(`${'  '.repeat(depth)}${ok === false ? 'x ' : ok ? '✓ ' : '- '}${item}: ${text}`)
        return ok === null ? undefined : ok
  }
}

module.exports = {Planner}