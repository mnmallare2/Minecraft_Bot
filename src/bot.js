const mineflayer = require('mineflayer')

const bot = mineflayer.createBot({
    host: 'localhost',
    port: 25565,
    username: 'uynaM',
    version: '26.1',
    auth: 'offline'
})

bot.once('spawn', () => {
    console.log('Spawned at', bot.entity.position.floored())
    bot.chat("Hello World!")
})

bot.on('chat', (username, message) => {
    if (username === bot.username) return
    if (message === "inv") {
        const items = bot.inventory.items().map((i) =>
        `${i.name} x${i.count}`)
        bot.chat(items.length ? items.join(', ') : 'Empty.')
    }
})

bot.on('kicked', (reason) => console.log('Kicked:', reason))
bot.on('error', (err) => console.log('Error:', err.message))