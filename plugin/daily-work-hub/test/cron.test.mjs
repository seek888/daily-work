import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseCron,
  nextRunAt,
  describeCron,
  cronMatches,
  isValidTimeZone,
} from '../lib/cron.js'

const at = (iso) => Date.parse(iso)
const SHANGHAI = 'Asia/Shanghai'

test('parseCron 解析步长、范围与列表', () => {
  const parsed = parseCron('*/15 0-6 1,15 * 1-5')
  assert.deepEqual(parsed.minutes, [0, 15, 30, 45])
  assert.deepEqual(parsed.hours, [0, 1, 2, 3, 4, 5, 6])
  assert.deepEqual(parsed.daysOfMonth, [1, 15])
  assert.equal(parsed.months.length, 12)
  assert.deepEqual(parsed.daysOfWeek, [1, 2, 3, 4, 5])
  assert.equal(parsed.domAny, false)
  assert.equal(parsed.dowAny, false)
  assert.equal(parsed.fields.minute, '*/15')
  assert.equal(parsed.fields.dayOfWeek, '1-5')
})

test('parseCron 把 7 当作周日，并支持 a/n 简写', () => {
  assert.deepEqual(parseCron('0 0 * * 7').daysOfWeek, [0])
  assert.deepEqual(parseCron('0 0 * * 5-7').daysOfWeek, [0, 5, 6])
  assert.equal(parseCron('0 0 * * 0-7').daysOfWeek.length, 7)
  assert.deepEqual(parseCron('5/20 * * * 1/2').minutes, [5, 25, 45])
  assert.deepEqual(parseCron('5/20 * * * 1/2').daysOfWeek, [0, 1, 3, 5])
})

test('parseCron 拒绝畸形表达式', () => {
  const bad = [
    '',
    '0 18 * *',
    '0 18 * * 5 6',
    '60 * * * *',
    '* 24 * * *',
    '* * 0 * *',
    '* * 32 * *',
    '* * * 13 *',
    '* * * * 8',
    '*/0 * * * *',
    '1-5/0 * * * *',
    '*/x * * * *',
    'a * * * *',
    '1.5 * * * *',
    '0 18 * * 5,',
    '1-5-7 * * * *',
    '5/2/1 * * * *',
    '10-5 * * * *',
  ]
  for (const expression of bad) {
    assert.throws(() => parseCron(expression), Error, `应拒绝: ${expression}`)
  }
})

test('nextRunAt 按 IANA 时区计算下一次匹配（上海）', () => {
  // 2026-11-09 是周一；下一次周五 18:00（+08:00）
  const monday = at('2026-11-09T00:00:00+08:00')
  assert.equal(nextRunAt('0 18 * * 5', SHANGHAI, monday), at('2026-11-13T18:00:00+08:00'))
  // 严格在 from 之后：正好落在窗口上时顺延一周
  assert.equal(
    nextRunAt('0 18 * * 5', SHANGHAI, at('2026-11-13T18:00:00+08:00')),
    at('2026-11-20T18:00:00+08:00'),
  )
  // 10:00Z = 上海 18:00，同一周五仍是 10:00Z
  assert.equal(nextRunAt('0 18 * * 5', SHANGHAI, at('2026-11-10T10:00:00Z')), at('2026-11-13T10:00:00Z'))
  // 秒级时间也要顺延到下一分钟
  assert.equal(
    nextRunAt('0 18 * * 5', SHANGHAI, at('2026-11-13T18:00:30+08:00')),
    at('2026-11-20T18:00:00+08:00'),
  )
})

test('nextRunAt 跨天、跨月、闰年与分钟步长', () => {
  assert.equal(nextRunAt('0 8 * * *', 'UTC', at('2026-11-09T09:00:00Z')), at('2026-11-10T08:00:00Z'))
  assert.equal(nextRunAt('0 9 * * 1', 'UTC', at('2026-11-09T10:00:00Z')), at('2026-11-16T09:00:00Z'))
  assert.equal(nextRunAt('0 0 1 * *', 'UTC', at('2026-01-15T00:00:00Z')), at('2026-02-01T00:00:00Z'))
  assert.equal(nextRunAt('*/15 * * * *', 'UTC', at('2026-11-09T12:07:00Z')), at('2026-11-09T12:15:00Z'))
  assert.equal(nextRunAt('30 9 * * *', 'UTC', at('2026-11-09T09:30:00Z')), at('2026-11-10T09:30:00Z'))
  // 2026 不是闰年：下一次 2 月 29 日是 2028
  assert.equal(nextRunAt('0 0 29 2 *', 'UTC', at('2026-03-01T00:00:00Z')), at('2028-02-29T00:00:00Z'))
})

test('nextRunAt 在夏令时边界不抛错：跳过不存在的时间、取重复时间的第一次', () => {
  const ny = 'America/New_York'
  // 2026-03-08 02:30 本地不存在（拨快到 03:00），应退到 03-09 02:30（EDT）
  assert.equal(
    nextRunAt('30 2 * * *', ny, at('2026-03-08T00:00:00-05:00')),
    at('2026-03-09T02:30:00-04:00'),
  )
  // 2026-11-01 01:30 出现两次（EDT 后 EST），取更早的一次
  assert.equal(
    nextRunAt('30 1 * * *', ny, at('2026-11-01T00:00:00-04:00')),
    at('2026-11-01T01:30:00-04:00'),
  )
  assert.doesNotThrow(() => nextRunAt('0 * * * *', 'Europe/Berlin', Date.now()))
})

test('nextRunAt 与 cronMatches 拒绝无效时区/表达式', () => {
  assert.throws(() => nextRunAt('* * * * *', 'Mars/Olympus', 0), /无效时区/)
  assert.throws(() => nextRunAt('* * * * *', '', 0), /时区/)
  assert.throws(() => nextRunAt('bad', 'UTC', 0), Error)
  assert.throws(() => cronMatches('bad', new Date(), 'UTC'), Error)
  assert.throws(() => cronMatches('* * * * *', new Date(), 'Nowhere/Zone'), /无效时区/)
  assert.equal(isValidTimeZone('Asia/Shanghai'), true)
  assert.equal(isValidTimeZone('UTC'), true)
  assert.equal(isValidTimeZone('Asia/Nowhere'), false)
  assert.equal(isValidTimeZone(''), false)
})

test('cronMatches 实现 day-of-month / day-of-week 的 OR 语义', () => {
  // 两者都受限（13 号 且/或 周五）时任一命中即可
  assert.equal(cronMatches('0 0 13 * 5', at('2026-11-06T00:00:00Z'), 'UTC'), true) // 周五
  assert.equal(cronMatches('0 0 13 * 5', at('2026-11-13T00:00:00Z'), 'UTC'), true) // 周五 + 13
  assert.equal(cronMatches('0 0 13 * 5', at('2026-12-13T00:00:00Z'), 'UTC'), true) // 13 号（周日）
  assert.equal(cronMatches('0 0 13 * 5', at('2026-11-10T00:00:00Z'), 'UTC'), false) // 周二 10 号
  assert.equal(cronMatches('0 0 13 * 5', at('2026-12-14T00:00:00Z'), 'UTC'), false) // 周一 14 号
  // 只有 day-of-week 受限时按周五判定
  assert.equal(cronMatches('0 0 * * 5', at('2026-11-06T00:00:00Z'), 'UTC'), true)
  assert.equal(cronMatches('0 0 * * 5', at('2026-11-05T00:00:00Z'), 'UTC'), false)
  // OR 语义让下一个更早的“周五”先于“12 月 13 日”
  assert.equal(
    nextRunAt('0 0 13 * 5', 'UTC', at('2026-11-13T12:00:00Z')),
    at('2026-11-20T00:00:00Z'),
  )
  // 上海时区下按本地日历判定
  assert.equal(cronMatches('0 9 * * 1', at('2026-11-09T09:00:00+08:00'), SHANGHAI), true)
  assert.equal(cronMatches('0 9 * * 1', at('2026-11-09T09:00:00Z'), SHANGHAI), false)
})

test('describeCron 给出中文摘要，无法描述时回退原表达式', () => {
  assert.equal(describeCron('0 18 * * 5'), '每周五 18:00')
  assert.equal(describeCron('0 8 * * 1-5'), '工作日 08:00')
  assert.equal(describeCron('*/30 * * * *'), '每 30 分钟')
  assert.equal(describeCron('0 0 1 * *'), '每月 1 日 00:00')
  assert.equal(describeCron('0 9 * * *'), '每天 09:00')
  assert.equal(describeCron('0 0 * * 0,6'), '周末 00:00')
  assert.equal(describeCron('* * * * *'), '每分钟')
  assert.equal(describeCron('5,10 3-4 2,4 * *'), '5,10 3-4 2,4 * *')
  assert.equal(describeCron('not a cron'), 'not a cron')
})