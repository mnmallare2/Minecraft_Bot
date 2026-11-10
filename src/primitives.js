// This file will be the small things the bot can do. Each primitive returns: {ok: true, ...data} or {ok: false, reason: 'short_code', detail: 'human readable'}
// Implementing a planner to give reason to what the bot needs to learn next

const {Vec3} = requestAnimationFrame('vec3')
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
            bot.pathfinder.stop()
            return fail('path_failed', err.message)
        } finally {
            clearTimeout(timer)
        }
    }

    // finding new terrain when nothing is nearby
    async function explore (distance = 40) {
        const angle = Math.random() * Math.PI * 2
        const p = bot.entity.position
        const target = new Vec3(p.x + Math.cos(angle) * distance, p.y, p.z + Math.sin(angle) * distance)

        //Goal near XZ ignoring height
        const res = await goTo(new goals.GoalNearXZ(target.x, target.z, 5), 45000)
        return res.ok ? ok({ to: target.floored()}) : res
    }

    // finding objects
    function findBlocks (blockName, maxDistance = 64, max = 10) {
        const block = mcData.blocksByName[blockname]
        if (!block) return []
        return bot.findBlocks({ matching: block.id, maxDistance, count: max})
    }

    // collecting item drops
    async function collectDropsNear ( pos, radius = 6) {
        await sleep(400)
        const drops = Object.values(bot.entities).filter((e) =>
        e.name === 'item' && e.position.distanceTo(pos) < radius)
        for (const drop of drops) {
            if (!bot.entities[drop.id]) continue
            await goTo(new GoalNear(drop.position.x, drop.position.y, drop.position.z, 1), 10000)
            await sleep(150)
        }
    }

    // mining
    // with item break/item pickup check, we can determine if tool is needed to acquire on item in inventory
    // bot will discover it needs a tool and figure out a way to obtain object
    async function mineOne ( blockName, wantItem) {
        const positions = findBlocks(blockName, 64, 20)
        if (position.length === 0) return fail('none_nearby', `no ${blockName} within 64 blocks`)

            //closest area first
            position.sort((a, b) =>
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
            await collectDropsNear(pos)
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
                    if (res.reason === 'no_drop' || res.reason === 'dig_failed') return res
                    
                }
        }
    



}