// Entry point, Ran with node src/bot.js
// Talk to the bot in minecraft chat:
// get <item> [count]
// inv (checks inventory)
// come (walks to you)
// graph  (list what it has learned)
// stop (stop moving) 

const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { createPrimitives } = require('./primitives')
const { Memory } = require('./memory')
const { Planner } = require('./planner')


const config = {
    host: process.env.MC_HOST || 'localhost',
    port: Number(process.env.MC_PORT || 25565),
    username: process.env.MC_USERNAME || 'uynaM',
    version: process.env.MC_VERSION || '26.1',
    seed: process.env.SEED || 'seed-1',
    viewer: process.env.VIEWER !== '0'
}

const bot = mineflayer.createBot({
    host: 'localhost',
    port: 25565,
    username: 'uynaM',
    version: '26.1',
    auth: 'offline'
})
bot.loadPlugin(pathfinder)
let busy = false

bot.once('spawn', () => {
    const mcData = require('minecraft-data')(bot.version)
    const movements = new Movements(bot)
    movements.allowParkour = false // fewer falls while learning
    movements.liquidCost = 3 //prefer walking around water
    bot.pathfinder.setMovements(movements)

    const prim = createPrimitives(bot, mcData)
    const memory = new Memory()
    memory.wipeWorld(config.seed) // forget cords from other seeds
    const planner = new Planner(bot, mcData, prim, memory, {seed: config.seed})
    console.log(`Spawned At ${bot.entity.position.floored()} on ${bot.version}, seed label "${config.seed}"`)
    bot.chat('Hello World! Say "get wooden_pickaxe" to give me a goal.')

    if (config.viewer) {
        try {
            const {mineflayer: viewer} = require('prismarine-viewer')
            viewer(bot, {port: 3007, firstPerson: false})
            console.log('Viewer at http://localhost:3007')
        } catch (err) {
            console.log('Viewer not available for this verion:', err.message)
        }
    }

    bot.on('chat', async (username, message) => {
        if (username === bot.username) return
        const [cmd, a, b] = message.trim().split(/\s+/)

        if (cmd === 'stop') {bot.pathfinder.setGoal(null);
            return bot.chat('Stopping.')
        }

        if (cmd === 'inv') {
            const items = bot.inventory.items().map((i) => `${i.name} x${i.count}`)
            return bot.chat(items.length ? items.join(', ') : 'Empty.')
        }

        if (cmd == 'graph') {
            const g =  memory.verifiedGraph()
            if(!g.length) return bot.chat('I have not learned anything yet.')
            for (const m of g) bot.chat(`${m.output} <- ${planner.describe(m)} (${m.successes} ok / ${m.failures} fail)`)
            return
        }
        if (busy) return bot.chat('Busy, say "stop" first.')

        if (cmd === 'come') {
            const player = bot.players[username]?.entity
            if (!player) return bot.chat("I can't see you.")
            const p = player.position
            busy = true
            const res = await prim.goTo(new goals.GoalNear(p.x, p.y, p.z, 2))
            busy = false
            return bot.chat(res.ok ? 'Here.' : `Couldn't get there: ${res.reason}`)
        }

        if (cmd === 'get' && a) {
            const item = a
            const count = Number(b || 1)
            if (!mcData.itemsByName[item]) return bot.chat(`"${item}" isn't an item name. Try oak_log or wooden_pickaxe.`)
            busy = true
            bot.chat(`Working on ${item} x${count}...`)
            try {
                const res = await planner.obtain(item, count)
                bot.chat(res.success ? `Got ${item} in ${(res.ms / 1000).toFixed(0)}s (${res.steps} steps).`
            : `Couldn't get ${item}. Check the console for the chain.`)
            } catch (err) {
                console.error(err)
                bot.chat(`Error: ${err.message}`)
            } finally {
                busy = false
            }
        }
      
        /* mine <block> [count] e.g. "mine oak_log 2"
        if (cmd === 'mine' && a) {
            const res = await prim.collect(a, a, prim.count(a) + Number(b || 1))
            return bot.chat(res.ok ? `Now have ${prim.count(a)}` : `Failed: ${res.reason} ${res.detail}`)
        }

        // craft <item> quick test command
        if (cmd === 'craft' && a) {
            const item = mcData.itemsByName[a]
            if (!item) return bot.chat(`Unknown items ${a}`)
            //prefer a recipe we already have the ingredients for
            const recipe = bot.recipesFor(item.id, null, 1, true)[0] || bot.recipesAll(item.id, null, true)[0]
            if (!recipe) return bot.chat(`No recipe for ${a}`)
            const inputs = recipe.delta.filter((d) => d.count < 0)
            .map((d) => ({item: mcData.items[d.id].name, count: -d.count}))
            const station = recipe.requiresTable ? 'crafting_table' : null
            const res = await prim.craft(a, inputs, 1, station)
            return bot.chat(res.ok ? `Crafted ${a}.` : `Failed: ${res.reason} ${res.detail}`)
        }

        if (cmd === 'place' && a) { 
            const res = await prim.placeNear(a)
            return bot.chat(res.ok ? `Placed ${a}.` : `Failed: ${res.reason} ${res.detail}`)
        }
        */
    })
})

bot.on('kicked', (reason) => console.log('Kicked:', reason))
bot.on('error', (err) => console.log('Error:', err.message))
// Safety net: log async errors instead of letting them crash the bot
process.on('unhandledRejection', (err) => console.error('Unhandled error:', err))
process.on('uncaughtException', (err) => console.error('Uncaught error:', err))