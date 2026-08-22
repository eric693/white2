// 偷竊紀錄與公告路由。
//
// 前台維持匿名（公告不寫小偷是誰，留給大家互猜），但後台查得到真兇 —— 以前兩者都沒有：
// ranch_steal/aquarium_steal 只存「每人每天偷幾次」的計數，誰偷誰完全沒留下紀錄。
const { db, guildConfig } = require('../db');

/**
 * 寫一筆偷竊紀錄。成功、撲空、被看門動物逮到都記，
 * 只看成功的話會看不出誰在瘋狂嘗試。
 */
function logSteal(o) {
  try {
    db.prepare(`INSERT INTO steal_logs
      (guild_id,kind,thief_id,thief_name,victim_id,victim_name,result,loot,coins,penalty,channel_id)
      VALUES (@guild_id,@kind,@thief_id,@thief_name,@victim_id,@victim_name,@result,@loot,@coins,@penalty,@channel_id)`)
      .run({
        guild_id: o.guildId || '', kind: o.kind || 'ranch',
        thief_id: o.thiefId || '', thief_name: o.thiefName || '',
        victim_id: o.victimId || '', victim_name: o.victimName || '',
        result: o.result || '', loot: o.loot || '',
        coins: o.coins || 0, penalty: o.penalty || 0,
        channel_id: o.channelId || ''
      });
  } catch { /* 紀錄失敗不該擋住遊戲流程 */ }
}

/** 只保留最近 N 天，免得這張表長到無法查詢 */
function pruneStealLogs(days = 30) {
  try {
    db.prepare(`DELETE FROM steal_logs WHERE created_at < datetime('now','localtime',?)`).run(`-${days} days`);
  } catch {}
}

/**
 * 找出公告要發到哪個頻道。
 * 優先用後台設定的固定公告頻道（ranch_config.steal_channel）—— 這個設定一直都存在，
 * 但程式從來沒讀過它，所以公告就散落在小偷剛好下手的那個頻道，被偷的人常常看不到。
 * 沒設定時才退回原本的行為（發在小偷所在頻道）。
 */
async function stealChannel(i, gid) {
  const cfg = guildConfig('ranch_config', gid);
  const want = (cfg.steal_channel || '').trim();
  if (want) {
    const ch = i.guild.channels.cache.get(want) || await i.guild.channels.fetch(want).catch(() => null);
    if (ch) return ch;
  }
  return i.channel || await i.guild.channels.fetch(i.channelId).catch(() => null);
}

module.exports = { logSteal, pruneStealLogs, stealChannel };
