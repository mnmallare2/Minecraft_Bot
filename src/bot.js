const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { createPrimitives } = require('./primitives')

const bot = mineflayer.createBot({
    host: 'localhost',
    port: 25565,
    username: 'uynaM',
    version: '26.1',
    auth: 'offline'
})
bot.loadPlugin(pathfinder)

bot.once('spawn', () => {
    const mcData = require('minecraft-data')(bot.version)
    bot.pathfinder.setMovements(new Movements(bot))
    const prim = createPrimitives(bot, mcData)
    bot.chat('Ready. Try: mine oak_log 3')

    bot.on('chat', async (username, message) => {
        if (username === bot.username) return
        const [cmd, a, b] = message.trim().split(/\s+/)

        if (cmd === 'inv') {
            const items = bot.inventory.items().map((i) => `${i.name} x${i.count}`)
            return bot.chat(items.length ? items.join(', ') : 'Empty.')
        }

        if (cmd === 'come') {
            const p = bot.players[username]?.entity?.position
            if (!p) return bot.chat("I can't see you.")
            const res = await prim.goTo(new goals.GoalNear(p.x, p.y, p.z, 2))
            return bot.chat(res.ok ? 'Here.' : `Failed: ${res.reason}`)
        }

        // mine <block> [count] e.g. "mine oak_log 2"
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

    })
})

bot.on('kicked', (reason) => console.log('Kicked:', reason))
bot.on('error', (err) => console.log('Error:', err.message))