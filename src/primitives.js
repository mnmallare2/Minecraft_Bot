// This file will be the small things the bot can do. Each primitive returns: {ok: true, ...data} or {ok: false, reason: 'short_code', detail: 'human readable'}
// Implementing a planner to give reason to what the bot needs to learn next

const {Vec3} = require('vec3')
const {goals} = require('mineflayer-pathfinder')
const {GoalNear, GoalLookAtBlock} = goals
const sleep = (ms) => new Promise((r) => setTimeout(r,ms))
const ok = (data = {}) => ({ok: true, ...data})
const fail = (reason, detail = '') => ({ok: false, reason, detail})

function createPrimitives (bot, mcData) {
    // inventory helper
    function count(itemName) {
        return bot.inventory.items()
        .filter((i) => i.name === itemName)
        .reduce((sum, i) => sum + i.count, 0)
    }

    function hasAny (itemNames) {
        return itemNames.some((n) => count(n) > 0)
    }

    // movement
    // pathfinder can take a while, therefore a timer is used to speed up the process
    async function goTo(goal, timeoutMs = 60000) {
        let timer
        try {
            await Promise.race([
                bot.pathfinder.goto(goal),
                new Promise((_, rej) => { timer = setTimeout(() =>
                rej(new Error('timeout')), timeoutMs)})
            ])
            return ok()
        } catch (err) {
            // Cancelled by clearing the goal
            // Not using bot.pathfinder.stop() so one failure wouldn't make each future move fail instantly
            bot.pathfinder.setGoal(null)
            return fail('path_failed', err.message)
        } finally {
            clearTimeout(timer)
        }
    }

    // finding new terrain when nothing is nearby
    async function explore (distance = 40) {
        await escapeWater()
        let last_error
        for (let attempt = 0; attempt < 4; attempt++) {
        const angle = Math.random() * Math.PI * 2
        const p = bot.entity.position
        const target = new Vec3(p.x + Math.cos(angle) * distance, p.y, p.z + Math.sin(angle) * distance)
        const start = p.clone()
        // GoalNearXZ ignores height: "get within 5 blocks of this spot, any y"
        last = await goTo(new goals.GoalNearXZ(target.x, target.z, 5), 30000)
        const moved = bot.entity.position.distanceTo(start)
        if (last.ok || moved > 10) return ok({to: bot.entity.position.floored(), moved: Math.round(moved)})
    }
        return last
    }

    // getting out of water logic
    // pathfinder can't jump from water onto land, so look for nearest dry block and hold forward + jump
    async function escapeWater(timeoutMs = 10000) {
        if (!bot.entity.isInWater) return ok()
        
        const land = bot.findBlock({
            matching: (b) => b.boundingBox === 'block' && b.name !== 'water',
            maxDistance: 16,
            useExtraInfo: (b) => {
                const above = bot.blockAt(b.position.offset(0, 1, 0))
                return above && above.name === 'air'
            }
        })
        if (!land) return fail('no_land', 'no dry land within 16 blocks')

        bot.setControlState('forward', true)
        bot.setControlState('jump', true)
        const start = Date.now()
        while (bot.entity.isInWater && Date.now() - start < timeoutMs) {
            await bot.lookAt(land.position.offset(0.5, 1, 0.5)) // keep steering
            await sleep(100)
        }
        bot.clearControlStates()
        return bot.entity.isInWater ? fail('still_in_water', 'could not climb out') : ok()
    }

    // finding objects
    function findBlocks (blockName, maxDistance = 64, max = 10) {
        const block = mcData.blocksByName[blockName]
        if (!block) return []
        return bot.findBlocks({ matching: block.id, maxDistance, count: max})
    }

    // collecting item drops
    async function collectDropsNear ( pos, radius = 6) {
        await sleep(500)
        const ids = Object.values(bot.entities)
        .filter((e) => e.name === 'item' && e.position.distanceTo(pos) < radius)
        .map((e) => e.id)
        
        let missed = 0
        for (const id of ids) {
            // Up to 3 tries per item, re-reading where it is each time
            // items keep rolling and falling after they drop
            for (let attempt = 0; attempt < 3 && bot.entities[id]; attempt++) {
                const p = bot.entities[id].position
                await goTo(new GoalNear(p.x, p.y, p.z, 1), 15000)
                await sleep(250)
            }
            if (bot.entities[id]) missed ++ // still on the ground
        }
        return {seen: ids.length, missed}
    }

    // mining
    // with item break/item pickup check, we can determine if tool is needed to acquire on item in inventory
    // bot will discover it needs a tool and figure out a way to obtain object
    async function mineOne ( blockName, wantItem) {
        const positions = findBlocks(blockName, 64, 20)
        if (positions.length === 0) return fail('none_nearby', `no ${blockName} within 64 blocks`)

            //closest area first
            positions.sort((a, b) =>
        a.distanceTo(bot.entity.position) - 
        b.distanceTo(bot.entity.position))

        for (const pos of positions.slice(0,5)) {
            const path = await goTo(new GoalLookAtBlock(pos, bot.world), 30000)
            if (!path.ok) continue //try the next one if possibly unreachable
            const block = bot.blockAt(pos)
            if(!block || block.name !== blockName) continue
            
            const tool = bot.pathfinder.bestHarvestTool(block)
            if (tool) await bot.equip(tool, 'hand')
            else if (bot.heldItem) await bot.unequip('hand')

            const before = count(wantItem)
            try {
                await bot.dig(block, true)
            } catch (err) {
                return fail('dig_failed', err.message)
            }
            const drops = await collectDropsNear(pos)
            const gained = count(wantItem) - before
            if (gained <= 0) return fail('no_drop', `broke ${blockName} but got no ${wantItem}`)
            return ok({gained})
            }
            return fail('unreachable', `found ${blockName} but could not reach any`)
        }

        // Keep mining until we hold 'target' of 'wantItem'
        // explore: false = give up right away if none nearby
        // planner expects something else (other methods)
        async function collect (blockName, wantItem, target, {
            explore: canExplore = true } = {}) {
                let misses = 0
                while (count(wantItem) < target) {
                    const res = await mineOne(blockName, wantItem)
                    if (res.ok) { misses = 0; continue }
                    // Lost a drop: just mine another one, no need to explore
                    if (res.reason === 'pickup_failed') { if (++misses > 3) return res; continue}
                    if (res.reason === 'no_drop' || res.reason === 'dig_failed') return res
                    if (!canExplore || ++misses >3) return res
                    bot.chat(`No Reachable ${blockName}, exploring...`)
                    const ex = await explore()
                    console.log('explore result: ', ex)
                    if (!ex.ok && misses > 2) return res
                }
                return ok()
        }

        // Placing an item from the inventory on top of a solid block
        async function placeNear (itemName) {
            const item = bot.inventory.items().find((i) => i.name === itemName)
            if (!item) return fail('missing', `no ${itemName} in inventory`)

            const feet = bot.entity.position.floored()
            for (let dx = -2; dx <=2; dx++) {
                for (let dz = -2; dz <= 2; dz++) {
                    if (Math.abs(dx) + Math.abs(dz) < 2) continue
                    for (let dy = -1; dy <=1; dy++) {
                        const ref = bot.blockAt(feet.offset(dx,dy,dz))
                        const above = bot.blockAt(feet.offset(dx, dy + 1, dz))
                        if (!ref || !above) continue
                        if (ref.boundingBox !== 'block' || above.name !== 'air') continue
                        try {
                            await bot.equip(item, 'hand')
                            await bot.placeBlock(ref, new Vec3(0, 1, 0))
                        } catch (err) {
                            //placeBlock can time out when block landed
                        }
                        const placed = bot.blockAt(above.position)
                        if (placed && placed.name === itemName)
                            return ok({block: placed})
                    }
                }
            }
            return fail('no_space', `nowhere to place ${itemName}`)
        }



        // crafting
        // inputs for ONE craft (times: how many crafts to do)
        // station: null (2x2 inventory grid or 3x3 crafting table)
        async function craft (itemName, inputs, times, station) {
            const item = mcData.itemsByName[itemName]
            if (!item) return fail('unknown_item', itemName)

            // check ingredients
            const missing = inputs
            .map((i) => ({item: i.item, need: i.count * times - count(i.item) }))
            .filter((m) => m.need > 0)
            if (missing.length) {
                return fail('missing', missing.map((m) => `${m.item} x${m.need}`).join(', '))
            }

            // Get to crafting station if required
            let table = null
            if (station) {
                const pos = findBlocks(station, 32, 1)[0]
                if (!pos) return fail('no_station', `no ${station} within 32 blocks`)
                const path = await goTo(new GoalNear(pos.x, pos.y, pos.z, 2), 30000)
                if (!path.ok) return fail('no_station', ` can't reach ${station}`)
                table = bot.blockAt(pos)
            }

            // find the game's recipe that matches the ingredients in planner
            const want = new Set(inputs.map((i) => i.item))
            const recipe = bot.recipesAll(item.id, null, table).find((r) => {
                const ins = r.delta.filter((d) => d.count < 0).map((d) => mcData.items[d.id].name)
                return ins.length === want.size && ins.every((n) => want.has(n))
            })
            if (!recipe) return fail('no_recipe', `the game has no ${itemName} recipe from ${[...want].join(' + ')}`)

            try {
                await bot.craft(recipe, times, table)
            } catch (err) {
                return fail('craft_failed', err.message)
            }
            return ok()
        }
    

        // misc.
        async function eat() {
            const food = bot.inventory.items().find((i) => mcData.foodsByName[i.name])
            if (!food) return fail('no_food')
            await bot.equip(food, 'hand')
        try { await bot.consume() } catch (err) { return fail('eat_failed', err.message) }
        return ok()
        }
        return { count, hasAny, goTo, explore, escapeWater, findBlocks, mineOne, collect, placeNear, craft, eat, sleep}
}

module.exports = { createPrimitives}